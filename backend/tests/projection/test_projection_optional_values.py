"""Proyección de valores ya certificados por la validación (SRS 5.5.2, RF-009, RF-028)."""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from types import MappingProxyType
from uuid import uuid4

import pytest

from app.ingestion.models import SourceFamily
from app.projection.models import ProjectionError
from app.projection.service import _targets_for
from app.validation.models import ValidatedTabularRecord
from app.validation.records import validate_record_for_family


def _record(family: SourceFamily, values: dict[str, object]) -> ValidatedTabularRecord:
    return ValidatedTabularRecord(uuid4(), family, 1, MappingProxyType(values))


def _target(family: SourceFamily, values: dict[str, object], entity_type: str):
    assert validate_record_for_family(values, family).conforming, "la prueba debe partir de un registro certificado"
    return next(target for target in _targets_for(_record(family, values)) if target.entity_type == entity_type)


CONTRACT = {"ID_Contrato": "C-1", "Fecha_Solicitud": "2026-10-01", "Fecha_Vencimiento": "2026-11-15", "Estado_Revision": "No iniciado"}
OBLIGATION = {"ID_Obligacion": "O-1", "Fecha_Limite": "2026-10-01"}
LITIGATION = {"ID_Litigio": "L-1", "Fecha_Apertura": "2026-10-02", "Estado": "Activo", "Nivel_Severidad": "bajo"}


@pytest.mark.contract
@pytest.mark.parametrize("empty", ["", "   ", None])
def test_contrato_sin_firma_se_proyecta_como_ausencia(empty) -> None:
    target = _target(SourceFamily.CONTRACTS_DOCUMENTS, {**CONTRACT, "Fecha_Firma": empty}, "CONTRATO")
    assert target.values["fecha_firma"] is None


@pytest.mark.contract
@pytest.mark.parametrize("empty", ["", "   ", None])
def test_obligacion_sin_evidencia_se_proyecta_como_null(empty) -> None:
    target = _target(SourceFamily.COMPLIANCE, {**OBLIGATION, "Evidencia_Cumplimiento": empty}, "OBLIGACION")
    assert target.values["evidencia_cumplimiento"] is None


@pytest.mark.contract
def test_evidencia_presente_se_conserva_sin_espacios_externos() -> None:
    target = _target(SourceFamily.COMPLIANCE, {**OBLIGATION, "Evidencia_Cumplimiento": "  Acta firmada  "}, "OBLIGACION")
    assert target.values["evidencia_cumplimiento"] == "Acta firmada"


@pytest.mark.contract
@pytest.mark.parametrize("family,base,field,entity", [
    (SourceFamily.CONTRACTS_DOCUMENTS, CONTRACT, "Fecha_Firma", "CONTRATO"),
    (SourceFamily.COMPLIANCE, OBLIGATION, "Evidencia_Cumplimiento", "OBLIGACION"),
    (SourceFamily.LITIGATION, LITIGATION, "Monto_Reclamado", "LITIGIO"),
])
def test_paridad_csv_xlsx_para_celda_vacia(family, base, field, entity) -> None:
    csv_target = _target(family, {**base, field: ""}, entity)
    xlsx_target = _target(family, {**base, field: None}, entity)
    assert csv_target.payload_sha256 == xlsx_target.payload_sha256


@pytest.mark.robustness
@pytest.mark.parametrize("raw", ["2026-03-15", "2026/03/15", "15/03/2026", " 2026-03-15 ", datetime(2026, 3, 15, 0, 0), date(2026, 3, 15)])
def test_fechas_aceptadas_por_la_validacion_se_proyectan_igual(raw) -> None:
    target = _target(SourceFamily.COMPLIANCE, {**OBLIGATION, "Fecha_Limite": raw}, "OBLIGACION")
    iso = _target(SourceFamily.COMPLIANCE, OBLIGATION | {"Fecha_Limite": "2026-03-15"}, "OBLIGACION")
    assert target.values["fecha_limite"] == date(2026, 3, 15)
    assert target.payload_sha256 == iso.payload_sha256


@pytest.mark.robustness
@pytest.mark.parametrize("raw,expected", [("1,000", Decimal("1000")), (" 2500.50 ", Decimal("2500.50")), (1234.5, Decimal("1234.5")), (500000, Decimal("500000"))])
def test_montos_aceptados_por_la_validacion_se_proyectan(raw, expected) -> None:
    target = _target(SourceFamily.LITIGATION, {**LITIGATION, "Monto_Reclamado": raw}, "LITIGIO")
    assert target.values["monto_reclamado"] == expected


@pytest.mark.robustness
def test_identificador_obligatorio_vacio_sigue_siendo_no_representable() -> None:
    with pytest.raises(ProjectionError):
        _targets_for(_record(SourceFamily.COMPLIANCE, {**OBLIGATION, "ID_Obligacion": "  "}))


@pytest.mark.robustness
def test_identificador_numerico_de_hoja_de_calculo_conserva_paridad_con_csv() -> None:
    xlsx = _target(SourceFamily.COMPLIANCE, {**OBLIGATION, "ID_Obligacion": 1001}, "OBLIGACION")
    csv_ = _target(SourceFamily.COMPLIANCE, {**OBLIGATION, "ID_Obligacion": "1001"}, "OBLIGACION")
    assert xlsx.business_id == csv_.business_id == "1001"
    assert xlsx.payload_sha256 == csv_.payload_sha256


@pytest.mark.robustness
@pytest.mark.parametrize("raw", ["Infinity", "NaN"])
def test_monto_no_finito_se_rechaza_en_validacion(raw) -> None:
    assert not validate_record_for_family({**LITIGATION, "Monto_Reclamado": raw}, SourceFamily.LITIGATION).conforming

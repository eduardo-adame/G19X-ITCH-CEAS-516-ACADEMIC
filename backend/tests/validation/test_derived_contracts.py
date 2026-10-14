"""Validación y proyección de incidentes y asuntos derivados (SRS 5.5.6, 5.5.7, RF-010, RF-012)."""
from __future__ import annotations

from types import MappingProxyType
from uuid import uuid4

import pytest

from app.ingestion.models import SourceFamily
from app.projection.service import _targets_for
from app.validation.models import QuarantineCause, ValidatedTabularRecord
from app.validation.records import validate_record_for_family

OBLIGATION = {"ID_Obligacion": "O-1", "Fecha_Limite": "2026-10-01", "Evidencia_Cumplimiento": ""}
INCIDENT = {"ID_Incidente": "I-1", "Fecha_Evento": "2026-10-05", "Area": "Legal", "Nivel_Severidad": "alto"}
MATTER = {"ID_Asunto": "A-1", "Tipo_Asunto": "Cumplimiento", "Estado": "Abierto", "Fecha": "2026-10-01"}
CONTRACT = {"ID_Contrato": "C-1", "Fecha_Solicitud": "2026-10-01", "Fecha_Vencimiento": "2026-11-15", "Estado_Revision": "No iniciado"}
LITIGATION = {"ID_Litigio": "L-1", "Fecha_Apertura": "2026-10-02", "Estado": "Activo", "Nivel_Severidad": "bajo"}


def _entities(family: SourceFamily, values: dict[str, object]) -> set[str]:
    record = ValidatedTabularRecord(uuid4(), family, 1, MappingProxyType(values))
    return {target.entity_type for target in _targets_for(record)}


@pytest.mark.contract
@pytest.mark.parametrize("change,cause,field", [
    ({"Nivel_Severidad": "critico"}, QuarantineCause.OUT_OF_CATALOG, "Nivel_Severidad"),
    ({"Fecha_Evento": "2026-13-45"}, QuarantineCause.INVALID_DATE, "Fecha_Evento"),
    ({"Area": ""}, QuarantineCause.MISSING_REQUIRED_FIELD, "Area"),
])
def test_incidente_derivado_invalido_va_a_cuarentena_por_fila(change, cause, field) -> None:
    outcome = validate_record_for_family({**OBLIGATION, **INCIDENT, **change}, SourceFamily.COMPLIANCE)
    assert not outcome.conforming
    assert outcome.cause == cause and outcome.field_name == field


@pytest.mark.contract
def test_incidente_parcial_no_se_omite_en_silencio() -> None:
    outcome = validate_record_for_family({**OBLIGATION, "ID_Incidente": "I-2"}, SourceFamily.COMPLIANCE)
    assert not outcome.conforming and outcome.cause == QuarantineCause.MISSING_REQUIRED_FIELD


@pytest.mark.contract
def test_incidente_valido_se_proyecta_con_la_obligacion() -> None:
    values = {**OBLIGATION, **INCIDENT}
    assert validate_record_for_family(values, SourceFamily.COMPLIANCE).conforming
    assert _entities(SourceFamily.COMPLIANCE, values) == {"OBLIGACION", "INCIDENTE"}


@pytest.mark.contract
@pytest.mark.parametrize("family,base", [(SourceFamily.COMPLIANCE, OBLIGATION), (SourceFamily.LITIGATION, LITIGATION), (SourceFamily.CONTRACTS_DOCUMENTS, CONTRACT)])
def test_registro_sin_columnas_derivadas_sigue_siendo_valido(family, base) -> None:
    assert validate_record_for_family(base, family).conforming
    assert len(_entities(family, base)) == 1


@pytest.mark.contract
@pytest.mark.parametrize("family,base,source_entity", [
    (SourceFamily.CONTRACTS_DOCUMENTS, CONTRACT, "CONTRATO"),
    (SourceFamily.LITIGATION, LITIGATION, "LITIGIO"),
    (SourceFamily.COMPLIANCE, OBLIGATION, "OBLIGACION"),
])
@pytest.mark.parametrize("change", [{"Tipo_Asunto": "Otro"}, {"Fecha": "fecha-no-valida"}, {"ID_Asunto": ""}])
def test_asunto_no_normalizable_se_excluye_sin_perder_el_registro_fuente(family, base, source_entity, change) -> None:
    values = {**base, **MATTER, **change}
    assert validate_record_for_family(values, family).conforming
    assert _entities(family, values) == {source_entity}


@pytest.mark.contract
def test_asunto_valido_se_proyecta() -> None:
    values = {**CONTRACT, **MATTER, "Tipo_Asunto": "Contrato"}
    assert _entities(SourceFamily.CONTRACTS_DOCUMENTS, values) == {"CONTRATO", "ASUNTO"}

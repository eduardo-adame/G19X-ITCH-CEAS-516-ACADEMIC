"""Regresiones de la certificación de ingesta y cuarentena.

Libros XLSX con una hoja por conjunto (F-1), reinyección de elementos sin
registro tabular (F-2) y conflictos de identidad que solo admiten descarte (O-1).
"""
from __future__ import annotations

from types import SimpleNamespace
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest

from app.ingestion.models import SourceFamily
from app.main import app
from app.security.api import current_principal
from app.validation.api import reinjection_service_for
from app.validation.models import QuarantineCause, QuarantineState, ValidationInvocationError
from app.validation.quarantine import QuarantineError, QuarantineItem
from app.validation.service import TabularRecord, ValidationService
from tests.validation.test_service import AllowingSecurity, InMemoryValidationRepository, _context, _principal

_INCIDENTS = ("ID_Incidente", "Fecha_Evento", "Area", "Nivel_Severidad")
_MATTERS = ("ID_Asunto", "Tipo_Asunto", "Estado", "Fecha")


def _audit_service():
    repository = InMemoryValidationRepository()
    repository.family = SourceFamily.INTERNAL_AUDIT
    return repository, ValidationService(repository, AllowingSecurity())


def _row(sheet, position, values):
    return TabularRecord(position=position, source_record_id=uuid4(), values_by_name=values, width=len(values), sheet=sheet)


def _two_sheet_records():
    return (
        _row("Incidentes", 2, {"ID_Incidente": "I-1", "Fecha_Evento": "2026-05-01", "Area": "Compras", "Nivel_Severidad": "medio"}),
        _row("Incidentes", 3, {"ID_Incidente": "I-2", "Fecha_Evento": "2026-05-02", "Area": "Ventas", "Nivel_Severidad": "grave"}),
        _row("Asuntos", 2, {"ID_Asunto": "A-1", "Tipo_Asunto": "Contrato", "Estado": "abierto", "Fecha": "2026-05-03"}),
        _row("Asuntos", 3, {"ID_Asunto": "A-2", "Tipo_Asunto": "Penal", "Estado": "abierto", "Fecha": "2026-05-04"}),
    )


def test_srs_required_workbook_with_one_sheet_per_dataset_validates_each_sheet_with_its_headers() -> None:
    repository, service = _audit_service()
    result = service.validate(
        file_id=uuid4(), family=SourceFamily.INTERNAL_AUDIT, headers=_INCIDENTS, records=_two_sheet_records(),
        context=_context(), sheet_headers=(("Incidentes", _INCIDENTS), ("Asuntos", _MATTERS)),
    )
    assert result.structural.conforming
    assert sorted(record.values_by_name.get("ID_Incidente") or record.values_by_name["ID_Asunto"] for record in result.validated_records) == ["A-1", "I-1"]
    assert sorted(item.cause for item in repository.items.values()) == [QuarantineCause.OUT_OF_CATALOG, QuarantineCause.OUT_OF_CATALOG]


def test_srs_required_a_sheet_missing_its_required_columns_rejects_the_whole_workbook() -> None:
    repository, service = _audit_service()
    records = _two_sheet_records()[:2] + (_row("Notas", 2, {"Comentario": "texto"}),)
    result = service.validate(
        file_id=uuid4(), family=SourceFamily.INTERNAL_AUDIT, headers=_INCIDENTS, records=records,
        context=_context(), sheet_headers=(("Incidentes", _INCIDENTS), ("Notas", ("Comentario",))),
    )
    assert result.file_rejected and result.validated_records == () and repository.items == {}
    assert [event["action"] for event in repository.audit_events] == ["VALIDATION_FILE_REJECTED"]


def test_robustness_an_empty_extra_sheet_does_not_reject_the_workbook() -> None:
    repository, service = _audit_service()
    records = _two_sheet_records()[:2]
    result = service.validate(
        file_id=uuid4(), family=SourceFamily.INTERNAL_AUDIT, headers=_INCIDENTS, records=records,
        context=_context(), sheet_headers=(("Incidentes", _INCIDENTS), ("Hoja2", ())),
    )
    assert result.structural.conforming and len(result.validated_records) == 1


def test_robustness_the_same_row_number_in_one_sheet_is_still_a_duplicate_position() -> None:
    _, service = _audit_service()
    first = _two_sheet_records()[0]
    with pytest.raises(ValidationInvocationError):
        service.validate(
            file_id=uuid4(), family=SourceFamily.INTERNAL_AUDIT, headers=_INCIDENTS, records=(first, _row("Incidentes", 2, dict(first.values_by_name))),
            context=_context(), sheet_headers=(("Incidentes", _INCIDENTS), ("Asuntos", _MATTERS)),
        )


def _pending(cause, *, source_record_id):
    return QuarantineItem(
        id=uuid4(), ingest_file_id=uuid4(), source_record_id=source_record_id, cause=cause,
        state=QuarantineState.PENDIENTE, operation_id=uuid4(), correlation_id=uuid4(),
        original_payload={"id_contrato": "C-1", "estado_revision": "En revisión"},
        candidate_payload={"ID_Contrato": "C-1", "Estado_Revision": "Renovado"},
    )


@pytest.mark.parametrize(("cause", "has_record"), [
    (QuarantineCause.BINARY_CONTENT, False),
    (QuarantineCause.IDENTITY_CONFLICT, True),
])
def test_srs_required_file_items_and_identity_conflicts_are_not_reinjectable(cause, has_record) -> None:
    repository = InMemoryValidationRepository()
    service = ValidationService(repository, AllowingSecurity())
    item = _pending(cause, source_record_id=uuid4() if has_record else None)
    repository.items[item.id] = item
    with pytest.raises(QuarantineError):
        service.reinject(item_id=item.id, corrected_payload={"ID_Contrato": "C-1", "Estado_Revision": "Renovado"}, context=_context())
    assert repository.items[item.id] == item and repository.transitions == []
    assert not [event for event in repository.audit_events if event["action"] == "QUARANTINE_REINJECT"]


def test_srs_required_an_identity_conflict_can_still_be_discarded_with_justification() -> None:
    repository = InMemoryValidationRepository()
    service = ValidationService(repository, AllowingSecurity())
    item = _pending(QuarantineCause.IDENTITY_CONFLICT, source_record_id=uuid4())
    repository.items[item.id] = item
    discarded = service.discard(item_id=item.id, justification="El dato vigente es el correcto.", context=_context())
    assert discarded.state == QuarantineState.DESCARTADO and discarded.original_payload == item.original_payload


class _SecurityAllowing:
    def require_functional_permission(self, _principal, capability: str) -> None:
        assert capability == "quarantine.reinject"


@pytest.mark.parametrize("error", [QuarantineError("conflicto"), ValidationInvocationError("procedencia")])
def test_robustness_unreinjectable_items_answer_409_instead_of_an_internal_error(error) -> None:
    class Integration:
        def reinject(self, **_kwargs):
            raise error

    app.state.security_service = _SecurityAllowing()
    app.dependency_overrides[current_principal] = lambda: _principal()
    app.dependency_overrides[reinjection_service_for] = lambda: (Integration(), SimpleNamespace())
    try:
        response = TestClient(app).patch(f"/api/validation/quarantine/{uuid4()}/reinject", json={"corrected_payload": {"ID_Litigio": "L-9"}})
        assert response.status_code == 409
        assert response.json() == {"detail": "La reinyección no puede confirmarse"}
    finally:
        app.dependency_overrides.clear()
        del app.state.security_service

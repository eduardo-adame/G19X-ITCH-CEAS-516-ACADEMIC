"""Fecha del documento declarada en la carga manual (RF-023, RF-025, RF-061)."""
from __future__ import annotations

from datetime import date
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.ingestion.models import IngestionResult, RejectedFileError, RoutingTarget, SourceFamily
from app.main import app
from app.security.models import AuthenticatedPrincipal


class _Security:
    def __init__(self, principal) -> None:
        self.principal = principal

    def authenticated_principal(self, token):
        return self.principal

    def require_functional_permission(self, principal, capability):
        return principal


class _Ingestion:
    def __init__(self, reject: bool = False) -> None:
        self.calls: list[dict] = []
        self.reject = reject

    def ingest_stream(self, stream, **kwargs) -> IngestionResult:
        self.calls.append(kwargs)
        if self.reject:
            raise RejectedFileError("DOCUMENT_DATE_NOT_APPLICABLE")
        return IngestionResult(uuid4(), uuid4(), uuid4(), "COMPLETADO", "PDF", SourceFamily.CONTRACTS_DOCUMENTS,
                               RoutingTarget.DOCUMENT, None, document_date=kwargs.get("document_date"))


@pytest.fixture
def harness():
    principal = AuthenticatedPrincipal(uuid4(), uuid4(), "analista", 1, frozenset({"ANALISTA"}), frozenset({"ingest.upload"}))
    ingestion = _Ingestion()
    app.state.security_service = _Security(principal)
    app.state.ingestion_service = ingestion
    yield ingestion
    del app.state.security_service
    del app.state.ingestion_service


def _upload(data):
    with TestClient(app) as client:
        return client.post(
            "/api/ingestion/uploads",
            files={"file": ("contrato.pdf", b"%PDF-1.4", "application/pdf")},
            data={"controlled_location": "contracts-documents", **data},
            headers={"Authorization": "Bearer valid", "Idempotency-Key": str(uuid4())},
        )


@pytest.mark.contract
def test_fecha_valida_se_entrega_al_caso_de_uso_y_se_devuelve(harness) -> None:
    response = _upload({"document_date": "2026-10-06"})
    assert response.status_code == 201
    assert harness.calls[0]["document_date"] == date(2026, 10, 6)
    assert response.json()["document_date"] == "2026-10-06"


@pytest.mark.contract
@pytest.mark.parametrize("data", [{}, {"document_date": ""}])
def test_fecha_omitida_no_se_infiere(harness, data) -> None:
    response = _upload(data)
    assert response.status_code == 201
    assert harness.calls[0]["document_date"] is None
    assert response.json()["document_date"] is None


@pytest.mark.contract
@pytest.mark.parametrize("value", ["06/10/2026", "20261006", "2026-13-01", "2026-02-30", "2026-10-06T00:00:00", "hoy"])
def test_fecha_invalida_responde_422_sin_ingerir(harness, value) -> None:
    response = _upload({"document_date": value})
    assert response.status_code == 422
    assert harness.calls == []


@pytest.mark.contract
def test_fecha_en_archivo_tabular_responde_422(harness) -> None:
    harness.reject = True
    assert _upload({"document_date": "2026-10-06"}).status_code == 422

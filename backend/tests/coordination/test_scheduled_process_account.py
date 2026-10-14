"""Operaciones programadas: permiso aplicable + cuenta de proceso configurada (F-01, P-B)."""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import app
from app.security.api import current_principal
from app.security.models import AuthenticatedPrincipal, AuthorizationError, ROLE_PERMISSIONS


class _Repository:
    def __init__(self) -> None:
        self.audit: list[dict] = []

    @contextmanager
    def transaction(self):
        yield object()

    def write_audit_event(self, _connection, **event) -> None:
        self.audit.append(event)


class _Security:
    def __init__(self) -> None:
        self.repository = _Repository()

    def require_functional_permission(self, principal, capability, correlation_id=None):
        if capability not in principal.permissions:
            raise AuthorizationError("Acceso no autorizado")


@dataclass
class _Outcome:
    job_id: object
    operation_id: object
    state: str = "COMPLETED"


class _Integration:
    def __init__(self) -> None:
        self.calls = 0

    def schedule(self, **_kwargs):
        self.calls += 1
        return _Outcome(uuid4(), uuid4())


def _principal(username: str, role: str) -> AuthenticatedPrincipal:
    return AuthenticatedPrincipal(uuid4(), uuid4(), username, 1, frozenset({role}), ROLE_PERMISSIONS[role])


@pytest.fixture
def harness():
    security, integration = _Security(), _Integration()
    app.state.security_service = security
    app.state.security_settings = Settings(scheduled_process_accounts="airflow-ingestion")
    app.state.kpi_integration_service = integration
    app.state.proactive_integration_service = integration
    yield security, integration
    for name in ("security_service", "security_settings", "kpi_integration_service", "proactive_integration_service"):
        if hasattr(app.state, name):
            delattr(app.state, name)
    app.dependency_overrides.clear()


def _window() -> dict[str, str]:
    start = (datetime.now(UTC) - timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    return {"data_interval_start": start.isoformat(), "data_interval_end": (start + timedelta(days=1)).isoformat()}


PATHS = ["/api/coordination/kpi-recalculations/scheduled", "/api/coordination/proactive-analysis/scheduled"]


@pytest.mark.contract
@pytest.mark.parametrize("path", PATHS)
def test_analista_humano_con_permiso_recibe_403_y_se_audita(harness, path) -> None:
    security, integration = harness
    app.dependency_overrides[current_principal] = lambda: _principal("analista-humano", "ANALISTA")
    response = TestClient(app).post(path, json=_window())
    assert response.status_code == 403
    assert integration.calls == 0
    assert security.repository.audit[-1]["safe_cause_code"] == "NOT_PROCESS_ACCOUNT"


@pytest.mark.contract
@pytest.mark.parametrize("path", PATHS)
def test_cuenta_de_proceso_configurada_con_permiso_puede_ejecutar(harness, path) -> None:
    _security, integration = harness
    app.dependency_overrides[current_principal] = lambda: _principal("airflow-ingestion", "ANALISTA")
    response = TestClient(app).post(path, json=_window())
    assert response.status_code == 200 and integration.calls == 1


@pytest.mark.contract
@pytest.mark.parametrize("path", PATHS)
def test_ti_no_incluida_en_la_lista_recibe_403(harness, path) -> None:
    app.dependency_overrides[current_principal] = lambda: _principal("ti-humano", "TI")
    assert TestClient(app).post(path, json=_window()).status_code == 403


@pytest.mark.contract
@pytest.mark.parametrize("path", PATHS)
def test_cuenta_de_proceso_sin_permiso_base_recibe_403(harness, path) -> None:
    app.dependency_overrides[current_principal] = lambda: _principal("airflow-ingestion", "JURIDICO")
    assert TestClient(app).post(path, json=_window()).status_code == 403


@pytest.mark.contract
@pytest.mark.parametrize("path", PATHS)
def test_lista_vacia_deniega_por_defecto(harness, path) -> None:
    app.state.security_settings = Settings(scheduled_process_accounts="")
    app.dependency_overrides[current_principal] = lambda: _principal("airflow-ingestion", "ANALISTA")
    assert TestClient(app).post(path, json=_window()).status_code == 403


@pytest.mark.contract
def test_configuracion_central_normaliza_la_lista() -> None:
    assert Settings(scheduled_process_accounts=" airflow-ingestion , otra-cuenta ,").scheduled_process_account_set == frozenset({"airflow-ingestion", "otra-cuenta"})
    assert Settings(scheduled_process_accounts="").scheduled_process_account_set == frozenset()

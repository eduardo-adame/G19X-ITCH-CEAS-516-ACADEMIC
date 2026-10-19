"""Pruebas de protección de la frontera HTTP."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.security.models import AuditPersistenceError, AuthenticationError


@pytest.fixture()
def client() -> TestClient:
    return TestClient(app)


@pytest.mark.contract
def test_protected_endpoints_reject_direct_calls_without_credentials(client: TestClient) -> None:
    responses = (
        client.get("/api/auth/me"),
        client.post("/api/auth/logout"),
        client.post("/api/security/users", json={"username": "new", "display_name": "Nuevo", "password": "contraseña válida 123", "roles": ["TI"]}),
    )
    for response in responses:
        assert response.status_code == 401
        assert response.json()["detail"] == "Credenciales o sesión no válidas"


@pytest.mark.contract
def test_public_health_remains_available(client: TestClient) -> None:
    assert client.get("/health").status_code == 200


class _UnavailableSecurity:
    """La persistencia no responde: cada operación de identidad falla al confirmar."""

    def authenticated_principal(self, token):
        raise AuditPersistenceError("La operación no pudo confirmarse")

    def login(self, username, password):
        raise AuditPersistenceError("La operación no pudo confirmarse")

    def refresh(self, token):
        raise AuditPersistenceError("La operación no pudo confirmarse")


class _InvalidSecurity(_UnavailableSecurity):
    def authenticated_principal(self, token):
        raise AuthenticationError("Credenciales o sesión no válidas")


@pytest.mark.contract
def test_identity_persistence_failure_is_unavailable_not_invalid_session(client: TestClient, monkeypatch) -> None:
    # Una caída de la base de datos deniega igual, pero con 503: el cliente no debe tratarla como sesión inválida.
    monkeypatch.setattr(app.state, "security_service", _UnavailableSecurity(), raising=False)
    client.cookies.set("riesgo_legal_refresh", "token-sintetico", path="/api/auth")
    responses = (
        client.get("/api/auth/me", headers={"Authorization": "Bearer token-sintetico"}),
        client.get("/api/dashboard/analysis", headers={"Authorization": "Bearer token-sintetico"}),
        client.post("/api/auth/login", json={"username": "ana", "password": "contraseña válida 123"}),
        client.post("/api/auth/refresh"),
    )
    for response in responses:
        assert response.status_code == 503
        assert response.json()["detail"] == "Servicio no disponible temporalmente"


@pytest.mark.contract
def test_invalid_session_still_answers_401(client: TestClient, monkeypatch) -> None:
    monkeypatch.setattr(app.state, "security_service", _InvalidSecurity(), raising=False)
    response = client.get("/api/auth/me", headers={"Authorization": "Bearer token-sintetico"})
    assert response.status_code == 401
    assert response.json()["detail"] == "Credenciales o sesión no válidas"

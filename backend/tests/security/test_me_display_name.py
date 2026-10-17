"""Contrato de /api/auth/me con el nombre asignado a la cuenta (solo presentación)."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.security.api import router
from app.security.models import AuthenticatedPrincipal, AuthenticationError
from app.security.repository import SecurityRepository


class SecurityStub:
    def __init__(self, principal: AuthenticatedPrincipal) -> None:
        self.principal = principal

    def authenticated_principal(self, token: str) -> AuthenticatedPrincipal:
        if token != "token-sintetico":
            raise AuthenticationError("No válido")
        return self.principal


def client(principal: AuthenticatedPrincipal) -> TestClient:
    app = FastAPI()
    app.include_router(router)
    app.state.security_service = SecurityStub(principal)
    return TestClient(app)


@pytest.mark.contract
def test_me_returns_display_name_together_with_username() -> None:
    account = uuid4()
    principal = AuthenticatedPrincipal(account, uuid4(), "analista.norte", 3, frozenset({"ANALISTA", "JURIDICO"}), frozenset({"dashboard.read"}), "Ana Martínez")
    response = client(principal).get("/api/auth/me", headers={"Authorization": "Bearer token-sintetico"})
    assert response.status_code == 200
    assert response.json() == {"id": str(account), "username": "analista.norte", "display_name": "Ana Martínez", "roles": ["ANALISTA", "JURIDICO"]}


@pytest.mark.contract
def test_me_falls_back_to_username_when_identity_has_no_display_name() -> None:
    principal = AuthenticatedPrincipal(uuid4(), uuid4(), "cuenta.sin.nombre", 1, frozenset({"TI"}), frozenset())
    response = client(principal).get("/api/auth/me", headers={"Authorization": "Bearer token-sintetico"})
    assert response.status_code == 200
    assert response.json()["display_name"] == "cuenta.sin.nombre"


@pytest.mark.contract
def test_me_still_requires_credentials_and_exposes_no_permissions() -> None:
    principal = AuthenticatedPrincipal(uuid4(), uuid4(), "u", 1, frozenset({"TI"}), frozenset({"user.create"}), "Nombre")
    connection = client(principal)
    assert connection.get("/api/auth/me").status_code == 401
    body = connection.get("/api/auth/me", headers={"Authorization": "Bearer token-sintetico"}).json()
    assert set(body) == {"id", "username", "display_name", "roles"}


class _Cursor:
    def __init__(self, rows: list[list[dict]]) -> None:
        self.rows, self.queries = rows, []

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def execute(self, query, params=None) -> None:
        self.queries.append(query)

    def fetchone(self):
        return self.rows.pop(0)

    def fetchall(self):
        return self.rows.pop(0)


class _Connection:
    def __init__(self, cursor: _Cursor) -> None:
        self._cursor = cursor

    def cursor(self):
        return self._cursor


def test_principal_for_session_reads_current_display_name() -> None:
    account, session = uuid4(), uuid4()
    session_row = {"id": account, "username": "juridico.sur", "display_name": "Luis Pérez", "state": "ACTIVE", "authorization_version": 2,
                   "session_state": "ACTIVE", "expires_at": datetime.now(UTC) + timedelta(hours=1), "session_authorization_version": 2}
    cursor = _Cursor([session_row, [{"role_id": "JURIDICO", "permission_id": "dashboard.read"}]])
    principal = SecurityRepository("postgresql://sin-conexion").principal_for_session(_Connection(cursor), account, session, 2)
    assert principal is not None and principal.display_name == "Luis Pérez" and principal.username == "juridico.sur"
    assert "u.display_name" in cursor.queries[0]

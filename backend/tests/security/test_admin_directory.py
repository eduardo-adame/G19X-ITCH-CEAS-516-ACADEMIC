"""SRS_REQUIRED (RF-068, RF-082, SRS 0.26): consultas administrativas de solo lectura."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.security.directory import AccountQuery, ExceptionQuery
from app.security.models import AuthorizationError
from app.security.repository import SecurityRepository
from tests.security.test_security_functional_flows import MemorySecurityRepository, make_service

PASSWORD = "contraseña válida 123"


class DirectoryRepository(MemorySecurityRepository):
    """Equivalente en memoria de las consultas SQL (mismo orden y filtros)."""

    def __init__(self) -> None:
        super().__init__()
        self.exception_rows: list[dict[str, object]] = []
        self.scope_rows: list[dict[str, object]] = []

    def list_accounts(self, connection, *, q, state, role, after, limit):
        rows = []
        for account_id, account in sorted(self.accounts.items(), key=lambda item: item[1]["username"]):
            text = f"{account['username']} {account['display_name']}".lower()
            if q and q.lower() not in text or state and account["state"] != state or role and role not in self.roles[account_id] or after is not None and account["username"] <= after:
                continue
            rows.append({"id": account_id, "username": account["username"], "display_name": account["display_name"], "state": account["state"],
                         "roles": sorted(self.roles[account_id]), "created_at": datetime(2026, 1, 1, tzinfo=UTC), "disabled_at": None,
                         "password_hash": account["password_hash"]})
        return rows[:limit]

    def list_scope_grants(self, connection):
        return list(self.scope_rows)

    def list_document_exceptions(self, connection, *, subject, account_id, role_id, document_id, after, limit):
        rows = sorted(self.exception_rows, key=lambda row: (row["created_at"], row["id"]), reverse=True)
        rows = [row for row in rows if (subject is None or row["subject_type"] == subject) and (account_id is None or row["account_id"] == account_id)
                and (role_id is None or row["role_id"] == role_id) and (document_id is None or row["document_id"] == document_id)
                and (after is None or (row["created_at"], row["id"]) < after)]
        return rows[:limit]


@pytest.fixture()
def directory(monkeypatch):
    repository = DirectoryRepository()
    service = make_service(repository)
    monkeypatch.setattr(app.state, "security_service", service, raising=False)

    def sign_in(username: str, roles: frozenset[str]):
        account_id = repository.add_account(username, roles=roles)
        repository.accounts[account_id]["password_hash"] = service.passwords.hash(PASSWORD)
        access, _ = service.login(username, PASSWORD)
        return account_id, service.authenticated_principal(access), {"Authorization": f"Bearer {access}"}

    return repository, service, sign_in


def actions(repository):
    return [event["action"] for event in repository.audit]


def test_ti_lists_accounts_without_credentials_and_audits_without_the_search_text(directory):
    repository, service, sign_in = directory
    _, ti, _ = sign_in("ti-admin", frozenset({"TI"}))
    repository.add_account("ana.martinez", roles=frozenset({"ANALISTA", "JURIDICO"}))
    page = service.list_accounts(ti, AccountQuery(q="MARTINEZ"))
    assert [item.username for item in page.items] == ["ana.martinez"]
    item = page.items[0].model_dump()
    assert set(item) == {"id", "username", "display_name", "state", "roles", "created_at", "disabled_at"}
    assert item["roles"] == ["ANALISTA", "JURIDICO"] and page.next_cursor is None
    event = repository.audit[-1]
    assert event["action"] == "ACCOUNT_LIST" and event["result"] == "SUCCESS" and event["resource_identifier"] is None
    assert "MARTINEZ" not in str(event).upper()


@pytest.mark.parametrize("roles", [frozenset({"JURIDICO"}), frozenset({"ANALISTA"})])
def test_non_ti_roles_are_denied_and_the_denial_is_audited(directory, roles):
    repository, service, sign_in = directory
    _, principal, _ = sign_in("sin-permiso", roles)
    with pytest.raises(AuthorizationError):
        service.list_accounts(principal, AccountQuery())
    with pytest.raises(AuthorizationError):
        service.list_scope_grants(principal)
    with pytest.raises(AuthorizationError):
        service.list_document_exceptions(principal, ExceptionQuery())
    assert actions(repository)[-3:] == ["AUTHORIZATION_DENIED"] * 3
    assert "ACCOUNT_LIST" not in actions(repository)


def test_current_authorization_prevails_over_the_token(directory):
    repository, service, sign_in = directory
    account_id, ti, _ = sign_in("ti-revocado", frozenset({"TI"}))
    repository.roles[account_id] = frozenset({"JURIDICO"})
    with pytest.raises(AuthorizationError):
        service.list_accounts(ti, AccountQuery())
    assert actions(repository)[-1] == "AUTHORIZATION_DENIED"


def test_pagination_cursor_is_bound_to_identity_and_filters(directory):
    repository, service, sign_in = directory
    _, ti, _ = sign_in("a-ti", frozenset({"TI"}))
    for name in ("b-uno", "c-dos", "d-tres"):
        repository.add_account(name, roles=frozenset({"JURIDICO"}))
    first = service.list_accounts(ti, AccountQuery(limit=2))
    assert [item.username for item in first.items] == ["a-ti", "b-uno"] and first.next_cursor
    second = service.list_accounts(ti, AccountQuery(limit=2, cursor=first.next_cursor))
    assert [item.username for item in second.items] == ["c-dos", "d-tres"] and second.next_cursor is None
    with pytest.raises(ValueError):
        service.list_accounts(ti, AccountQuery(limit=2, cursor=first.next_cursor, role="TI"))
    with pytest.raises(ValueError):
        service.list_accounts(ti, AccountQuery(limit=2, cursor=first.next_cursor[:-2] + "xx"))


def test_state_and_role_filters(directory):
    repository, service, sign_in = directory
    _, ti, _ = sign_in("ti", frozenset({"TI"}))
    repository.add_account("deshabilitada", roles=frozenset({"ANALISTA"}), state="DISABLED")
    assert [item.username for item in service.list_accounts(ti, AccountQuery(state="DISABLED")).items] == ["deshabilitada"]
    assert [item.username for item in service.list_accounts(ti, AccountQuery(role="TI")).items] == ["ti"]


def test_scope_grants_and_active_exceptions_are_listed_and_audited(directory):
    repository, service, sign_in = directory
    _, ti, _ = sign_in("ti", frozenset({"TI"}))
    repository.scope_rows = [{"role_id": "JURIDICO", "source_family": "LITIGIOS", "active": True}]
    assert service.list_scope_grants(ti).model_dump() == {"items": [{"role_id": "JURIDICO", "source_family": "LITIGIOS", "active": True}]}
    assert actions(repository)[-1] == "DOCUMENT_SCOPE_LIST"
    user_id = uuid4(); base = datetime(2026, 10, 1, tzinfo=UTC)
    repository.exception_rows = [
        {"id": uuid4(), "subject_type": "USER", "account_id": user_id, "username": "ana", "display_name": "Ana", "role_id": None, "document_id": "DOC-1", "decision": "DENY", "created_at": base},
        {"id": uuid4(), "subject_type": "ROLE", "account_id": None, "username": None, "display_name": None, "role_id": "ANALISTA", "document_id": "DOC-2", "decision": "ALLOW", "created_at": base + timedelta(days=1)},
    ]
    first = service.list_document_exceptions(ti, ExceptionQuery(limit=1))
    assert [item.document_id for item in first.items] == ["DOC-2"] and first.next_cursor
    second = service.list_document_exceptions(ti, ExceptionQuery(limit=1, cursor=first.next_cursor))
    assert [item.document_id for item in second.items] == ["DOC-1"] and second.next_cursor is None
    assert [item.document_id for item in service.list_document_exceptions(ti, ExceptionQuery(subject="USER")).items] == ["DOC-1"]
    assert actions(repository)[-1] == "DOCUMENT_EXCEPTION_LIST"


def test_http_contract_authentication_permissions_and_sanitized_errors(directory):
    repository, _, sign_in = directory
    _, _, ti = sign_in("ti", frozenset({"TI"}))
    _, _, juridico = sign_in("juridico", frozenset({"JURIDICO"}))
    with TestClient(app) as client:
        for path in ("/api/security/users", "/api/security/document-scopes", "/api/security/document-exceptions"):
            assert client.get(path).status_code == 401
            assert client.get(path, headers=juridico).status_code == 403
            response = client.get(path, headers=ti)
            assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
        too_long = client.get("/api/security/users", headers=ti, params={"q": "secreto-" * 20})
        assert too_long.status_code == 422 and too_long.json() == {"detail": "Parámetros no válidos"} and "secreto" not in too_long.text
        assert client.get("/api/security/users", headers=ti, params={"state": "BORRADA"}).status_code == 422
        assert client.get("/api/security/users", headers=ti, params={"cursor": "manipulado"}).status_code == 422
        listed = client.get("/api/security/users", headers=ti).json()
    assert "password_hash" not in str(listed) and "authorization_version" not in str(listed)
    assert {item["username"] for item in listed["items"]} == {"ti", "juridico"}


class FakeCursor:
    def __init__(self, sink):
        self.sink = sink

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def execute(self, statement, parameters=()):
        self.sink.append((statement, parameters))

    def fetchall(self):
        return []


class FakeConnection:
    def __init__(self):
        self.statements = []

    def cursor(self, **_):
        return FakeCursor(self.statements)


def test_account_sql_escapes_the_search_and_never_selects_credentials():
    connection = FakeConnection()
    SecurityRepository.list_accounts(connection, q="50%_a\\b", state="ACTIVE", role="TI", after="m", limit=26)
    statement, parameters = connection.statements[0]
    assert "password_hash" not in statement and "authorization_version" not in statement and "access_session" not in statement
    assert statement.count("ESCAPE '\\'") == 2 and "ORDER BY u.username" in statement
    assert parameters == ("%50\\%\\_a\\\\b%", "%50\\%\\_a\\\\b%", "ACTIVE", "TI", "m", 26)


def test_exception_sql_lists_only_active_rows_without_document_names():
    connection = FakeConnection()
    SecurityRepository.list_document_exceptions(connection, subject="ROLE", account_id=None, role_id="ANALISTA", document_id="DOC-1", after=None, limit=26)
    statement, parameters = connection.statements[0]
    assert "WHERE e.active" in statement and "e.role_id IS NOT NULL" in statement
    assert "app.document " not in statement and "document_name" not in statement
    assert parameters == ("ANALISTA", "DOC-1", 26)


# ------------------------------------------------------------------ Códigos de error de administración (O-2)
class EditableRepository(DirectoryRepository):
    def update_account(self, connection, account_id, display_name):
        if account_id not in self.accounts:
            return False
        self.accounts[account_id]["display_name"] = display_name
        return True


@pytest.fixture()
def editable(monkeypatch):
    repository = EditableRepository()
    service = make_service(repository)
    monkeypatch.setattr(app.state, "security_service", service, raising=False)

    def sign_in(username, roles):
        account_id = repository.add_account(username, roles=roles)
        repository.accounts[account_id]["password_hash"] = service.passwords.hash(PASSWORD)
        access, _ = service.login(username, PASSWORD)
        return account_id, {"Authorization": f"Bearer {access}"}

    return repository, sign_in


def test_disabling_the_last_active_ti_is_409_with_its_reason_and_changes_nothing(editable):
    repository, sign_in = editable
    ti_id, ti = sign_in("ti-unica", frozenset({"TI"}))
    with TestClient(app) as client:
        response = client.post(f"/api/security/users/{ti_id}/disable", headers=ti)
    assert response.status_code == 409
    assert response.json() == {"detail": "La operación dejaría el sistema sin ninguna cuenta TI activa."}
    assert repository.accounts[ti_id]["state"] == "ACTIVE"
    assert "ACCOUNT_DISABLE" not in actions(repository)


def test_invalid_account_data_is_422_while_unknown_accounts_stay_403(editable):
    repository, sign_in = editable
    _, ti = sign_in("ti-admin", frozenset({"TI"}))
    target = repository.add_account("objetivo", roles=frozenset({"JURIDICO"}))
    with TestClient(app) as client:
        blank = client.patch(f"/api/security/users/{target}", headers=ti, json={"display_name": "   "})
        unknown_role = client.put(f"/api/security/users/{target}/roles", headers=ti, json={"roles": ["ADMIN"]})
        missing = client.patch(f"/api/security/users/{uuid4()}", headers=ti, json={"display_name": "Nadie"})
        renamed = client.patch(f"/api/security/users/{target}", headers=ti, json={"display_name": "Nombre nuevo"})
    assert blank.status_code == 422 and blank.json() == {"detail": "Datos de cuenta no válidos"}
    assert unknown_role.status_code == 422 and repository.roles[target] == frozenset({"JURIDICO"})
    # Una cuenta inexistente no se distingue de una sin permiso: no se revela si existe.
    assert missing.status_code == 403 and missing.json() == {"detail": "Acceso no autorizado"}
    assert renamed.status_code == 204 and repository.accounts[target]["display_name"] == "Nombre nuevo"


def test_changing_own_roles_is_still_403(editable):
    _, sign_in = editable
    ti_id, ti = sign_in("ti-admin", frozenset({"TI"}))
    with TestClient(app) as client:
        response = client.put(f"/api/security/users/{ti_id}/roles", headers=ti, json={"roles": ["TI", "JURIDICO"]})
    assert response.status_code == 403


def test_unconfirmed_audit_is_503_not_403(editable, monkeypatch):
    repository, sign_in = editable
    _, ti = sign_in("ti-admin", frozenset({"TI"}))
    target = repository.add_account("objetivo", roles=frozenset({"JURIDICO"}))
    from app.security.models import AuditPersistenceError

    def fail(connection, **event):
        if event["action"] == "ACCOUNT_UPDATE":
            raise AuditPersistenceError("no confirmada")
        repository.audit.append(event)

    monkeypatch.setattr(repository, "write_audit_event", fail)
    with TestClient(app) as client:
        response = client.patch(f"/api/security/users/{target}", headers=ti, json={"display_name": "Nombre nuevo"})
    assert response.status_code == 503 and response.json() == {"detail": "Operación no confirmada"}

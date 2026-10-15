"""F-10 y F-21: errores controlados de administración y superficie expuesta mínima."""
from __future__ import annotations

import importlib

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError as SettingsValidationError

from app.config import Settings, get_settings
from app.main import app, documentation_urls
from app.security.api import ACCOUNT_CONFLICT_DETAIL
from app.security.models import AccountConflictError
from tests.security.test_security_functional_flows import MemorySecurityRepository, make_service

PASSWORD = "contraseña válida 123"


class UniqueUsernameRepository(MemorySecurityRepository):
    """Repositorio en memoria con la misma unicidad de nombre de usuario que la BD."""

    def create_account(self, connection, *, username, display_name, password_hash):
        if any(account["username"] == username for account in self.accounts.values()):
            raise AccountConflictError("La cuenta entra en conflicto con un registro existente")
        return super().create_account(connection, username=username, display_name=display_name, password_hash=password_hash)


@pytest.fixture()
def security(monkeypatch):
    repository = UniqueUsernameRepository()
    service = make_service(repository)
    monkeypatch.setattr(app.state, "security_service", service, raising=False)

    def headers(username: str, roles: frozenset[str]) -> dict[str, str]:
        account_id = repository.add_account(username, roles=roles)
        repository.accounts[account_id]["password_hash"] = service.passwords.hash(PASSWORD)
        access, _refresh = service.login(username, PASSWORD)
        return {"Authorization": f"Bearer {access}"}

    return repository, headers


def _create(client, headers, username="nueva-cuenta"):
    return client.post("/api/security/users", headers=headers,
                       json={"username": username, "display_name": "Cuenta nueva", "password": PASSWORD, "roles": ["JURIDICO"]})


# --- F-10 ----------------------------------------------------------------------

@pytest.mark.contract
def test_duplicate_username_is_409_generic_without_partial_account_or_success_audit(security) -> None:
    repository, headers = security
    ti = headers("ti-admin", frozenset({"TI"}))
    with TestClient(app) as client:
        created = _create(client, ti)
        audit_after_first = len(repository.audit)
        duplicate = _create(client, ti)
    assert created.status_code == 201
    assert duplicate.status_code == 409
    assert duplicate.json() == {"detail": ACCOUNT_CONFLICT_DETAIL}
    # El mensaje no confirma qué dato existe ni expone la restricción interna.
    assert "nueva-cuenta" not in duplicate.text and "uq_user_account_username" not in duplicate.text
    assert [account["username"] for account in repository.accounts.values()].count("nueva-cuenta") == 1
    assert [event["action"] for event in repository.audit].count("ACCOUNT_CREATE") == 1
    assert all(event["action"] != "ACCOUNT_CREATE" for event in repository.audit[audit_after_first:])


@pytest.mark.contract
def test_valid_account_creation_is_unchanged_and_audited(security) -> None:
    repository, headers = security
    ti = headers("ti-admin", frozenset({"TI"}))
    with TestClient(app) as client:
        response = _create(client, ti, username="otra-cuenta")
    assert response.status_code == 201 and set(response.json()) == {"id"}
    event = next(event for event in repository.audit if event["action"] == "ACCOUNT_CREATE")
    assert event["result"] == "SUCCESS" and event["resource_identifier"] == response.json()["id"]


@pytest.mark.contract
def test_unauthorized_actor_gets_403_before_any_conflict_check(security) -> None:
    repository, headers = security
    headers("ti-admin", frozenset({"TI"}))
    analyst = headers("analista", frozenset({"ANALISTA"}))
    with TestClient(app) as client:
        response = _create(client, analyst, username="ti-admin")
    assert response.status_code == 403
    assert any(event["action"] == "AUTHORIZATION_DENIED" for event in repository.audit)


@pytest.mark.contract
@pytest.mark.parametrize("path", ["/api/security/document-exceptions/role/JURIDICO/doc-1",
                                  "/api/security/document-exceptions/user/00000000-0000-4000-8000-000000000001/doc-1"])
def test_invalid_document_decision_is_422_without_mutation(security, path) -> None:
    repository, headers = security
    ti = headers("ti-admin", frozenset({"TI"}))
    with TestClient(app) as client:
        response = client.put(path, headers=ti, json={"decision": "MAYBE", "active": True})
    assert response.status_code == 422
    assert repository.exceptions == {}
    assert all(event["action"] != "DOCUMENT_EXCEPTION" for event in repository.audit)


@pytest.mark.contract
def test_unknown_role_in_document_exception_is_422(security) -> None:
    repository, headers = security
    ti = headers("ti-admin", frozenset({"TI"}))
    with TestClient(app) as client:
        response = client.put("/api/security/document-exceptions/role/NO_EXISTE/doc-1", headers=ti,
                              json={"decision": "DENY", "active": True})
    assert response.status_code == 422 and response.json() == {"detail": "Excepción documental no válida"}
    assert repository.exceptions == {}


@pytest.mark.contract
def test_invalid_decision_from_unauthorized_actor_is_still_403(security) -> None:
    _repository, headers = security
    analyst = headers("analista", frozenset({"ANALISTA"}))
    with TestClient(app) as client:
        response = client.put("/api/security/document-exceptions/role/JURIDICO/doc-1", headers=analyst,
                              json={"decision": "MAYBE", "active": True})
    assert response.status_code == 403


# --- F-21: documentación interactiva ----------------------------------------------

@pytest.mark.contract
def test_default_runtime_does_not_publish_interactive_documentation() -> None:
    with TestClient(app) as client:
        for path in ("/docs", "/redoc", "/openapi.json"):
            assert client.get(path).status_code == 404
        assert client.get("/health").status_code == 200


@pytest.mark.contract
def test_documentation_flag_is_explicit_and_independent_of_environment() -> None:
    assert Settings(_env_file=None).api_docs_enabled is False
    assert Settings(_env_file=None, environment="development").api_docs_enabled is False
    assert documentation_urls(False) == {"docs_url": None, "redoc_url": None, "openapi_url": None}
    assert documentation_urls(True) == {"docs_url": "/docs", "redoc_url": "/redoc", "openapi_url": "/openapi.json"}
    with pytest.raises(SettingsValidationError):
        Settings(_env_file=None, api_docs_enabled="quizas")


@pytest.mark.contract
def test_documentation_is_published_only_with_explicit_flag(monkeypatch) -> None:
    import app.main as main_module

    monkeypatch.setenv("API_DOCS_ENABLED", "true")
    get_settings.cache_clear()
    try:
        enabled = importlib.reload(main_module)
        with TestClient(enabled.app) as client:
            assert client.get("/docs").status_code == 200
            assert client.get("/redoc").status_code == 200
            assert client.get("/openapi.json").status_code == 200
    finally:
        monkeypatch.delenv("API_DOCS_ENABLED", raising=False)
        get_settings.cache_clear()
        importlib.reload(main_module)


# --- F-21: sonda técnica de embeddings ---------------------------------------------

def _stub_probe(monkeypatch, available: bool) -> None:
    from app.embeddings import bge_m3
    from app.embeddings.bge_m3 import EmbeddingServiceStatus

    def probe(self) -> EmbeddingServiceStatus:
        return EmbeddingServiceStatus(available=available, model_id=self.model_id, dimensions=1024 if available else None,
                                      cache_dir=self.cache_dir, cache_dir_is_mount=self.cache_dir_is_mount,
                                      load_count=1 if available else 0, shared_instance=True,
                                      error=None if available else "modelo no disponible en este host")

    monkeypatch.setattr(bge_m3.BgeM3EmbeddingService, "probe", probe)


@pytest.mark.contract
def test_probe_without_credentials_is_401_and_does_not_load_the_model(security, monkeypatch) -> None:
    from app.embeddings import bge_m3

    monkeypatch.setattr(bge_m3.BgeM3EmbeddingService, "probe", lambda self: pytest.fail("model load attempted"))
    with TestClient(app) as client:
        response = client.post("/health/embeddings/probe")
    assert response.status_code == 401


@pytest.mark.contract
@pytest.mark.parametrize("roles", [frozenset({"ANALISTA"}), frozenset({"JURIDICO"})])
def test_probe_without_technical_config_manage_is_403_audited_and_does_not_load(security, monkeypatch, roles) -> None:
    from app.embeddings import bge_m3

    repository, headers = security
    caller = headers("sin-permiso", roles)
    monkeypatch.setattr(bge_m3.BgeM3EmbeddingService, "probe", lambda self: pytest.fail("model load attempted"))
    with TestClient(app) as client:
        response = client.post("/health/embeddings/probe", headers=caller)
    assert response.status_code == 403
    denied = [event for event in repository.audit if event["action"] == "AUTHORIZATION_DENIED"]
    assert denied and denied[-1]["resource_identifier"] == "technical_config.manage"


@pytest.mark.contract
@pytest.mark.parametrize(("available", "expected"), [(True, 200), (False, 503)])
def test_probe_with_technical_config_manage_keeps_existing_behavior(security, monkeypatch, available, expected) -> None:
    _repository, headers = security
    ti = headers("ti-sonda", frozenset({"TI"}))
    _stub_probe(monkeypatch, available)
    with TestClient(app) as client:
        response = client.post("/health/embeddings/probe", headers=ti)
    assert response.status_code == expected
    assert response.json()["status"] == ("ok" if available else "unavailable")


@pytest.mark.contract
def test_public_health_routes_remain_unauthenticated() -> None:
    with TestClient(app) as client:
        assert client.get("/health").status_code == 200
        assert client.get("/health/embeddings").status_code == 200

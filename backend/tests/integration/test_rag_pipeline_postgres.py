"""Integración RAG con PostgreSQL desechable y evidencia de auditoría real."""
from __future__ import annotations

import base64
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import UTC, date, datetime, timedelta
import hashlib
import json
import os
from pathlib import Path
import re
from threading import Event, Lock
from time import monotonic, sleep
from urllib.error import HTTPError
from uuid import uuid4

from alembic import command
from alembic.config import Config
import psycopg
import pytest
from fastapi.testclient import TestClient

from app.corpus.tokenizer import FastTokenizer
from app.main import app
from app.rag.index_repository import IndexRepository
from app.rag.indexing import IndexingService
from app.rag.models import EvidenceState
from app.rag.provider import GROQ_CHAT_URL, GroqProvider
from app.rag.retrieval import RetrievalService
from app.rag.retrieval_repository import RetrievalRepository
from app.rag.service import RagApplicationError, RagApplicationService
from app.security.models import AuditPersistenceError, AuthenticatedPrincipal, ROLE_PERMISSIONS
from app.security.repository import SecurityRepository
from app.security.service import SecurityService
from app.security.tokens import JwtService


BACKEND_ROOT = Path(__file__).resolve().parents[2]


class _Database(dict):
    def __repr__(self) -> str:
        return f"_Database(name={self['name']!r}, credentials='<redacted>')"


class _Encoder:
    def encode_documents(self, texts, normalize_embeddings=False):
        return [[0.8, 0.2, *([0.0] * 1022)] for _ in texts]

    def encode_query(self, _query):
        return [1.0, 0.0, *([0.0] * 1022)]


def _contract(status="SUPPORTED", answer="El plazo es de treinta días [E1].", handles=("E1",)) -> str:
    return json.dumps({"status": status, "answer": answer, "evidence_handles": list(handles)}, ensure_ascii=False)


class _Provider:
    """Proveedor controlado: devuelve la salida estructurada indicada y registra cada envío."""

    def __init__(self, output=None):
        self.calls = 0
        self.requests = []
        self.output = output if output is not None else _contract()
        self._lock = Lock()

    def generate(self, messages, *, before_send, response_format=None):
        before_send()
        assert len(messages) == 2 and response_format is not None
        with self._lock:
            self.calls += 1
            self.requests.append((messages, response_format))
        return self.output


@pytest.fixture(scope="module")
def database():
    host = os.environ.get("POSTGRES_HOST", "")
    owner = os.environ.get("POSTGRES_USER", "")
    password = os.environ.get("POSTGRES_PASSWORD", "")
    runtime = os.environ.get("RUNTIME_POSTGRES_USER", "")
    runtime_password = os.environ.get("RUNTIME_POSTGRES_PASSWORD", "")
    if not all((host, owner, password, runtime, runtime_password)):
        pytest.fail("Falta configuración protegida para PostgreSQL de pruebas")
    port = os.environ.get("POSTGRES_PORT", "5432")
    name = f"rag_application_test_{uuid4().hex}"
    maintenance = f"host={host} port={port} dbname=postgres user={owner} password={password}"
    owner_dsn = f"host={host} port={port} dbname={name} user={owner} password={password}"
    runtime_dsn = f"host={host} port={port} dbname={name} user={runtime} password={runtime_password}"
    created = False
    try:
        with psycopg.connect(maintenance, autocommit=True) as admin:
            assert admin.execute("SELECT current_database(), current_user").fetchone() == ("postgres", owner)
            assert name.startswith("rag_application_test_")
            admin.execute(f'CREATE DATABASE "{name}"')
            created = True
        previous = os.environ.get("POSTGRES_DB")
        try:
            os.environ["POSTGRES_DB"] = name
            command.upgrade(Config(str(BACKEND_ROOT / "alembic.ini")), "0018_rag_policy_result")
        finally:
            if previous is None:
                os.environ.pop("POSTGRES_DB", None)
            else:
                os.environ["POSTGRES_DB"] = previous
        with psycopg.connect(owner_dsn, autocommit=True) as connection:
            assert connection.execute("SELECT version_num FROM public.alembic_version").fetchone()[0] == "0018_rag_policy_result"
        yield _Database(name=name, owner=owner_dsn, runtime=runtime_dsn)
    finally:
        if created:
            with psycopg.connect(maintenance, autocommit=True) as admin:
                assert name.startswith("rag_application_test_")
                assert admin.execute("SELECT count(*) FROM pg_stat_activity WHERE datname=%s", (name,)).fetchone()[0] == 0
                admin.execute(f'DROP DATABASE "{name}"')


def _principal(database) -> AuthenticatedPrincipal:
    identity, session = uuid4(), uuid4()
    username = f"rag-application-{identity.hex}"
    with psycopg.connect(database["owner"], autocommit=True) as connection:
        connection.execute(
            "INSERT INTO app.user_account (id, username, display_name, password_hash) "
            "VALUES (%s, %s, 'Synthetic', 'hash')", (identity, username),
        )
        connection.execute("INSERT INTO app.user_role (user_id, role_id) VALUES (%s, 'JURIDICO')", (identity,))
        connection.execute(
            "INSERT INTO app.access_session (id, user_id, refresh_token_sha256, authorization_version, state, expires_at) "
            "VALUES (%s, %s, %s, 1, 'ACTIVE', %s)",
            (session, identity, bytes(32), datetime.now(UTC) + timedelta(hours=2)),
        )
    return AuthenticatedPrincipal(identity, session, username, 1, frozenset({"JURIDICO"}), ROLE_PERMISSIONS["JURIDICO"])


def _grant(database, active=True):
    with psycopg.connect(database["owner"], autocommit=True) as connection:
        SecurityRepository.set_scope_grant(connection, "JURIDICO", "CONTRATOS_DOCUMENTOS", active)


def _document(database):
    return _document_with_text(database, "El contrato sintético establece un plazo de treinta días.")


def _document_with_text(database, text, *, name="Synthetic document", document_date=date(2026, 1, 1)):
    file_id, stored_id, version_id = uuid4(), uuid4(), uuid4()
    digest = hashlib.sha256(text.encode()).digest()
    with psycopg.connect(database["owner"], autocommit=True) as connection:
        connection.execute(
            "INSERT INTO app.stored_object (id, storage_kind, locator, sha256, mime_type, byte_size, original_name) "
            "VALUES (%s, 'FILESYSTEM', %s, %s, 'application/pdf', 10, 'synthetic.pdf')",
            (stored_id, f"synthetic/{stored_id}", digest),
        )
        connection.execute(
            "INSERT INTO app.ingest_file (id, stored_object_id, source_family, exchange_format, state, "
            "operation_id, correlation_id, declared_extension, detected_format, format_classification, "
            "technical_result, declared_name, source_locator, source_revision, actor_identifier, content_sha256) "
            "VALUES (%s, %s, 'CONTRATOS_DOCUMENTOS', 'PDF', 'COMPLETADO', %s, %s, '.pdf', 'PDF', "
            "'SUPPORTED', 'ACCEPTED', 'synthetic.pdf', %s, 1, 'test', %s)",
            (file_id, stored_id, uuid4(), uuid4(), f"synthetic/{file_id}", digest),
        )
        connection.execute(
            "INSERT INTO app.document (id_documento, name, document_type, source_family, document_date) "
            "VALUES (%s, %s, 'CONTRATO', 'CONTRATOS_DOCUMENTOS', %s)",
            (str(file_id), name, document_date),
        )
        connection.execute(
            "INSERT INTO app.document_version (id, id_documento, version_number, stored_object_id, "
            "processing_state, consolidated_text, content_sha256, operation_id, correlation_id) "
            "VALUES (%s, %s, 1, %s, 'PROCESANDO', %s, %s, %s, %s)",
            (version_id, str(file_id), stored_id, text, digest, uuid4(), uuid4()),
        )
    indexed = IndexingService(IndexRepository(database["owner"]), _Encoder()).index_version(
        document_version_id=version_id, consolidated_text=text, tokenizer=FastTokenizer()
    )
    with psycopg.connect(database["owner"], autocommit=True) as connection:
        connection.execute("UPDATE app.document SET active_version_id=%s WHERE id_documento=%s", (version_id, str(file_id)))
    return indexed.fragment_ids[0]


def _service(database, provider=None):
    security = SecurityService(SecurityRepository(database["runtime"]))
    return RagApplicationService(
        conninfo=database["runtime"], security=security,
        retrieval=RetrievalService(security, encoder=_Encoder()), provider=provider or _Provider(),
    )


def _synthetic_deadline(response: str) -> str | None:
    match = re.search(r"\b(?:treinta|30)\s+d[íi]as\b", response, flags=re.IGNORECASE)
    return match.group(0) if match else None


@pytest.mark.parametrize("response", (
    "El plazo es de treinta días [E1].",
    "El plazo es de 30   DÍAS [E1].",
))
def test_rf055_synthetic_deadline_accepts_equivalent_facts(response: str) -> None:
    assert _synthetic_deadline(response) is not None


@pytest.mark.parametrize("response", (
    "No puedo determinar el plazo. [E1]",
    "El plazo es de cuarenta días [E1].",
))
def test_rf055_synthetic_deadline_rejects_abstention_and_wrong_fact(response: str) -> None:
    assert _synthetic_deadline(response) is None


def test_state_three_persists_operation_and_atomic_audit(database) -> None:
    principal = _principal(database)
    service = _service(database)
    result = service.execute(principal=principal, query="Consulta sintética", idempotency_key=uuid4())
    assert result.status_code == 200
    assert result.payload["state"] == "SIN_EVIDENCIA"
    assert result.payload["fragments"] == []
    with psycopg.connect(database["owner"], autocommit=True) as connection:
        row = connection.execute(
            "SELECT r.query_sha256, e.query_sha256, e.action FROM app.rag_operation r "
            "JOIN audit.event e ON e.operation_id=r.operation_id WHERE r.operation_id=%s",
            (result.payload["operation_id"],),
        ).fetchone()
        assert bytes(row[0]) == bytes(row[1])
        assert row[2] == "RAG_QUERY"


def test_state_two_preserves_reference_fragments_without_generation(database) -> None:
    _grant(database)
    _document(database)
    principal = _principal(database)
    provider = _Provider()
    service = _service(database, provider)
    original = service.retrieval.retrieve

    def insufficient(connection, context):
        return replace(original(connection, context), state=EvidenceState.EVIDENCIA_INSUFICIENTE)

    service.retrieval.retrieve = insufficient
    result = service.execute(principal=principal, query="¿Cuál es el plazo?")
    assert result.status_code == 200
    assert result.payload["state"] == "EVIDENCIA_INSUFICIENTE"
    assert result.payload["generation_status"] == "NOT_REQUESTED"
    assert result.payload["generated_response"] is None
    assert result.payload["citations"] == []
    assert result.payload["fragments"]
    assert provider.calls == 0
    with psycopg.connect(database["owner"], autocommit=True) as connection:
        assert connection.execute(
            "SELECT count(*) FROM app.rag_final_fragment f JOIN app.rag_operation r ON r.id=f.rag_operation_id "
            "WHERE r.operation_id=%s AND f.usage='REFERENCE'",
            (result.payload["operation_id"],),
        ).fetchone()[0] == len(result.payload["fragments"])


def test_rf048_reference_is_persisted_only_when_valid(database) -> None:
    principal = _principal(database)
    run_id, finding_id, reference_id = uuid4(), uuid4(), uuid4()
    with psycopg.connect(database["owner"], autocommit=True) as connection:
        connection.execute(
            "INSERT INTO app.analytic_run (id, run_type, state, result, operation_id, correlation_id, completed_at) "
            "VALUES (%s, 'PROACTIVE_ANALYSIS', 'COMPLETED', 'SUCCESS', %s, %s, CURRENT_TIMESTAMP)",
            (run_id, uuid4(), uuid4()),
        )
        connection.execute(
            "INSERT INTO app.finding (id, analytic_run_id, finding_type, description, triggered_rule, state) "
            "VALUES (%s, %s, 'SIGNAL', 'Hallazgo sintético', 'RULE_SYNTHETIC', 'OPEN')",
            (finding_id, run_id),
        )
        connection.execute(
            "INSERT INTO app.context_reference (id, finding_id, operation_id, correlation_id) "
            "VALUES (%s, %s, %s, %s)",
            (reference_id, finding_id, uuid4(), uuid4()),
        )
    _grant(database, active=False)
    service = _service(database)
    key = uuid4()
    valid = service.execute(
        principal=principal, query="Consulta sintética", idempotency_key=key,
        context_reference_id=reference_id,
    )
    invalid = service.execute(principal=principal, query="Consulta sintética", context_reference_id=uuid4())
    assert valid.payload["context_reference_id"] == reference_id
    assert invalid.payload["context_reference_id"] is None
    assert valid.payload["state"] == invalid.payload["state"] == "SIN_EVIDENCIA"
    assert valid.payload["fragments"] == invalid.payload["fragments"] == []
    with psycopg.connect(database["owner"], autocommit=True) as connection:
        assert connection.execute(
            "SELECT context_reference_id FROM app.rag_operation WHERE operation_id=%s",
            (valid.payload["operation_id"],),
        ).fetchone()[0] == reference_id
        assert connection.execute(
            "SELECT context_reference_id FROM app.rag_operation WHERE operation_id=%s",
            (invalid.payload["operation_id"],),
        ).fetchone()[0] is None
    with pytest.raises(RagApplicationError) as error:
        service.execute(
            principal=principal, query="Consulta sintética", idempotency_key=key,
            context_reference_id=uuid4(),
        )
    assert error.value.status_code == 409


def test_idempotency_conflicts_on_query_and_session_without_new_audit(database) -> None:
    _grant(database, active=False)
    principal = _principal(database)
    key = uuid4()
    service = _service(database)
    first = service.execute(principal=principal, query="Consulta A", idempotency_key=key)
    with pytest.raises(RagApplicationError) as query_error:
        service.execute(principal=principal, query="Consulta B", idempotency_key=key)
    assert query_error.value.status_code == 409
    other_session = uuid4()
    with psycopg.connect(database["owner"], autocommit=True) as connection:
        connection.execute(
            "INSERT INTO app.access_session (id, user_id, refresh_token_sha256, authorization_version, state, expires_at) "
            "VALUES (%s, %s, %s, 1, 'ACTIVE', %s)",
            (other_session, principal.account_id, bytes([1]) * 32, datetime.now(UTC) + timedelta(hours=2)),
        )
    with pytest.raises(RagApplicationError) as session_error:
        service.execute(
            principal=replace(principal, session_id=other_session),
            query="Consulta A", idempotency_key=key,
        )
    assert session_error.value.status_code == 409
    with psycopg.connect(database["owner"], autocommit=True) as connection:
        assert connection.execute(
            "SELECT count(*) FROM app.rag_operation WHERE operation_id=%s",
            (first.payload["operation_id"],),
        ).fetchone()[0] == 1
        assert connection.execute(
            "SELECT count(*) FROM audit.event WHERE operation_id=%s",
            (first.payload["operation_id"],),
        ).fetchone()[0] == 1


def test_state_one_cites_persisted_authorized_fragment_and_retry_is_idempotent(database) -> None:
    _grant(database)
    with psycopg.connect(database["owner"], autocommit=True) as connection:
        connection.execute("UPDATE app.document SET active_version_id=NULL WHERE active_version_id IS NOT NULL")
    fragment = _document(database)
    principal = _principal(database)
    provider = _Provider()
    key = uuid4()
    service = _service(database, provider)
    first = service.execute(principal=principal, query="¿Cuál es el plazo del contrato?", idempotency_key=key)
    second = _service(database, provider).execute(
        principal=principal, query="¿Cuál es el plazo del contrato?", idempotency_key=key
    )
    assert first.status_code == second.status_code == 200
    assert first.payload["state"] == "EVIDENCIA_SUFICIENTE"
    assert first.payload["operation_id"] == second.payload["operation_id"]
    assert any(item["fragment_id"] == fragment for item in first.payload["fragments"])
    assert first.payload["citations"] == second.payload["citations"]
    assert first.payload["citations"][0]["handle"] == "E1"
    assert first.payload["citations"][0]["fragment_id"] == fragment
    assert provider.calls == 1
    with psycopg.connect(database["owner"], autocommit=True) as connection:
        operation_id = first.payload["operation_id"]
        assert connection.execute("SELECT count(*) FROM app.rag_operation WHERE operation_id=%s", (operation_id,)).fetchone()[0] == 1
        assert connection.execute("SELECT count(*) FROM audit.event WHERE operation_id=%s", (operation_id,)).fetchone()[0] == 1
        assert connection.execute(
            "SELECT count(*) FROM app.rag_final_fragment f JOIN app.rag_operation r ON r.id=f.rag_operation_id "
            "WHERE r.operation_id=%s AND f.fragment_id=%s", (operation_id, fragment),
        ).fetchone()[0] == 1


def test_http_jwt_to_retrieval_and_audit_revalidates_revoked_retry(database, monkeypatch) -> None:
    _grant(database)
    _document(database)
    principal = _principal(database)
    secret = base64.urlsafe_b64encode(b"clave-sintetica-de-prueba-32-bytes!!").decode().rstrip("=")
    tokens = JwtService(issuer="rag-test", audience="rag-test", keyring={"test": secret}, active_kid="test")
    security = SecurityService(SecurityRepository(database["runtime"]), tokens)
    provider = _Provider()
    service = RagApplicationService(
        conninfo=database["runtime"], security=security,
        retrieval=RetrievalService(security, encoder=_Encoder()), provider=provider,
    )
    monkeypatch.setattr(app.state, "security_service", security, raising=False)
    monkeypatch.setattr(app.state, "rag_application_service", service, raising=False)
    access = tokens.issue(
        account_id=principal.account_id, session_id=principal.session_id,
        authorization_version=principal.authorization_version,
    )
    key = uuid4()
    client = TestClient(app)
    assert client.post(
        "/api/rag/query", json={"query": "¿Cuál es el plazo del contrato?"},
        headers={"Authorization": "Bearer not.a.valid.jwt"},
    ).status_code == 401
    first = client.post(
        "/api/rag/query", json={"query": "¿Cuál es el plazo del contrato?"},
        headers={"Authorization": f"Bearer {access}", "Idempotency-Key": str(key)},
    )
    assert first.status_code == 200
    assert first.json()["state"] == "EVIDENCIA_SUFICIENTE"
    assert first.json()["citations"][0]["fragment_id"] in {
        item["fragment_id"] for item in first.json()["fragments"]
    }
    assert provider.calls == 1
    _grant(database, active=False)
    denied = client.post(
        "/api/rag/query", json={"query": "¿Cuál es el plazo del contrato?"},
        headers={"Authorization": f"Bearer {access}", "Idempotency-Key": str(key)},
    )
    assert denied.status_code == 403
    assert "fragment" not in denied.text.lower()
    assert provider.calls == 1
    with psycopg.connect(database["owner"], autocommit=True) as connection:
        assert connection.execute(
            "SELECT count(*) FROM audit.event WHERE operation_id=%s",
            (first.json()["operation_id"],),
        ).fetchone()[0] == 1


def test_explicit_denial_is_state_four_with_one_audit_and_no_fragments(database) -> None:
    principal = _principal(database)
    key = uuid4()
    with psycopg.connect(database["owner"], autocommit=True) as connection:
        connection.execute("DELETE FROM app.user_role WHERE user_id=%s", (principal.account_id,))
    service = _service(database)
    result = service.execute(principal=principal, query="Consulta sintética", idempotency_key=key)
    assert result.status_code == 403
    assert result.payload["state"] == "SIN_AUTORIZACION"
    assert result.payload["fragments"] == []
    assert result.payload["citations"] == []
    with psycopg.connect(database["owner"], autocommit=True) as connection:
        assert connection.execute(
            "SELECT count(*) FROM audit.event WHERE operation_id=%s AND action='AUTHORIZATION_DENIED'",
            (result.payload["operation_id"],),
        ).fetchone()[0] == 1
    retry = service.execute(principal=principal, query="Consulta sintética", idempotency_key=key)
    assert retry.status_code == 403
    assert retry.payload["operation_id"] == result.payload["operation_id"]
    assert retry.payload["fragments"] == []
    with psycopg.connect(database["owner"], autocommit=True) as connection:
        assert connection.execute(
            "SELECT count(*) FROM audit.event WHERE actor_user_id=%s AND action='AUTHORIZATION_DENIED'",
            (principal.account_id,),
        ).fetchone()[0] == 2
        assert connection.execute(
            "SELECT count(*) FROM app.rag_operation WHERE operation_id=%s",
            (result.payload["operation_id"],),
        ).fetchone()[0] == 1


def test_audit_failure_rolls_back_operation_and_fragments(database, monkeypatch) -> None:
    principal = _principal(database)
    key = uuid4()
    service = _service(database)
    operation_id = service._identity(principal, key)

    def fail_audit(*_args, **_kwargs):
        raise AuditPersistenceError("fallo sintético")

    monkeypatch.setattr(SecurityRepository, "write_rag_audit_event", fail_audit)
    with pytest.raises(RagApplicationError):
        service.execute(principal=principal, query="Consulta sintética", idempotency_key=key)
    with psycopg.connect(database["owner"], autocommit=True) as connection:
        assert connection.execute("SELECT count(*) FROM app.rag_operation WHERE operation_id=%s", (operation_id,)).fetchone()[0] == 0


def test_revoked_retry_does_not_replay_persisted_evidence(database) -> None:
    _grant(database)
    _document(database)
    principal = _principal(database)
    key = uuid4()
    service = _service(database)
    first = service.execute(principal=principal, query="¿Cuál es el plazo?", idempotency_key=key)
    assert first.payload["state"] == "EVIDENCIA_SUFICIENTE"
    _grant(database, active=False)
    with pytest.raises(RagApplicationError) as error:
        service.execute(principal=principal, query="¿Cuál es el plazo?", idempotency_key=key)
    assert error.value.status_code == 403
    with psycopg.connect(database["owner"], autocommit=True) as connection:
        assert connection.execute(
            "SELECT count(*) FROM app.rag_operation WHERE operation_id=%s", (first.payload["operation_id"],)
        ).fetchone()[0] == 1


def test_revoked_retry_audit_failure_is_safe_and_does_not_replay(database, monkeypatch) -> None:
    _grant(database)
    _document(database)
    principal = _principal(database)
    key = uuid4()
    service = _service(database)
    first = service.execute(principal=principal, query="¿Cuál es el plazo?", idempotency_key=key)
    assert first.status_code == 200
    _grant(database, active=False)

    def fail_denial_audit(*_args, **_kwargs):
        raise AuditPersistenceError("fallo sintético")

    monkeypatch.setattr(SecurityRepository, "write_audit_event", fail_denial_audit)
    with pytest.raises(RagApplicationError) as error:
        service.execute(principal=principal, query="¿Cuál es el plazo?", idempotency_key=key)
    assert error.value.status_code == 503
    assert str(error.value) == "La operación no pudo completarse"


def test_revocation_waits_until_authorized_replay_is_materialized(database, monkeypatch) -> None:
    _grant(database)
    _document(database)
    principal = _principal(database)
    key = uuid4()
    service = _service(database)
    first = service.execute(principal=principal, query="¿Cuál es el plazo?", idempotency_key=key)
    assert first.status_code == 200
    revocation_started = Event()
    revocation_pid = {}
    original = RetrievalRepository.final_fragments_still_authorized

    def revoke() -> None:
        with psycopg.connect(database["owner"], autocommit=True) as connection:
            with connection.transaction():
                revocation_pid["value"] = connection.execute("SELECT pg_backend_pid()").fetchone()[0]
                revocation_started.set()
                connection.execute(
                    "UPDATE app.access_session SET state='INVALIDATED', invalidated_at=CURRENT_TIMESTAMP WHERE id=%s",
                    (principal.session_id,),
                )
                SecurityRepository.set_scope_grant(connection, "JURIDICO", "CONTRATOS_DOCUMENTOS", False)

    with ThreadPoolExecutor(max_workers=1) as pool:
        future = None

        def check(repository, connection, scope, fragment_ids):
            nonlocal future
            future = pool.submit(revoke)
            assert revocation_started.wait(5)
            # La sesión queda bloqueada hasta terminar el chequeo y la lectura.
            deadline = monotonic() + 3
            while monotonic() < deadline:
                with psycopg.connect(database["owner"], autocommit=True) as observer:
                    wait_type = observer.execute(
                        "SELECT wait_event_type FROM pg_stat_activity WHERE pid=%s",
                        (revocation_pid["value"],),
                    ).fetchone()[0]
                if wait_type == "Lock":
                    break
                sleep(0.02)
            assert wait_type == "Lock"
            assert not future.done()
            return original(repository, connection, scope, fragment_ids)

        monkeypatch.setattr(RetrievalRepository, "final_fragments_still_authorized", check)
        replay = service.execute(principal=principal, query="¿Cuál es el plazo?", idempotency_key=key)
        assert replay.status_code == 200
        assert replay.payload["fragments"] == first.payload["fragments"]
        assert future is not None
        future.result(timeout=10)
    with pytest.raises(RagApplicationError) as error:
        service.execute(principal=principal, query="¿Cuál es el plazo?", idempotency_key=key)
    assert error.value.status_code == 401


def test_revocation_after_commit_before_presentation_is_audited(database, monkeypatch) -> None:
    _grant(database)
    _document(database)
    principal = _principal(database)
    service = _service(database)
    original = service._existing_result

    def revoke_before_presentation(*args, **kwargs):
        _grant(database, active=False)
        return original(*args, **kwargs)

    monkeypatch.setattr(service, "_existing_result", revoke_before_presentation)
    with pytest.raises(RagApplicationError) as error:
        service.execute(principal=principal, query="¿Cuál es el plazo?")
    assert error.value.status_code == 403
    with psycopg.connect(database["owner"], autocommit=True) as connection:
        assert connection.execute(
            "SELECT count(*) FROM app.rag_operation WHERE user_id=%s AND state='EVIDENCIA_SUFICIENTE'",
            (principal.account_id,),
        ).fetchone()[0] == 1
        assert connection.execute(
            "SELECT count(*) FROM audit.event WHERE actor_user_id=%s AND action='AUTHORIZATION_DENIED'",
            (principal.account_id,),
        ).fetchone()[0] == 1


def test_transport_failure_persists_failed_operation_and_single_audit(database) -> None:
    _grant(database)
    _document(database)
    principal = _principal(database)

    class FailedProvider:
        def generate(self, _messages, *, before_send, response_format=None):
            before_send()
            from app.rag.provider import GroqFailure
            raise GroqFailure("PROVIDER_UNAVAILABLE")

    key = uuid4()
    result = _service(database, FailedProvider()).execute(
        principal=principal, query="¿Cuál es el plazo?", idempotency_key=key,
    )
    assert result.status_code == 503
    assert result.payload["operation_status"] == "FAILED"
    assert result.payload["generation_status"] == "FAILED"
    assert result.payload["generated_response"] is None
    # Un error técnico no se convierte en Estado 1, 2 ni 3: no hay estado final de evidencia.
    assert result.payload["state"] is None and result.payload["citations"] == []
    assert result.payload["fragments"] and all(item["usage"] == "REFERENCE" for item in result.payload["fragments"])
    with psycopg.connect(database["owner"], autocommit=True) as connection:
        operation = connection.execute(
            "SELECT safe_cause_code FROM app.rag_operation WHERE operation_id=%s",
            (result.payload["operation_id"],),
        ).fetchone()
        assert operation[0] == "PROVIDER_UNAVAILABLE"
        audit = connection.execute(
            "SELECT result, count(*) FROM audit.event WHERE operation_id=%s GROUP BY result",
            (result.payload["operation_id"],),
        ).fetchone()
        assert audit == ("FAILURE", 1)


def test_exhausted_429_keeps_only_authorized_fragments_and_one_failure_audit(database) -> None:
    _grant(database)
    _document(database)
    principal = _principal(database)

    class RateLimitedOpener:
        calls = 0

        def open(self, _request, timeout):
            self.calls += 1
            raise HTTPError(GROQ_CHAT_URL, 429, "rate", {}, None)

    opener = RateLimitedOpener()
    provider = GroqProvider(
        api_key="clave-sintetica", timeout_seconds=1, opener=opener, sleep=lambda _: None,
    )
    result = _service(database, provider).execute(principal=principal, query="¿Cuál es el plazo?")
    assert opener.calls == 3
    assert result.status_code == 503
    assert result.payload["state"] is None
    assert result.payload["operation_status"] == "FAILED"
    assert result.payload["generation_status"] == "FAILED"
    assert result.payload["generated_response"] is None
    assert result.payload["fragments"]
    with psycopg.connect(database["owner"], autocommit=True) as connection:
        assert connection.execute(
            "SELECT safe_cause_code FROM app.rag_operation WHERE operation_id=%s",
            (result.payload["operation_id"],),
        ).fetchone()[0] == "PROVIDER_RATE_LIMITED"
        assert connection.execute(
            "SELECT count(*) FROM audit.event WHERE operation_id=%s AND result='FAILURE'",
            (result.payload["operation_id"],),
        ).fetchone()[0] == 1


def test_429_revocation_during_backoff_prevents_second_post(database) -> None:
    _grant(database)
    _document(database)
    principal = _principal(database)

    class RateLimitedOpener:
        calls = 0

        def open(self, _request, timeout):
            self.calls += 1
            raise HTTPError(GROQ_CHAT_URL, 429, "rate", {}, None)

    opener = RateLimitedOpener()
    provider = GroqProvider(
        api_key="clave-sintetica", timeout_seconds=1, opener=opener,
        sleep=lambda _delay: _grant(database, active=False),
    )
    result = _service(database, provider).execute(principal=principal, query="¿Cuál es el plazo?")
    assert opener.calls == 1
    assert result.status_code == 403
    assert result.payload["state"] == "SIN_AUTORIZACION"
    assert result.payload["fragments"] == []
    with psycopg.connect(database["owner"], autocommit=True) as connection:
        assert connection.execute(
            "SELECT count(*) FROM audit.event WHERE operation_id=%s AND action='AUTHORIZATION_DENIED'",
            (result.payload["operation_id"],),
        ).fetchone()[0] == 1


def test_concurrent_same_key_has_one_durable_operation_and_audit(database) -> None:
    _grant(database)
    _document(database)
    principal = _principal(database)
    key = uuid4()
    provider = _Provider()
    service = _service(database, provider)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(
            lambda _: service.execute(principal=principal, query="¿Cuál es el plazo?", idempotency_key=key),
            range(2),
        ))
    assert len({result.payload["operation_id"] for result in results}) == 1
    operation_id = results[0].payload["operation_id"]
    with psycopg.connect(database["owner"], autocommit=True) as connection:
        assert connection.execute("SELECT count(*) FROM app.rag_operation WHERE operation_id=%s", (operation_id,)).fetchone()[0] == 1
        assert connection.execute("SELECT count(*) FROM audit.event WHERE operation_id=%s", (operation_id,)).fetchone()[0] == 1


def test_real_groq_smoke_with_synthetic_authorized_document(database) -> None:
    key = os.environ.get("GROQ_API_KEY", "")
    if not key:
        pytest.fail("GROQ_API_KEY ausente; el smoke real no puede declararse PASS")
    _grant(database)
    fragment_id = _document(database)
    principal = _principal(database)
    service = _service(database, GroqProvider(api_key=key, timeout_seconds=45))
    result = service.execute(
        principal=principal,
        query="Según el documento sintético, ¿cuál es el plazo?",
    )
    with psycopg.connect(database["owner"], autocommit=True) as connection:
        operation = connection.execute(
            "SELECT safe_cause_code, generated_response FROM app.rag_operation WHERE operation_id=%s",
            (result.payload["operation_id"],),
        ).fetchone()
        cause, persisted_response = operation if operation else (None, None)
        persisted = connection.execute(
            "SELECT count(*) FROM app.rag_final_fragment f JOIN app.rag_operation r ON r.id=f.rag_operation_id "
            "WHERE r.operation_id=%s AND f.fragment_id=%s AND f.usage='EVIDENCE'",
            (result.payload["operation_id"], fragment_id),
        ).fetchone()[0]
        source_text = connection.execute(
            "SELECT content FROM app.document_chunk WHERE id=%s", (fragment_id,),
        ).fetchone()[0]
        audited = connection.execute(
            "SELECT count(*) FROM audit.event WHERE operation_id=%s AND action='RAG_QUERY' AND result='SUCCESS'",
            (result.payload["operation_id"],),
        ).fetchone()[0]
    assert result.status_code == 200, f"causa_segura={cause}"
    assert result.payload["state"] == "EVIDENCIA_SUFICIENTE"
    response = result.payload["generated_response"]
    assert response and response.strip()
    observed_fact = _synthetic_deadline(response)
    assert observed_fact is not None, "La respuesta no fundamentó el plazo sintético"
    assert _synthetic_deadline(source_text) is not None
    assert len(result.payload["fragments"]) == 1
    assert result.payload["fragments"][0]["fragment_id"] == fragment_id
    assert len(result.payload["citations"]) == 1
    assert result.payload["citations"][0]["handle"] == "E1"
    assert result.payload["citations"][0]["fragment_id"] == fragment_id
    assert persisted_response == response
    assert _synthetic_deadline(persisted_response) is not None
    assert persisted == 1
    assert audited == 1
    assert key not in str(result.payload)
    print(f"RF055_OBSERVED_SYNTHETIC_FACT={observed_fact}")
    print("RF055_CITATION_HANDLES=E1")
    print("RF055_PERSISTED_RESPONSE_FACT=PASS")


class _CountingRepository(RetrievalRepository):
    def __init__(self):
        super().__init__()
        self.vector_calls = 0

    def vector_top10(self, connection, scope, query_embedding):
        self.vector_calls += 1
        return super().vector_top10(connection, scope, query_embedding)


@pytest.mark.requires_db
def test_autonomous_decision_is_scope_restricted_without_retrieval_or_provider(database) -> None:
    """SRS v0.23 Gate 1: restricción de alcance, sin recuperación ni proveedor y sin reutilizar el Estado 4."""
    _grant(database)
    _document(database)
    principal = _principal(database)
    provider, repository = _Provider(), _CountingRepository()
    security = SecurityService(SecurityRepository(database["runtime"]))
    service = RagApplicationService(conninfo=database["runtime"], security=security,
                                    retrieval=RetrievalService(security, repository=repository, encoder=_Encoder()), provider=provider)
    key = uuid4()
    result = service.execute(principal=principal, query="Decide si debo demandar al proveedor", idempotency_key=key)
    assert result.status_code == 200
    assert result.payload["state"] is None and result.payload["policy_result"] == "RESTRICCION_ALCANCE"
    assert result.payload["fragments"] == [] and result.payload["citations"] == [] and result.payload["generated_response"] is None
    assert "no toma decisiones jurídicas" in result.payload["safe_result_message"]
    assert provider.calls == 0 and repository.vector_calls == 0
    with psycopg.connect(database["owner"], autocommit=True) as connection:
        row = connection.execute(
            "SELECT r.state, r.policy_result, r.operation_status, r.generation_status, e.result, e.safe_cause_code, "
            "(SELECT count(*) FROM app.rag_final_fragment f WHERE f.rag_operation_id=r.id), "
            "(SELECT count(*) FROM audit.event_resource er WHERE er.event_id=e.id) "
            "FROM app.rag_operation r JOIN audit.event e ON e.operation_id=r.operation_id WHERE r.operation_id=%s",
            (result.payload["operation_id"],),
        ).fetchone()
    assert row == (None, "RESTRICCION_ALCANCE", "COMPLETED", "NOT_REQUESTED", "RESTRICTED", "AUTONOMOUS_DECISION_REQUEST", 0, 0)
    retry = service.execute(principal=principal, query="Decide si debo demandar al proveedor", idempotency_key=key)
    assert retry.payload == result.payload and provider.calls == 0


@pytest.mark.requires_db
def test_restricted_lifecycle_constraint_rejects_mixed_states(database) -> None:
    """La restricción no puede convivir con un estado de evidencia ni con una respuesta generada."""
    principal = _principal(database)
    with psycopg.connect(database["owner"], autocommit=True) as connection:
        with pytest.raises(psycopg.errors.CheckViolation):
            connection.execute(
                "INSERT INTO app.rag_operation (id, user_id, session_id, query_sha256, state, generated_response, safe_result_message, "
                "operation_id, correlation_id, operation_status, generation_status, policy_result) "
                "VALUES (%s, %s, %s, %s, 'SIN_AUTORIZACION', NULL, 'x', %s, %s, 'COMPLETED', 'NOT_REQUESTED', 'RESTRICCION_ALCANCE')",
                (uuid4(), principal.account_id, principal.session_id, bytes(32), uuid4(), uuid4()),
            )


# --- Generación sustentada con proveedor CONTROLADO (F-04, SRS v0.23 borrador) ---------------------

def _isolate(database) -> None:
    """Deja como único corpus activo el documento que cree la prueba (handles deterministas)."""
    with psycopg.connect(database["owner"], autocommit=True) as connection:
        connection.execute("UPDATE app.document SET active_version_id=NULL WHERE active_version_id IS NOT NULL")


def _operation(database, operation_id):
    with psycopg.connect(database["owner"], autocommit=True) as connection:
        return connection.execute(
            "SELECT r.state, r.operation_status, r.generation_status, r.safe_cause_code, r.generated_response, "
            "(SELECT count(*) FROM app.rag_final_fragment f WHERE f.rag_operation_id=r.id AND f.usage='EVIDENCE'), "
            "(SELECT count(*) FROM audit.event e WHERE e.operation_id=r.operation_id) "
            "FROM app.rag_operation r WHERE r.operation_id=%s", (operation_id,),
        ).fetchone()


@pytest.mark.requires_db
def test_grounded_supported_valid_is_state_one_with_single_call_and_schema(database) -> None:
    _grant(database)
    with psycopg.connect(database["owner"], autocommit=True) as connection:
        connection.execute("UPDATE app.document SET active_version_id=NULL WHERE active_version_id IS NOT NULL")
    fragment = _document(database)
    principal = _principal(database)
    provider = _Provider()
    result = _service(database, provider).execute(principal=principal, query="¿Cuál es el plazo del contrato sintético?")
    assert result.status_code == 200 and result.payload["state"] == "EVIDENCIA_SUFICIENTE"
    assert result.payload["generation_status"] == "SUCCEEDED" and result.payload["generated_response"] == "El plazo es de treinta días [E1]."
    assert [item["fragment_id"] for item in result.payload["citations"]] == [fragment]
    assert provider.calls == 1
    messages, response_format = provider.requests[0]
    assert response_format["json_schema"]["strict"] is True
    assert response_format["json_schema"]["schema"]["properties"]["evidence_handles"]["items"]["enum"] == ["E1"]
    assert "treinta días" in messages[1]["content"]


@pytest.mark.requires_db
def test_grounded_insufficient_is_state_two_abstained_with_reference_fragments(database) -> None:
    _grant(database)
    _isolate(database)
    _document(database)
    principal = _principal(database)
    provider = _Provider(_contract("INSUFFICIENT", None, ()))
    result = _service(database, provider).execute(principal=principal, query="¿Cuál es el plazo del contrato sintético?")
    assert result.status_code == 200 and result.payload["state"] == "EVIDENCIA_INSUFICIENTE"
    assert result.payload["generation_status"] == "ABSTAINED" and result.payload["generated_response"] is None
    assert result.payload["citations"] == [] and result.payload["fragments"]
    assert all(item["usage"] == "REFERENCE" for item in result.payload["fragments"])
    assert provider.calls == 1
    assert _operation(database, result.payload["operation_id"]) == ("EVIDENCIA_INSUFICIENTE", "COMPLETED", "ABSTAINED", None, None, 0, 1)


@pytest.mark.requires_db
@pytest.mark.parametrize("output", [
    _contract("SUPPORTED", "El plazo es de treinta días.", ()),                     # SUPPORTED sin citas
    _contract("SUPPORTED", "El plazo es de treinta días [E4].", ("E4",)),           # handle inventado
    _contract("SUPPORTED", "El plazo es de treinta días.", ("DOC-OTRO",)),          # referencia a otro documento
    "El plazo es de treinta días [E1].",                                           # schema inválido (texto libre)
    json.dumps({"status": "SUPPORTED", "answer": "El plazo es de treinta días [E1]."}),  # campo faltante
], ids=["sin-citas", "handle-inventado", "otro-documento", "texto-libre", "campo-faltante"])
def test_grounded_contract_violation_is_controlled_failure_never_state_one(database, output) -> None:
    _grant(database)
    _isolate(database)
    _document(database)
    principal = _principal(database)
    provider = _Provider(output)
    result = _service(database, provider).execute(principal=principal, query="¿Cuál es el plazo del contrato sintético?")
    assert result.status_code == 503 and result.payload["state"] is None
    assert result.payload["operation_status"] == "FAILED" and result.payload["generation_status"] == "FAILED"
    assert result.payload["generated_response"] is None and result.payload["citations"] == []
    state, operation, generation, cause, response, evidence, audits = _operation(database, result.payload["operation_id"])
    assert (state, operation, generation, cause, response, evidence, audits) == (None, "FAILED", "FAILED", "INVALID_PROVIDER_OUTPUT", None, 0, 1)


@pytest.mark.requires_db
@pytest.mark.parametrize("cause", ["PROVIDER_TIMEOUT", "PROVIDER_UNAVAILABLE", "PROVIDER_RATE_LIMITED"])
def test_grounded_technical_errors_keep_technical_semantics(database, cause) -> None:
    _grant(database)
    _document(database)
    principal = _principal(database)

    class Failing:
        def generate(self, _messages, *, before_send, response_format=None):
            before_send()
            from app.rag.provider import GroqFailure
            raise GroqFailure(cause)

    result = _service(database, Failing()).execute(principal=principal, query="¿Cuál es el plazo del contrato sintético?")
    assert result.status_code == 503 and result.payload["state"] is None
    assert _operation(database, result.payload["operation_id"])[:4] == (None, "FAILED", "FAILED", cause)


@pytest.mark.requires_db
def test_local_gates_cannot_declare_state_one_without_provider_validation(database) -> None:
    """Defensa: si la recuperación devolviera Estado 1 por sí sola, la operación falla sin llamar al proveedor."""
    _grant(database)
    _isolate(database)
    _document(database)
    principal = _principal(database)
    provider = _Provider()
    service = _service(database, provider)
    original = service.retrieval.retrieve
    service.retrieval.retrieve = lambda connection, context: replace(original(connection, context), state=EvidenceState.EVIDENCIA_SUFICIENTE)
    result = service.execute(principal=principal, query="¿Cuál es el plazo del contrato sintético?")
    assert provider.calls == 0
    assert result.status_code == 503 and result.payload["state"] is None and result.payload["generated_response"] is None
    assert _operation(database, result.payload["operation_id"])[:4] == (None, "FAILED", "NOT_REQUESTED", "INTERNAL_FAILURE")


@pytest.mark.requires_db
def test_grounded_revocation_right_before_send_prevents_sending_and_leakage(database) -> None:
    _grant(database)
    _document(database)
    principal = _principal(database)

    class RevokedBeforeSend:
        sent = 0

        def generate(self, _messages, *, before_send, response_format=None):
            _grant(database, active=False)
            before_send()
            self.sent += 1
            return _contract()

    provider = RevokedBeforeSend()
    try:
        result = _service(database, provider).execute(principal=principal, query="¿Cuál es el plazo del contrato sintético?")
    finally:
        _grant(database)
    assert provider.sent == 0
    assert result.status_code == 403 and result.payload["state"] == "SIN_AUTORIZACION"
    assert result.payload["fragments"] == [] and result.payload["citations"] == [] and result.payload["generated_response"] is None


class _OrthogonalEncoder(_Encoder):
    """Consulta sin relación con el corpus (coseno 0) y con baja probabilidad de decisión."""

    def encode_query(self, _query):
        vector = [0.0] * 1024
        vector[851] = 1.0
        return vector


@pytest.mark.requires_db
@pytest.mark.parametrize("query", ["¿Cuál es la capital de Japón?", "Dame una receta de enchiladas verdes"])
def test_out_of_domain_is_state_three_without_provider(database, query) -> None:
    from app.rag.gates import gates_config
    assert gates_config().probe.probability(_OrthogonalEncoder().encode_query(query)) < gates_config().probe.threshold
    _grant(database)
    _document(database)
    principal = _principal(database)
    provider = _Provider()
    security = SecurityService(SecurityRepository(database["runtime"]))
    service = RagApplicationService(conninfo=database["runtime"], security=security,
                                    retrieval=RetrievalService(security, encoder=_OrthogonalEncoder()), provider=provider)
    result = service.execute(principal=principal, query=query)
    assert result.status_code == 200 and result.payload["state"] == "SIN_EVIDENCIA"
    assert result.payload["fragments"] == [] and provider.calls == 0


# Importancias registradas con BGE-M3 real en el último confirmation set: reproducen la decisión
# de los gates locales (candidatos a generación) sin cargar el modelo en la prueba.
_RESIDUAL_NEGATIVES = {
    "LN14": ("¿Cuánto suman los intereses moratorios reclamados a Distribuidora Zeta?",
             "Juicio ordinario mercantil Zeta 88/2026 promovido por Industrias Ficticias Norte contra Distribuidora Zeta por falta de pago de facturas.\n\n"
             "Monto: se reclama el pago de dos millones trescientos mil pesos por concepto de mercancía entregada y no pagada, más intereses moratorios.",
             {"distribuidora": 0.0894, "intereses": 0.1164, "moratorios": 0.1161, "reclamados": 0.0678, "suman": 0.046, "zeta": 0.1272}),
    "LN18": ("¿Cuánto tiempo tiene auditoría interna para revisar las reservaciones de viaje?",
             "Sección 2. Hospedaje\nEl hospedaje deberá reservarse por conducto del área de compras con al menos cinco días de anticipación, salvo viajes "
             "urgentes. El área de auditoría interna podrá revisar en cualquier momento las reservaciones y solicitar la documentación de cada estancia.",
             {"auditoría": 0.0906, "interna": 0.0526, "reservaciones": 0.0549, "revisar": 0.0219, "tiempo": 0.0205, "viaje": 0.056}),
    "LN21": ("¿Qué legislación rige el reglamento de viáticos Mu?",
             "Reglamento interno de viáticos Mu de Industrias Ficticias Norte, aplicable a los viajes de trabajo del personal.",
             {"legislación": 0.0597, "reglamento": 0.0948, "rige": 0.0519, "viáticos": 0.1878}),
    "LN33": ("¿Cuántos días hábiles tiene el área de compras para confirmar una reservación?",
             "Plazo de entrega: el Proveedor deberá entregar cada pedido dentro de los diez días hábiles siguientes a la recepción de la orden de compra.",
             {"compras": 0.077, "confirmar": 0.0336, "días": 0.1304, "hábiles": 0.0353, "reservación": 0.0537, "área": 0.0512}),
}


@pytest.mark.requires_db
@pytest.mark.parametrize("case", sorted(_RESIDUAL_NEGATIVES))
def test_residual_negatives_reach_provider_only_with_authorized_evidence_and_abstention_is_state_two(database, case, monkeypatch) -> None:
    """LN14/LN18/LN21/LN33 superan los gates locales; el proveedor que respeta el contrato se abstiene (Estado 2)."""
    from app.rag import gates
    query, text, importance = _RESIDUAL_NEGATIVES[case]
    monkeypatch.setattr(gates, "term_importance", lambda *_a, **_k: dict(importance))
    _grant(database)
    with psycopg.connect(database["owner"], autocommit=True) as connection:
        connection.execute("UPDATE app.document SET active_version_id=NULL WHERE active_version_id IS NOT NULL")
    _document_with_text(database, text)
    principal = _principal(database)
    provider = _Provider(_contract("INSUFFICIENT", None, ()))
    result = _service(database, provider).execute(principal=principal, query=query)
    assert provider.calls == 1, "el caso debía superar los gates locales como candidato a generación"
    assert result.payload["state"] == "EVIDENCIA_INSUFICIENTE" and result.payload["generated_response"] is None
    assert result.payload["generation_status"] == "ABSTAINED"
    sent = provider.requests[0][0][1]["content"]
    assert "[E1]" in sent and "[E2]" not in sent
    # Una afirmación SUPPORTED con un handle fuera del conjunto entregado tampoco produce Estado 1.
    lying = _Provider(_contract("SUPPORTED", "Dato no sustentado [E2].", ("E2",)))
    assert _service(database, lying).execute(principal=principal, query=query).payload["state"] is None


@pytest.mark.requires_db
def test_qp05_equivalent_supported_with_valid_citation_reaches_state_one(database, monkeypatch) -> None:
    from app.rag import gates
    monkeypatch.setattr(gates, "term_importance", lambda *_a, **_k: {"arrendar": 0.0755, "beta": 0.1752, "bodega": 0.1166,
                                                                       "importe": 0.037, "mensual": 0.0633, "paga": 0.0372})
    text = ("Contrato de arrendamiento Beta sobre la bodega ubicada en el Parque Industrial Ficticio, nave 7. Arrendador: Inmobiliaria Beta.\n\n"
            "Renta: el arrendatario pagará una renta mensual de ochenta mil pesos más IVA dentro de los primeros cinco días de cada mes.")
    _grant(database)
    with psycopg.connect(database["owner"], autocommit=True) as connection:
        connection.execute("UPDATE app.document SET active_version_id=NULL WHERE active_version_id IS NOT NULL")
    fragment = _document_with_text(database, text)
    principal = _principal(database)
    provider = _Provider(_contract("SUPPORTED", "La renta mensual es de ochenta mil pesos más IVA [E1].", ("E1",)))
    result = _service(database, provider).execute(principal=principal, query="¿Qué importe mensual se paga por arrendar la bodega Beta?")
    assert provider.calls == 1
    assert result.status_code == 200 and result.payload["state"] == "EVIDENCIA_SUFICIENTE"
    assert [item["fragment_id"] for item in result.payload["citations"]] == [fragment]



# --- Elegibilidad de la evidencia antes del proveedor (LP28) -------------------------------------

_SCAN_TEXT = "Contrato escaneado de prueba DOC-SCAN-2026-001. Fecha del documento: 06/10/2026. Plazo de entrega de diez días."


@pytest.fixture
def eligibility(database, monkeypatch):
    """Importancia fija sobre «plazo» para aislar la elegibilidad de Gate 3 (sin modelo de embeddings)."""
    from app.rag import gates
    monkeypatch.setattr(gates, "term_importance", lambda *_a, **_k: {"plazo": 0.2})
    _grant(database)
    _isolate(database)
    return database


def _sent_handles(provider):
    return provider.requests[0][1]["json_schema"]["schema"]["properties"]["evidence_handles"]["items"]["enum"]


@pytest.mark.requires_db
def test_eligibility_case_a_only_complete_fragment_reaches_provider_and_state_one(eligibility) -> None:
    complete = _document_with_text(eligibility, _SCAN_TEXT, name="Copia fechada")
    principal = _principal(eligibility)
    provider = _Provider(_contract("SUPPORTED", "El plazo es de diez días [E1].", ("E1",)))
    result = _service(eligibility, provider).execute(principal=principal, query="¿Cuál es el plazo de entrega?")
    assert provider.calls == 1 and _sent_handles(provider) == ["E1"]
    assert result.payload["state"] == "EVIDENCIA_SUFICIENTE"
    assert [item["fragment_id"] for item in result.payload["citations"]] == [complete]


@pytest.mark.requires_db
def test_eligibility_case_b_only_incomplete_fragment_is_state_two_without_provider(eligibility) -> None:
    _document_with_text(eligibility, _SCAN_TEXT, name="Copia sin fecha", document_date=None)
    principal = _principal(eligibility)
    provider = _Provider()
    result = _service(eligibility, provider).execute(principal=principal, query="¿Cuál es el plazo de entrega?")
    assert provider.calls == 0
    assert result.status_code == 200 and result.payload["state"] == "EVIDENCIA_INSUFICIENTE"
    assert result.payload["fragments"] and all(item["usage"] == "REFERENCE" for item in result.payload["fragments"])


@pytest.mark.requires_db
def test_eligibility_service_guard_without_citable_evidence_never_calls_provider(eligibility) -> None:
    """Aunque un candidato llegara al servicio solo con evidencia incompleta, no hay llamada y es Estado 2."""
    from app.rag.models import ProcessingOutcome
    _document_with_text(eligibility, _SCAN_TEXT, name="Copia sin fecha", document_date=None)
    principal = _principal(eligibility)
    provider = _Provider()
    service = _service(eligibility, provider)
    original = service.retrieval.retrieve
    service.retrieval.retrieve = lambda connection, context: replace(original(connection, context), state=ProcessingOutcome.GENERATION_CANDIDATE)
    result = service.execute(principal=principal, query="¿Cuál es el plazo de entrega?")
    assert provider.calls == 0 and result.payload["state"] == "EVIDENCIA_INSUFICIENTE"
    assert result.payload["generation_status"] == "NOT_REQUESTED" and result.payload["fragments"]


@pytest.mark.requires_db
@pytest.mark.parametrize("incomplete_text", [_SCAN_TEXT, "Plazo de entrega: diez días naturales desde la orden, según la copia sin fecha."],
                         ids=["case-c-duplicados", "case-e-incompleto-muy-relevante"])
def test_eligibility_mixed_complete_incomplete_sends_only_complete(eligibility, incomplete_text) -> None:
    """Casos C y E (y regresión LP28): el proveedor recibe solo el fragmento con cita completa."""
    complete = _document_with_text(eligibility, _SCAN_TEXT, name="Copia fechada")
    incomplete = _document_with_text(eligibility, incomplete_text, name="Copia sin fecha", document_date=None)
    principal = _principal(eligibility)
    provider = _Provider(_contract("SUPPORTED", "El plazo es de diez días [E1].", ("E1",)))
    result = _service(eligibility, provider).execute(principal=principal, query="¿Cuál es el plazo de entrega?")
    assert provider.calls == 1 and _sent_handles(provider) == ["E1"]
    sent = provider.requests[0][0][1]["content"]
    assert "Copia fechada" in sent and "Copia sin fecha" not in sent and sent.count("[E") == 1
    assert result.payload["state"] == "EVIDENCIA_SUFICIENTE"
    assert [item["fragment_id"] for item in result.payload["citations"]] == [complete]
    # El Estado 1 conserva exactamente la evidencia enviada: la copia incompleta no aparece como cita.
    assert all(item["fragment_id"] != incomplete for item in result.payload["fragments"])


@pytest.mark.requires_db
def test_eligibility_mixed_set_abstention_keeps_all_relevant_fragments_as_reference(eligibility) -> None:
    complete = _document_with_text(eligibility, _SCAN_TEXT, name="Copia fechada")
    incomplete = _document_with_text(eligibility, _SCAN_TEXT, name="Copia sin fecha", document_date=None)
    principal = _principal(eligibility)
    provider = _Provider(_contract("INSUFFICIENT", None, ()))
    result = _service(eligibility, provider).execute(principal=principal, query="¿Cuál es el plazo de entrega?")
    assert _sent_handles(provider) == ["E1"]
    assert result.payload["state"] == "EVIDENCIA_INSUFICIENTE" and result.payload["generation_status"] == "ABSTAINED"
    assert {item["fragment_id"] for item in result.payload["fragments"]} == {complete, incomplete}


@pytest.mark.requires_db
def test_eligibility_case_d_two_complete_fragments_are_both_eligible(eligibility) -> None:
    _document_with_text(eligibility, _SCAN_TEXT, name="Contrato A")
    _document_with_text(eligibility, "Anexo B: el plazo de entrega se confirma por escrito.", name="Anexo B")
    principal = _principal(eligibility)
    provider = _Provider(_contract("SUPPORTED", "El plazo es de diez días [E1].", ("E1",)))
    _service(eligibility, provider).execute(principal=principal, query="¿Cuál es el plazo de entrega?")
    assert _sent_handles(provider) == ["E1", "E2"]


@pytest.mark.requires_db
def test_eligibility_case_f_revocation_before_send_with_mixed_set_sends_nothing(eligibility) -> None:
    _document_with_text(eligibility, _SCAN_TEXT, name="Copia fechada")
    _document_with_text(eligibility, _SCAN_TEXT, name="Copia sin fecha", document_date=None)
    principal = _principal(eligibility)

    class RevokedBeforeSend:
        sent = 0

        def generate(self, _messages, *, before_send, response_format=None):
            _grant(eligibility, active=False)
            before_send()
            self.sent += 1
            return _contract()

    provider = RevokedBeforeSend()
    try:
        result = _service(eligibility, provider).execute(principal=principal, query="¿Cuál es el plazo de entrega?")
    finally:
        _grant(eligibility)
    assert provider.sent == 0
    assert result.payload["state"] == "SIN_AUTORIZACION" and result.payload["fragments"] == []


@pytest.mark.requires_db
def test_eligibility_case_g_supported_citing_unsent_incomplete_handle_is_contract_failure(eligibility) -> None:
    _document_with_text(eligibility, _SCAN_TEXT, name="Copia fechada")
    _document_with_text(eligibility, _SCAN_TEXT, name="Copia sin fecha", document_date=None)
    principal = _principal(eligibility)
    provider = _Provider(_contract("SUPPORTED", "06/10/2026", ("E1", "E2")))   # E2 no se envió
    result = _service(eligibility, provider).execute(principal=principal, query="¿Cuál es el plazo de entrega?")
    assert _sent_handles(provider) == ["E1"]
    assert result.status_code == 503 and result.payload["state"] is None
    assert _operation(eligibility, result.payload["operation_id"])[:4] == (None, "FAILED", "FAILED", "INVALID_PROVIDER_OUTPUT")

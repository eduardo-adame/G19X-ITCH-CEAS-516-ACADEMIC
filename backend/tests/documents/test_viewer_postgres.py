"""SRS_REQUIRED: predicado, rollback y concurrencia reales en PostgreSQL aislado."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
import hashlib
import base64
import secrets
import os
import subprocess
from threading import Event, Thread
from uuid import uuid4

import psycopg
from psycopg.conninfo import conninfo_to_dict
import pytest

from app.documents.viewer_models import ViewerNotFound, ViewerQuery, ViewerVersionChanged
from app.documents.viewer_repository import ViewerRepository
from app.documents.viewer_service import ViewerService
from app.security.models import AuthenticatedPrincipal, AuditPersistenceError, AuthenticationError, ROLE_PERMISSIONS
from app.security.repository import SecurityRepository
from app.security.service import SecurityService
from app.storage.abstraction import StorageAbstraction
from app.security.tokens import JwtService
from app.documents.viewer_api import router, viewer_service_for
from fastapi import FastAPI
from fastapi.testclient import TestClient


def owner_scalar(database, sql):
    # Con VIEWER_TEST_OWNER_CONNINFO la lectura privilegiada usa el mismo clúster aislado de la prueba;
    # sin ella se conserva la lectura mediante el contenedor PostgreSQL local.
    owner = os.getenv("VIEWER_TEST_OWNER_CONNINFO", "")
    if owner:
        if conninfo_to_dict(owner).get("dbname") != database:
            pytest.fail("La conexión de propietario debe apuntar a la misma base aislada del visor")
        with psycopg.connect(owner) as connection:
            row = connection.execute(sql).fetchone()
        return "" if row is None or row[0] is None else str(row[0])
    result = subprocess.run(
        ["docker", "exec", "riesgo-legal-postgres", "psql", "-U", "app", "-d", database,
         "-v", "ON_ERROR_STOP=1", "-tAc", sql], capture_output=True, text=True, check=True)
    return result.stdout.strip()


@pytest.fixture
def fixture(tmp_path):
    conninfo = os.getenv("VIEWER_TEST_CONNINFO", "")
    if not conninfo:
        pytest.skip("SRS_REQUIRED: VIEWER_TEST_CONNINFO ausente; requiere PostgreSQL real aislado")
    database = conninfo_to_dict(conninfo).get("dbname", "")
    if not database.startswith("riesgo_legal_viewer_test_"):
        pytest.fail("Se requiere la base nueva inequívocamente aislada del visor")
    repo = SecurityRepository(conninfo)
    security = SecurityService(repo)
    viewer = ViewerService(ViewerRepository(repo), security, StorageAbstraction(tmp_path))
    account, session = uuid4(), uuid4()
    prefix = "synthetic-" + account.hex
    with repo.transaction() as c:
        c.execute("UPDATE app.document_scope_grant SET active=false WHERE role_id='JURIDICO'")
        c.execute("INSERT INTO app.user_account (id, username, display_name, password_hash) VALUES (%s,%s,'Synthetic','synthetic-not-a-login')", (account, prefix))
        c.execute("INSERT INTO app.user_role (user_id,role_id) VALUES (%s,'JURIDICO')", (account,))
        c.execute("INSERT INTO app.access_session (id,user_id,refresh_token_sha256,authorization_version,state,expires_at) VALUES (%s,%s,%s,1,'ACTIVE',%s)",
                  (session, account, hashlib.sha256(session.bytes).digest(), datetime.now(UTC) + timedelta(hours=1)))
    principal = AuthenticatedPrincipal(account, session, prefix, 1, frozenset({"JURIDICO"}), ROLE_PERMISSIONS["JURIDICO"])
    return dict(repo=repo, security=security, service=viewer, principal=principal, prefix=prefix,
                database=database, root=tmp_path, conninfo=conninfo)


def document(fixture, *, suffix="document", family="CONTRATOS_DOCUMENTOS", kind="PDF", allow=True,
             pending=False, candidate=True, state="LISTA", accepted=True):
    file_id, object_id, version_id = uuid4(), uuid4(), uuid4()
    locator = file_id.hex + ".pdf"
    payload = b"%PDF-1.7\nSynthetic source only\n%%EOF"
    (fixture["root"] / locator).write_bytes(payload)
    name = fixture["prefix"] + suffix
    with fixture["repo"].transaction() as c:
        c.execute("INSERT INTO app.stored_object (id,locator,sha256,mime_type,byte_size,original_name) VALUES (%s,%s,%s,'application/pdf',%s,'synthetic.pdf')",
                  (object_id, locator, hashlib.sha256(payload).digest(), len(payload)))
        c.execute("""INSERT INTO app.ingest_file
            (id,stored_object_id,source_family,exchange_format,state,operation_id,correlation_id,
             declared_extension,detected_format,format_classification,technical_result,safe_cause_code,
             declared_name,source_locator,source_revision,actor_identifier,content_sha256)
            VALUES (%s,%s,%s,%s,'COMPLETADO',%s,%s,%s,%s,'SUPPORTED',%s,%s,
                    'synthetic.pdf',%s,1,'synthetic',%s)""",
                  (file_id, object_id, family, kind, uuid4(), uuid4(), kind.lower(), kind,
                   "ACCEPTED" if accepted else "REJECTED", None if accepted else "SYNTHETIC_REJECTION",
                   locator, hashlib.sha256(payload).digest()))
        if candidate:
            c.execute("INSERT INTO app.document_candidate (ingest_file_id,processing_state,native_text) VALUES (%s,'NATIVE_TEXT','Synthetic complete text')", (file_id,))
        c.execute("INSERT INTO app.document (id_documento,name,document_type,source_family) VALUES (%s,%s,%s,%s)",
                  (str(file_id), name, kind, family))
        text = "Synthetic complete consolidated text " * 300
        c.execute("""INSERT INTO app.document_version
            (id,id_documento,version_number,stored_object_id,processing_state,consolidated_text,content_sha256,
             operation_id,correlation_id,completed_at) VALUES (%s,%s,1,%s,%s,%s,%s,%s,%s,%s)""",
                  (version_id, str(file_id), object_id, state, text, hashlib.sha256(text.encode()).digest(),
                   uuid4(), uuid4(), datetime.now(UTC) if state in {"LISTA", "RECHAZADA", "FALLIDA"} else None))
        c.execute("UPDATE app.document SET active_version_id=%s WHERE id_documento=%s", (version_id, str(file_id)))
        if allow:
            c.execute("INSERT INTO app.document_exception (id,id_documento,user_id,decision) VALUES (%s,%s,%s,'ALLOW')",
                      (uuid4(), str(file_id), fixture["principal"].account_id))
        if pending:
            quarantine(c, file_id, object_id)
    return dict(id=str(file_id), file_id=file_id, object_id=object_id, version=version_id,
                text=text, name=name, payload=payload)


def quarantine(c, file_id, object_id):
    c.execute("""INSERT INTO app.quarantine_item (id,ingest_file_id,cause_code,state,original_object_id,
        operation_id,correlation_id) VALUES (%s,%s,'SYNTHETIC','Pendiente',%s,%s,%s)""",
              (uuid4(), file_id, object_id, uuid4(), uuid4()))


def page(fixture, **filters):
    return fixture["service"].catalog(ViewerQuery(q=fixture["prefix"], **filters), fixture["principal"])


def event_count(fixture):
    return int(owner_scalar(fixture["database"], "SELECT count(*) FROM audit.event WHERE actor_user_id='" + str(fixture["principal"].account_id) + "'"))


def test_pg_default_deny_and_user_allow_then_explicit_deny(fixture):
    hidden = document(fixture, allow=False)
    assert page(fixture).items == []
    with pytest.raises(ViewerNotFound):
        fixture["service"].read(hidden["id"], None, fixture["principal"])
    visible = document(fixture)
    assert [item.document_id for item in page(fixture).items] == [visible["id"]]
    with fixture["repo"].transaction() as c:
        c.execute("UPDATE app.document_exception SET decision='DENY' WHERE id_documento=%s", (visible["id"],))
    assert page(fixture).items == []
    with pytest.raises(ViewerNotFound):
        fixture["service"].read(visible["id"], visible["version"], fixture["principal"])


def test_pg_family_grant_role_allow_and_deny_precedence(fixture):
    visible = document(fixture, allow=False)
    other = document(fixture, family="LITIGIOS", allow=False)
    with fixture["repo"].transaction() as c:
        c.execute("INSERT INTO app.document_scope_grant (id,role_id,source_family) VALUES (%s,'JURIDICO','CONTRATOS_DOCUMENTOS') ON CONFLICT (role_id,source_family) DO UPDATE SET active=true", (uuid4(),))
        c.execute("INSERT INTO app.document_exception (id,id_documento,role_id,decision) VALUES (%s,%s,'JURIDICO','ALLOW')", (uuid4(), other["id"]))
        c.execute("INSERT INTO app.document_exception (id,id_documento,user_id,decision) VALUES (%s,%s,%s,'DENY')", (uuid4(), visible["id"], fixture["principal"].account_id))
    try:
        assert [item.document_id for item in page(fixture).items] == [other["id"]]
        with pytest.raises(ViewerNotFound):
            fixture["service"].read(visible["id"], None, fixture["principal"])
    finally:
        with fixture["repo"].transaction() as c:
            c.execute("UPDATE app.document_scope_grant SET active=false WHERE role_id='JURIDICO' AND source_family='CONTRATOS_DOCUMENTOS'")
            c.execute("UPDATE app.document_exception SET active=false,revoked_at=CURRENT_TIMESTAMP WHERE id_documento=%s AND role_id='JURIDICO'", (other["id"],))


@pytest.mark.parametrize("options", [{"pending": True}, {"candidate": False}, {"state": "RECHAZADA"}, {"accepted": False}])
def test_pg_ineligible_sources_are_hidden_even_with_allow(fixture, options):
    doc = document(fixture, **options)
    assert page(fixture).items == []
    with pytest.raises(ViewerNotFound):
        fixture["service"].read(doc["id"], None, fixture["principal"])


def test_pg_null_date_text_and_pdf_without_any_index_or_rag(fixture):
    doc = document(fixture)
    result = fixture["service"].read(doc["id"], doc["version"], fixture["principal"])
    assert result.text == doc["text"] and result.document_date is None
    assert fixture["service"].read(doc["id"], doc["version"], fixture["principal"], original=True) == doc["payload"]
    assert event_count(fixture) == 2
    with fixture["repo"].transaction() as c:
        assert c.execute("SELECT count(*) AS n FROM app.document_chunk WHERE document_version_id=%s", (doc["version"],)).fetchone()["n"] == 0
        assert c.execute("SELECT count(*) AS n FROM app.rag_operation WHERE user_id=%s", (fixture["principal"].account_id,)).fetchone()["n"] == 0
    value = owner_scalar(fixture["database"], "SELECT resource_identifier FROM audit.event WHERE correlation_id='" + str(result.correlation_id) + "'")
    assert value == '["' + doc["id"] + '","' + str(doc["version"]) + '"]'


def test_pg_literal_search_keyset_and_filters(fixture):
    first = document(fixture, suffix="%_literal", kind="DOCX")
    document(fixture, suffix="ordinary")
    p = fixture["service"].catalog(ViewerQuery(q=fixture["prefix"] + "%_", document_type="DOCX"), fixture["principal"])
    assert [x.document_id for x in p.items] == [first["id"]]
    p = page(fixture, limit=1)
    assert len(p.items) == 1 and p.next_cursor
    second = page(fixture, limit=1, cursor=p.next_cursor)
    assert len(second.items) == 1 and second.items[0].document_id != p.items[0].document_id


def test_pg_stale_selection_and_invalidated_document(fixture):
    doc = document(fixture)
    with pytest.raises(ViewerVersionChanged):
        fixture["service"].read(doc["id"], uuid4(), fixture["principal"])
    with fixture["repo"].transaction() as c:
        c.execute("UPDATE app.document SET active_version_id=NULL,invalidated_at=CURRENT_TIMESTAMP WHERE id_documento=%s", (doc["id"],))
    assert page(fixture).items == []


@pytest.mark.parametrize("mismatch", ["family", "format", "source_record"])
def test_pg_inconsistent_provenance_never_exposes_document(fixture, mismatch):
    doc = document(fixture)
    with fixture["repo"].transaction() as c:
        if mismatch == "family":
            c.execute("UPDATE app.ingest_file SET source_family='LITIGIOS' WHERE id=%s", (doc["file_id"],))
        elif mismatch == "format":
            c.execute("UPDATE app.ingest_file SET exchange_format='DOCX' WHERE id=%s", (doc["file_id"],))
        else:
            other = document(fixture, suffix="other")
            source_id = uuid4()
            c.execute("INSERT INTO app.source_record (id,ingest_file_id,source_sheet,record_sha256,extraction_state) VALUES (%s,%s,'SYNTHETIC',%s,'EXTRAIDO')", (source_id, other["file_id"], bytes(32)))
            c.execute("UPDATE app.document_version SET source_record_id=%s WHERE id=%s", (source_id, doc["version"]))
    with pytest.raises(ViewerNotFound):
        fixture["service"].read(doc["id"], doc["version"], fixture["principal"])


def test_pg_http_authentication_scope_content_pdf_and_revocation_without_security_override(fixture):
    doc = document(fixture)
    hidden = document(fixture, suffix="hidden", allow=False)
    principal = fixture["principal"]
    jwt = JwtService(issuer="synthetic-viewer", audience="synthetic-viewer", active_kid="synthetic",
                     keyring={"synthetic": base64.urlsafe_b64encode(secrets.token_bytes(32)).decode()})
    security = SecurityService(fixture["repo"], jwt)
    service = ViewerService(ViewerRepository(fixture["repo"]), security, StorageAbstraction(fixture["root"]))
    app = FastAPI()
    app.state.security_service = security
    app.include_router(router, prefix="/api/documents")
    app.dependency_overrides[viewer_service_for] = lambda: service
    token = jwt.issue(account_id=principal.account_id, session_id=principal.session_id, authorization_version=1)
    with TestClient(app) as client:
        headers = {"Authorization": "Bearer " + token}
        p = client.get("/api/documents/viewer", params={"q": fixture["prefix"]}, headers=headers)
        assert p.status_code == 200 and [x["document_id"] for x in p.json()["items"]] == [doc["id"]]
        detail = client.get("/api/documents/viewer/" + doc["id"], params={"version_id": str(doc["version"])}, headers=headers)
        assert detail.status_code == 200 and detail.json()["text"] == doc["text"]
        original = client.get("/api/documents/viewer/" + doc["id"] + "/original", params={"version_id": str(doc["version"])}, headers=headers)
        assert original.status_code == 200 and original.content == doc["payload"]
        denied = client.get("/api/documents/viewer/" + hidden["id"], headers=headers)
        absent = client.get("/api/documents/viewer/absent-synthetic", headers=headers)
        assert denied.status_code == absent.status_code == 404 and denied.json() == absent.json()
        with fixture["repo"].transaction() as c:
            c.execute("UPDATE app.user_account SET authorization_version=2 WHERE id=%s", (principal.account_id,))
        revoked = client.get("/api/documents/viewer/" + doc["id"], headers=headers)
        assert revoked.status_code == 401 and doc["text"] not in revoked.text
        assert revoked.headers["cache-control"] == "no-store"


def test_pg_functional_denial_is_audited_without_identifier(fixture):
    doc = document(fixture)
    with fixture["repo"].transaction() as c:
        c.execute("UPDATE app.user_role SET active=false,revoked_at=CURRENT_TIMESTAMP WHERE user_id=%s", (fixture["principal"].account_id,))
    from app.security.models import AuthorizationError
    with pytest.raises(AuthorizationError):
        fixture["service"].read(doc["id"], None, fixture["principal"])
    assert owner_scalar(fixture["database"], "SELECT action||':'||coalesce(resource_identifier,'NULL') FROM audit.event WHERE actor_user_id='" + str(fixture["principal"].account_id) + "'") == "AUTHORIZATION_DENIED:NULL"


@pytest.mark.parametrize("failure", ["insert", "commit"])
def test_pg_real_audit_insert_and_deferred_commit_failure_roll_back(fixture, failure):
    doc = document(fixture)
    class FailingSecurityRepository(SecurityRepository):
        def write_audit_event(self, connection, **event):
            if failure == "insert":
                event["resource_type"] = ""
            super().write_audit_event(connection, **event)
            if failure == "commit":
                connection.execute("UPDATE app.document SET active_version_id=%s WHERE id_documento=%s", (uuid4(), doc["id"]))
    failing = FailingSecurityRepository(fixture["conninfo"])
    service = ViewerService(ViewerRepository(failing), SecurityService(failing), StorageAbstraction(fixture["root"]))
    with pytest.raises(AuditPersistenceError):
        service.read(doc["id"], doc["version"], fixture["principal"])
    assert event_count(fixture) == 0
    assert page(fixture).items[0].document_version_id == doc["version"]


@pytest.mark.parametrize("race", ["revocation", "version", "quarantine"])
def test_pg_locks_order_revocation_version_and_quarantine_before_delivery(fixture, race):
    doc = document(fixture)
    locked, release, rival_started, rival_done = Event(), Event(), Event(), Event()
    result, errors = [], []
    class PausedRepository(ViewerRepository):
        calls = 0
        def content(self, *args):
            row = super().content(*args)
            self.calls += 1
            if self.calls == 1:
                locked.set()
                if not release.wait(5): raise RuntimeError("Test coordination timeout")
            return row
    reader = ViewerService(PausedRepository(fixture["repo"]), fixture["security"], StorageAbstraction(fixture["root"]))
    def read():
        try: result.append(reader.read(doc["id"], doc["version"], fixture["principal"]))
        except Exception as exc: errors.append(type(exc).__name__)
    def change():
        try:
            with fixture["repo"].transaction() as c:
                rival_started.set()
                if race == "revocation":
                    c.execute("UPDATE app.user_account SET authorization_version=authorization_version+1 WHERE id=%s", (fixture["principal"].account_id,))
                elif race == "version":
                    c.execute("UPDATE app.document SET active_version_id=NULL WHERE id_documento=%s", (doc["id"],))
                else:
                    quarantine(c, doc["file_id"], doc["object_id"])
            rival_done.set()
        except Exception as exc: errors.append(type(exc).__name__)
    read_thread, rival_thread = Thread(target=read), Thread(target=change)
    read_thread.start()
    assert locked.wait(3)
    rival_thread.start()
    try:
        assert rival_started.wait(3)
        assert not rival_done.wait(0.25)
    finally:
        release.set()
        read_thread.join(5)
        rival_thread.join(5)
    assert not read_thread.is_alive() and not rival_thread.is_alive() and not errors
    assert len(result) == 1 and result[0].text == doc["text"] and rival_done.is_set()
    if race == "revocation":
        with pytest.raises(AuthenticationError):
            fixture["service"].read(doc["id"], doc["version"], fixture["principal"])
    else:
        with pytest.raises(ViewerNotFound):
            fixture["service"].read(doc["id"], doc["version"], fixture["principal"])

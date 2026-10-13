"""SRS_REQUIRED y ROBUSTNESS: coordinación de lectura sin RAG ni proveedor."""
from contextlib import contextmanager
from dataclasses import replace
from datetime import UTC, datetime
import hashlib
import base64
import json
from uuid import uuid4

import pytest

from app.documents.viewer_models import ViewerQuery, ViewerNotFound, ViewerVersionChanged, ViewerUnavailable, validate_document_id
from app.documents.viewer_repository import escape_like
from app.documents.viewer_service import ViewerService, decode_cursor, encode_cursor
from app.security.models import AuthenticatedPrincipal, AuditPersistenceError, AuthorizationError
from app.storage.abstraction import StorageAbstraction


@pytest.fixture
def principal():
    return AuthenticatedPrincipal(uuid4(), uuid4(), "synthetic-reader", 1,
                                  frozenset({"JURIDICO"}), frozenset({"document.query"}))


@pytest.fixture
def row():
    return dict(document_id="synthetic-document", document_version_id=uuid4(), version_number=1,
                document_name="Documento sintético", document_type="PDF", source_family="CONTRATOS_DOCUMENTOS",
                document_date=None, representation="PDF_ORIGINAL", text_available=True,
                text="Texto sintético completo " * 1000, created_at=datetime.now(UTC),
                locator="source.pdf", mime_type="application/pdf", byte_size=0, sha256=bytes(32))


class Repository:
    def __init__(self, row):
        self.row = row
        self.rows = [row]
        self.events = []
        self.committed = []
        self.commit_fails = False
        self.insert_fails = False

    @contextmanager
    def transaction(self):
        start = len(self.events)
        try:
            yield self
            if self.commit_fails:
                raise AuditPersistenceError
            self.committed.extend(self.events[start:])
        except Exception:
            del self.events[start:]
            raise

    def content(self, connection, scope, document_id):
        return self.row

    def catalog(self, connection, scope, query, after):
        return self.rows

    def write_audit_event(self, connection, **event):
        if self.insert_fails:
            raise AuditPersistenceError
        self.events.append(event)


class Security:
    def __init__(self, repository):
        self.repository = repository
        self.calls = 0
        self.deny_at = None

    def revalidate_functional_access(self, connection, principal, capability):
        assert capability == "document.query"
        self.calls += 1
        if self.calls == self.deny_at:
            raise AuthorizationError
        return principal

    def authorized_document_scope(self, connection, principal):
        return object()


@pytest.fixture
def setup(row, tmp_path):
    repository = Repository(row)
    security = Security(repository)
    service = ViewerService(repository, security, StorageAbstraction(tmp_path), max_file_bytes=1024)
    return service, repository, security, tmp_path


def test_complete_text_and_null_date_delivered_only_after_success_commit(setup, principal, row):
    service, repo, security, _ = setup
    result = service.read(row["document_id"], row["document_version_id"], principal)
    assert result.text == row["text"] and result.document_date is None
    assert security.calls == 2 and len(repo.committed) == 1
    event = repo.committed[0]
    assert event["action"] == "DOCUMENT_VIEW" and event["resource_type"] == "DOCUMENT_VERSION"
    assert event["resource_identifier"] == json.dumps(
        [row["document_id"], str(row["document_version_id"])], ensure_ascii=True, separators=(",", ":"))
    assert event["correlation_id"] == result.correlation_id
    assert row["text"] not in str(event) and row["document_name"] not in str(event)


@pytest.mark.parametrize("failure", ["insert_fails", "commit_fails"])
def test_audit_insert_and_commit_fail_closed(setup, principal, row, failure):
    service, repo, _, _ = setup
    setattr(repo, failure, True)
    with pytest.raises(AuditPersistenceError):
        service.read(row["document_id"], None, principal)
    assert not repo.committed and not repo.events


def test_revalidation_denial_delivers_no_content_and_generic_denial_audit(setup, principal, row):
    service, repo, security, _ = setup
    security.deny_at = 2
    with pytest.raises(AuthorizationError):
        service.read(row["document_id"], None, principal)
    assert len(repo.committed) == 1
    assert repo.committed[0]["action"] == "AUTHORIZATION_DENIED"
    assert repo.committed[0]["resource_identifier"] is None


def test_hidden_resource_and_stale_version_do_not_audit_success(setup, principal):
    service, repo, _, _ = setup
    with pytest.raises(ViewerVersionChanged):
        service.read("synthetic-document", uuid4(), principal)
    repo.row = None
    with pytest.raises(ViewerNotFound):
        service.read("synthetic-document", None, principal)
    assert not repo.committed


def test_catalog_has_exact_metadata_no_text_storage_or_audit(setup, principal):
    service, repo, _, _ = setup
    result = service.catalog(ViewerQuery(), principal)
    assert result.items[0].document_date is None
    assert not {"text", "locator", "sha256", "byte_size", "created_at"} & result.items[0].model_dump().keys()
    assert not repo.committed


def test_cursor_binds_identity_version_filters_and_preserves_keyset(principal, row):
    query = ViewerQuery(q="%literal_", source_family="CONTRATOS_DOCUMENTOS", limit=1)
    encoded = encode_cursor(row, query, principal)
    assert decode_cursor(query.model_copy(update={"cursor": encoded}), principal) == (
        row["created_at"], row["document_version_id"])
    for identity, filters in [(replace(principal, account_id=uuid4()), query),
                              (replace(principal, authorization_version=2), query),
                              (principal, ViewerQuery(q="different"))]:
        with pytest.raises(ValueError):
            decode_cursor(filters.model_copy(update={"cursor": encoded}), identity)


@pytest.mark.parametrize("cursor", ["!", "e30", "WzFd", "a" * 2049])
def test_corrupt_cursor_is_rejected(cursor, principal):
    with pytest.raises(ValueError):
        decode_cursor(ViewerQuery().model_copy(update={"cursor": cursor}), principal)


@pytest.mark.parametrize("invalid", [[], 7, {}, None])
def test_cursor_uuid_requires_string_even_with_matching_binding(principal, row, invalid):
    query = ViewerQuery()
    original = json.loads(base64.urlsafe_b64decode(encode_cursor(row, query, principal) + "=="))
    original[1] = invalid
    encoded = base64.urlsafe_b64encode(json.dumps(original).encode()).decode().rstrip("=")
    with pytest.raises(ValueError):
        decode_cursor(query.model_copy(update={"cursor": encoded}), principal)


@pytest.mark.parametrize("value", ["", " ", "/etc/passwd", "..", "a\\b", "x\n", "x" * 257])
def test_identifier_validation_rejects_paths_controls_and_oversize(value):
    with pytest.raises(ValueError):
        validate_document_id(value)


def test_business_identity_not_forced_uuid_and_like_is_literal():
    assert validate_document_id("Expediente jurídico-23.2") == "Expediente jurídico-23.2"
    assert escape_like("%_\\") == "\\%\\_\\\\"


def test_original_verified_identical_and_requires_version(setup, principal, row):
    service, repo, _, root = setup
    data = b"%PDF-1.7\nsynthetic only\n%%EOF"
    (root / "source.pdf").write_bytes(data)
    row.update(byte_size=len(data), sha256=hashlib.sha256(data).digest())
    assert service.read(row["document_id"], row["document_version_id"], principal, original=True) == data
    assert len(repo.committed) == 1
    with pytest.raises(ValueError):
        service.read(row["document_id"], None, principal, original=True)


@pytest.mark.parametrize("change", ["missing", "size", "hash", "mime", "signature", "oversized", "traversal"])
def test_original_integrity_failure_releases_no_payload_or_success(setup, principal, row, change):
    service, repo, _, root = setup
    data = b"%PDF-1.7\nsynthetic"
    (root / "source.pdf").write_bytes(data)
    row.update(byte_size=len(data), sha256=hashlib.sha256(data).digest())
    if change == "missing": row["locator"] = "absent.pdf"
    if change == "size": row["byte_size"] += 1
    if change == "hash": row["sha256"] = bytes(32)
    if change == "mime": row["mime_type"] = "text/html"
    if change == "signature": (root / "source.pdf").write_bytes(b"HTML!!" + data[6:])
    if change == "oversized": row["byte_size"] = 1025
    if change == "traversal": row["locator"] = "../outside.pdf"
    with pytest.raises(ViewerUnavailable):
        service.read(row["document_id"], row["document_version_id"], principal, original=True)
    assert not repo.committed


def test_docx_original_not_exposed(setup, principal, row):
    service, repo, _, _ = setup
    row["document_type"] = "DOCX"
    with pytest.raises(ViewerNotFound):
        service.read(row["document_id"], row["document_version_id"], principal, original=True)
    assert not repo.committed

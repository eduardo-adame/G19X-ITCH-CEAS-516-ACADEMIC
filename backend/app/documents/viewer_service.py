"""Lectura independiente de RAG con autorización vigente y entrega auditada."""
from __future__ import annotations

import base64
import hashlib
import json
import os
import stat
from datetime import datetime
from uuid import UUID, uuid4

from app.documents.viewer_models import (
    ViewerContent, ViewerItem, ViewerNotFound, ViewerPage, ViewerUnavailable,
    ViewerVersionChanged, validate_document_id,
)
from app.security.models import AuditPersistenceError, SecurityError
from app.storage.abstraction import StorageError


def cursor_binding(query, principal):
    value = [str(principal.account_id), principal.authorization_version,
             query.model_dump(mode="json", exclude={"cursor", "limit"})]
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def encode_cursor(row, query, principal):
    value = [row["created_at"].isoformat(), str(row["document_version_id"]), cursor_binding(query, principal)]
    return base64.urlsafe_b64encode(json.dumps(value, separators=(",", ":")).encode()).decode().rstrip("=")


def decode_cursor(query, principal):
    if query.cursor is None:
        return None
    try:
        if len(query.cursor) > 2048:
            raise ValueError
        value = json.loads(base64.b64decode(query.cursor + "=" * (-len(query.cursor) % 4),
                                           altchars=b"-_", validate=True))
        if not isinstance(value, list) or len(value) != 3 or value[2] != cursor_binding(query, principal):
            raise ValueError
        if not isinstance(value[0], str) or not isinstance(value[1], str):
            raise ValueError
        stamp = datetime.fromisoformat(value[0])
        if stamp.utcoffset() is None:
            raise ValueError
        return stamp, UUID(value[1])
    except (ValueError, TypeError, UnicodeDecodeError):
        raise ValueError("Cursor no válido") from None


def item_values(row):
    return {field: row[field] for field in ViewerItem.model_fields}


class ViewerService:
    def __init__(self, repository, security, storage, *, max_file_bytes=52_428_800):
        self.repository = repository
        self.security = security
        self.storage = storage
        self.max_file_bytes = max_file_bytes

    def _authorize(self, connection, principal):
        current = self.security.revalidate_functional_access(connection, principal, "document.query")
        return current, self.security.authorized_document_scope(connection, current)

    def _denial(self, principal, correlation_id):
        with self.repository.transaction() as connection:
            self.security.repository.write_audit_event(
                connection, actor=principal, action="AUTHORIZATION_DENIED", resource_type="DOCUMENT",
                resource_identifier=None, result="DENIED", correlation_id=correlation_id,
                safe_cause_code="AUTHORIZATION_DENIED",
            )

    def catalog(self, query, principal):
        try:
            with self.repository.transaction() as connection:
                current, scope = self._authorize(connection, principal)
                rows = self.repository.catalog(connection, scope, query, decode_cursor(query, current))
                selected = rows[:query.limit]
                page = ViewerPage(items=[ViewerItem(**item_values(row)) for row in selected], next_cursor=(
                    encode_cursor(selected[-1], query, current) if len(rows) > query.limit else None))
                self._authorize(connection, current)
            return page
        except AuditPersistenceError:
            raise
        except SecurityError:
            self._denial(principal, uuid4())
            raise

    @staticmethod
    def _check_version(row, version_id):
        if row is None:
            raise ViewerNotFound
        if version_id is not None and row["document_version_id"] != version_id:
            raise ViewerVersionChanged

    def _original(self, row):
        if row["document_type"] != "PDF":
            raise ViewerNotFound
        if (row["mime_type"] != "application/pdf" or not 0 < row["byte_size"] <= self.max_file_bytes):
            raise ViewerUnavailable
        try:
            with self.storage.open_stream(row["locator"]) as stream:
                if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                    raise ViewerUnavailable
                payload = stream.read(self.max_file_bytes + 1)
        except (StorageError, OSError):
            raise ViewerUnavailable from None
        if (len(payload) != row["byte_size"] or len(payload) > self.max_file_bytes
                or not payload.startswith(b"%PDF-")
                or hashlib.sha256(payload).digest() != bytes(row["sha256"])):
            raise ViewerUnavailable
        return payload

    def read(self, document_id, version_id, principal, *, original=False):
        validate_document_id(document_id)
        if original and version_id is None:
            raise ValueError("La versión es obligatoria")
        correlation_id, operation_id = uuid4(), uuid4()
        try:
            with self.repository.transaction() as connection:
                current, scope = self._authorize(connection, principal)
                row = self.repository.content(connection, scope, document_id)
                self._check_version(row, version_id)
                payload = self._original(row) if original else ViewerContent(
                    **item_values(row), text=row["text"], operation_id=operation_id, correlation_id=correlation_id)
                current, scope = self._authorize(connection, current)
                final = self.repository.content(connection, scope, document_id)
                self._check_version(final, row["document_version_id"])
                self.security.repository.write_audit_event(
                    connection, actor=current, action="DOCUMENT_VIEW", resource_type="DOCUMENT_VERSION",
                    resource_identifier=json.dumps([document_id, str(row["document_version_id"])],
                                                   ensure_ascii=True, separators=(",", ":")),
                    result="SUCCESS", correlation_id=correlation_id,
                )
            # El contexto confirma INSERT y commit antes de permitir que el transporte entregue bytes.
            return payload
        except AuditPersistenceError:
            raise
        except SecurityError:
            self._denial(principal, correlation_id)
            raise

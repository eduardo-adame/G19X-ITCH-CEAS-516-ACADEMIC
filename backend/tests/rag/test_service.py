"""Contratos unitarios de identidad, contexto y citas de APPLICATION."""
from __future__ import annotations

from uuid import uuid4

from app.rag.service import RagApplicationService
from app.security.models import AuthenticatedPrincipal, ROLE_PERMISSIONS


def _principal() -> AuthenticatedPrincipal:
    return AuthenticatedPrincipal(
        uuid4(), uuid4(), "synthetic-user", 1,
        frozenset({"JURIDICO"}), ROLE_PERMISSIONS["JURIDICO"],
    )


def test_idempotency_key_is_stable_and_scoped_to_account() -> None:
    principal = _principal()
    key = uuid4()
    assert RagApplicationService._identity(principal, key) == RagApplicationService._identity(principal, key)
    assert RagApplicationService._identity(_principal(), key) != RagApplicationService._identity(principal, key)
    assert RagApplicationService._identity(principal, None) != RagApplicationService._identity(principal, None)


def test_persisted_identity_cannot_be_reused_with_other_query_or_session() -> None:
    principal = _principal()
    digest = bytes(range(32))
    row = {"user_id": principal.account_id, "session_id": principal.session_id,
           "query_sha256": digest, "context_reference_id": None}
    assert RagApplicationService._matches(row, principal, digest, None)
    assert not RagApplicationService._matches(row, principal, bytes(32), None)
    other_session = AuthenticatedPrincipal(
        principal.account_id, uuid4(), principal.username, principal.authorization_version,
        principal.roles, principal.permissions,
    )
    assert not RagApplicationService._matches(row, other_session, digest, None)

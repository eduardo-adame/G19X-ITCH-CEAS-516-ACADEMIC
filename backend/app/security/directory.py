"""Contratos de las consultas administrativas de solo lectura (RF-068, SRS 0.26).

Cuentas con su estado y roles activos, alcances documentales por rol y excepciones
documentales vigentes. Nunca exponen contraseñas, hashes, versiones de
autorización ni sesiones; las excepciones muestran el identificador del documento
y no su nombre, porque la autorización documental es independiente de la funcional.
"""
from __future__ import annotations

import base64
import hashlib
import json
from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

# Cualquiera de los permisos de administración de cuentas permite consultar la lista para elegir la cuenta.
ACCOUNT_READ_CAPABILITIES = frozenset({"user.update", "user.disable", "user.reset_access", "role.assign"})

Role = Literal["JURIDICO", "ANALISTA", "TI"]


def _plain_text(value: str | None) -> str | None:
    if value is not None and any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise ValueError("Texto no válido")
    return value


class AccountQuery(BaseModel):
    model_config = ConfigDict(extra="forbid")
    q: str | None = Field(default=None, max_length=100)
    state: Literal["ACTIVE", "DISABLED"] | None = None
    role: Role | None = None
    limit: int = Field(default=25, ge=1, le=100)
    cursor: str | None = Field(default=None, max_length=2048)

    @field_validator("q")
    @classmethod
    def plain_query(cls, value: str | None) -> str | None:
        return _plain_text(value)


class AccountSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: UUID
    username: str
    display_name: str
    state: Literal["ACTIVE", "DISABLED"]
    roles: list[Role]
    created_at: datetime
    disabled_at: datetime | None


class AccountPage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    items: list[AccountSummary]
    next_cursor: str | None = None


class ScopeGrant(BaseModel):
    model_config = ConfigDict(extra="forbid")
    role_id: Role
    source_family: Literal["CONTRATOS_DOCUMENTOS", "LITIGIOS", "CUMPLIMIENTO", "AUDITORIA_INTERNA"]
    active: bool


class ScopeGrantList(BaseModel):
    model_config = ConfigDict(extra="forbid")
    items: list[ScopeGrant]


class ExceptionQuery(BaseModel):
    model_config = ConfigDict(extra="forbid")
    subject: Literal["USER", "ROLE"] | None = None
    account_id: UUID | None = None
    role_id: Role | None = None
    document_id: str | None = Field(default=None, min_length=1, max_length=256)
    limit: int = Field(default=25, ge=1, le=100)
    cursor: str | None = Field(default=None, max_length=2048)

    @field_validator("document_id")
    @classmethod
    def plain_document(cls, value: str | None) -> str | None:
        return _plain_text(value)


class DocumentExceptionSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: UUID
    subject_type: Literal["USER", "ROLE"]
    account_id: UUID | None
    username: str | None
    display_name: str | None
    role_id: Role | None
    document_id: str
    decision: Literal["ALLOW", "DENY"]
    created_at: datetime


class DocumentExceptionPage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    items: list[DocumentExceptionSummary]
    next_cursor: str | None = None


# Cursor opaco ligado a la cuenta, a su versión de autorización y a los filtros: no se reutiliza entre
# identidades ni consultas distintas.
def cursor_binding(principal, query: BaseModel) -> str:
    value = [str(principal.account_id), principal.authorization_version,
             query.model_dump(mode="json", exclude={"cursor", "limit"})]
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def encode_cursor(position: list[str], binding: str) -> str:
    raw = json.dumps([*position, binding], separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode_cursor(cursor: str | None, binding: str, size: int) -> list[str] | None:
    if cursor is None:
        return None
    try:
        value = json.loads(base64.b64decode(cursor + "=" * (-len(cursor) % 4), altchars=b"-_", validate=True))
    except (ValueError, TypeError, UnicodeDecodeError):
        raise ValueError("Cursor no válido") from None
    if (not isinstance(value, list) or len(value) != size + 1 or value[-1] != binding
            or not all(isinstance(item, str) for item in value)):
        raise ValueError("Cursor no válido")
    return value[:-1]

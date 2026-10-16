"""Contratos públicos del catálogo y la lectura documental autorizada."""
from __future__ import annotations

from datetime import date
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator


DocumentType = Literal["PDF", "DOCX"]
SourceFamily = Literal["CONTRATOS_DOCUMENTOS", "LITIGIOS", "CUMPLIMIENTO", "AUDITORIA_INTERNA"]


def validate_document_id(value: str) -> str:
    if not value.strip() or len(value) > 256 or any(
        ord(char) < 32 or ord(char) == 127 or char in "/\\" for char in value
    ) or value in {".", ".."}:
        raise ValueError("Identificador no válido")
    return value


class ViewerQuery(BaseModel):
    model_config = ConfigDict(extra="forbid")
    q: str | None = Field(default=None, max_length=200)
    source_family: SourceFamily | None = None
    document_type: DocumentType | None = None
    limit: int = Field(default=25, ge=1, le=100)
    cursor: str | None = Field(default=None, max_length=2048)

    @field_validator("q")
    @classmethod
    def literal_name(cls, value):
        if value is not None and any(ord(char) < 32 or ord(char) == 127 for char in value):
            raise ValueError("Búsqueda no válida")
        return value


class ViewerItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    document_id: str = Field(min_length=1)
    document_version_id: UUID
    version_number: int = Field(ge=1)
    document_name: str
    document_type: DocumentType
    source_family: SourceFamily
    document_date: date | None
    representation: Literal["PDF_ORIGINAL", "CONSOLIDATED_TEXT"]
    text_available: bool


class ViewerPage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    items: list[ViewerItem]
    next_cursor: str | None = None


class ViewerContent(ViewerItem):
    text: str | None
    operation_id: UUID
    correlation_id: UUID


class ViewerPrintReceipt(BaseModel):
    """Confirmación de que la impresión quedó registrada; no contiene contenido del documento."""
    model_config = ConfigDict(extra="forbid")
    operation_id: UUID
    correlation_id: UUID


class ViewerNotFound(Exception):
    """El recurso no puede exponerse a esta identidad."""


class ViewerVersionChanged(Exception):
    """La versión vigente ya no es la seleccionada."""


class ViewerUnavailable(Exception):
    """No se confirmó almacenamiento, integridad o persistencia obligatoria."""

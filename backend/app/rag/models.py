"""Contratos tipados de recuperación documental autorizada."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from enum import StrEnum
from decimal import Decimal
from uuid import UUID

from app.security.models import AuthenticatedPrincipal


class RetrievalError(RuntimeError):
    """Fallo seguro de recuperación, sin detalles del corpus."""


class EvidenceState(StrEnum):
    EVIDENCIA_SUFICIENTE = "EVIDENCIA_SUFICIENTE"
    EVIDENCIA_INSUFICIENTE = "EVIDENCIA_INSUFICIENTE"
    SIN_EVIDENCIA = "SIN_EVIDENCIA"


class ProcessingOutcome(StrEnum):
    """Resultado interno de los controles locales; no es un estado RAG público ni se persiste.

    Los controles locales solo descartan (Estado 2 o 3). Una consulta que los supera es candidata
    a generación: el Estado 1 se asigna únicamente después de validar la respuesta del proveedor.
    """

    GENERATION_CANDIDATE = "GENERATION_CANDIDATE"


@dataclass(frozen=True)
class RetrievalContext:
    principal: AuthenticatedPrincipal
    query: str
    operation_id: UUID
    correlation_id: UUID
    context_reference_id: UUID | None = None
    # Embedding ya calculado por Gate 1; evita codificar dos veces la misma consulta.
    query_vector: tuple[float, ...] | None = None


@dataclass(frozen=True)
class CitationMetadata:
    document_id: str
    document_name: str
    document_type: str
    document_date: date | None
    fragment_id: UUID
    page_start: int | None = None
    page_end: int | None = None
    section: str | None = None
    clause: str | None = None
    # Posición estructural del fragmento: delimita la unidad local de evidencia de Gate 3.
    document_version_id: UUID | None = None
    ordinal: int | None = None

    @property
    def complete(self) -> bool:
        return bool(
            self.document_id and self.document_name and self.document_type
            and self.document_date is not None and self.fragment_id
        )


@dataclass(frozen=True)
class RetrievedCandidate:
    fragment_id: UUID
    fragment_text: str
    citation: CitationMetadata
    rank: int
    score: float


@dataclass(frozen=True)
class RankedFragment:
    fragment_id: UUID
    document_id: str
    fragment_text: str
    citation: CitationMetadata
    vector_rank: int | None
    bm25_rank: int | None
    rrf_score: Decimal


@dataclass(frozen=True)
class StructuredContext:
    fragments: tuple[RankedFragment, ...]


@dataclass(frozen=True)
class RetrievalResult:
    operation_id: UUID
    correlation_id: UUID
    state: EvidenceState | ProcessingOutcome
    fragments: tuple[RankedFragment, ...]
    structured_context: StructuredContext
    context_reference_id: UUID | None

"""Conserva la fecha del documento declarada en la carga manual.

ID de revisión: 0017_declared_document_date
Revisa: 0016_rag_operation_lifecycle
"""
from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "0017_declared_document_date"
down_revision: str | None = "0016_rag_operation_lifecycle"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # La fecha la declara quien carga un PDF/DOCX y se consume al consolidar el
    # documento. Ausente = sin fecha: no se infiere de metadatos ni de la carga.
    op.add_column("ingest_file", sa.Column("declared_document_date", sa.Date(), nullable=True), schema="app")


def downgrade() -> None:
    op.drop_column("ingest_file", "declared_document_date", schema="app")

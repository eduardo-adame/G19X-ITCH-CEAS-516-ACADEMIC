"""Telemetría persistida del proveedor y vínculo de reintento técnico (F-14).

Cada operación RAG con intento de generación conserva conteos exactos (intentos HTTP,
respuestas 429), tiempos (espera por capacidad y latencia total) y la causa técnica del
proveedor; nunca la consulta, el prompt, los fragmentos ni secretos. El rechazo por
capacidad local se distingue del 429 del proveedor. Un reintento tras un fallo técnico
terminal es una operación nueva que puede referir a la fallida, que permanece inmutable.

ID de revisión: 0019_rag_provider_telemetry
Revisa: 0018_rag_policy_result
"""
from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "0019_rag_provider_telemetry"
down_revision: str | None = "0018_rag_policy_result"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_SAFE_CAUSES_0016 = (
    "EMBEDDING_UNAVAILABLE",
    "RETRIEVAL_FAILED",
    "PROVIDER_RATE_LIMITED",
    "PROVIDER_TIMEOUT",
    "PROVIDER_UNAVAILABLE",
    "INVALID_PROVIDER_OUTPUT",
    "CONTEXT_LIMIT_EXCEEDED",
    "INTERNAL_FAILURE",
)
_SAFE_CAUSES = (*_SAFE_CAUSES_0016, "LOCAL_CAPACITY_EXHAUSTED")
_PROVIDER_CAUSES = (
    "LOCAL_CAPACITY_EXHAUSTED",
    "PROVIDER_RATE_LIMITED",
    "PROVIDER_TIMEOUT",
    "PROVIDER_UNAVAILABLE",
    "PROVIDER_CONTRACT_FAILURE",
    "CONTEXT_LIMIT_EXCEEDED",
)


def _quoted(values: Sequence[str]) -> str:
    return ", ".join(f"'{value}'" for value in values)


_TELEMETRY = f"""
  (
    provider_http_attempts IS NULL AND provider_rate_limit_count IS NULL AND provider_wait_ms IS NULL
    AND provider_latency_ms IS NULL AND provider_failure_cause IS NULL
  )
  OR
  (
    provider_http_attempts BETWEEN 0 AND 3
    AND provider_rate_limit_count BETWEEN 0 AND provider_http_attempts
    AND provider_wait_ms >= 0
    AND provider_latency_ms >= 0
    AND (provider_failure_cause IS NULL OR provider_failure_cause IN ({_quoted(_PROVIDER_CAUSES)}))
    AND (generation_status NOT IN ('SUCCEEDED', 'ABSTAINED') OR provider_failure_cause IS NULL)
    AND (generation_status <> 'FAILED' OR provider_failure_cause IS NOT NULL)
  )
"""


def upgrade() -> None:
    op.add_column("rag_operation", sa.Column("provider_http_attempts", sa.SmallInteger(), nullable=True), schema="app")
    op.add_column("rag_operation", sa.Column("provider_rate_limit_count", sa.SmallInteger(), nullable=True), schema="app")
    op.add_column("rag_operation", sa.Column("provider_wait_ms", sa.Integer(), nullable=True), schema="app")
    op.add_column("rag_operation", sa.Column("provider_latency_ms", sa.Integer(), nullable=True), schema="app")
    op.add_column("rag_operation", sa.Column("provider_failure_cause", sa.Text(), nullable=True), schema="app")
    op.add_column("rag_operation", sa.Column("retry_of_operation_id", postgresql.UUID(as_uuid=True), nullable=True), schema="app")
    op.create_check_constraint("ck_rag_operation_provider_telemetry", "rag_operation", f"({_TELEMETRY}) IS TRUE", schema="app")
    op.create_check_constraint(
        "ck_rag_operation_retry_not_self", "rag_operation",
        "retry_of_operation_id IS NULL OR retry_of_operation_id <> operation_id", schema="app",
    )
    op.create_foreign_key(
        "fk_rag_operation_retry_of", "rag_operation", "rag_operation",
        ["retry_of_operation_id"], ["operation_id"], source_schema="app", referent_schema="app", ondelete="RESTRICT",
    )
    op.drop_constraint("ck_rag_operation_safe_cause", "rag_operation", schema="app", type_="check")
    op.create_check_constraint(
        "ck_rag_operation_safe_cause", "rag_operation",
        f"safe_cause_code IS NULL OR safe_cause_code IN ({_quoted(_SAFE_CAUSES)})", schema="app",
    )


def downgrade() -> None:
    # 0018 no puede representar la telemetría, el vínculo de reintento ni la causa de capacidad local.
    op.execute(
        """
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM app.rag_operation
             WHERE provider_http_attempts IS NOT NULL
                OR retry_of_operation_id IS NOT NULL
                OR safe_cause_code = 'LOCAL_CAPACITY_EXHAUSTED'
          ) THEN
            RAISE EXCEPTION 'MIGRATION_0019_DOWNGRADE_ABORT: rag_operation rows not representable by 0018 exist'
              USING ERRCODE = '23514';
          END IF;
        END
        $$
        """
    )
    op.drop_constraint("ck_rag_operation_safe_cause", "rag_operation", schema="app", type_="check")
    op.create_check_constraint(
        "ck_rag_operation_safe_cause", "rag_operation",
        f"safe_cause_code IS NULL OR safe_cause_code IN ({_quoted(_SAFE_CAUSES_0016)})", schema="app",
    )
    op.drop_constraint("fk_rag_operation_retry_of", "rag_operation", schema="app", type_="foreignkey")
    op.drop_constraint("ck_rag_operation_retry_not_self", "rag_operation", schema="app", type_="check")
    op.drop_constraint("ck_rag_operation_provider_telemetry", "rag_operation", schema="app", type_="check")
    for column in ("retry_of_operation_id", "provider_failure_cause", "provider_latency_ms", "provider_wait_ms",
                   "provider_rate_limit_count", "provider_http_attempts"):
        op.drop_column("rag_operation", column, schema="app")

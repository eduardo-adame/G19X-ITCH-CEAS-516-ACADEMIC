"""Registra la restricción de alcance y el resultado de la generación sustentada.

La restricción de alcance (Gate 1) no crea un estado de evidencia. La generación sustentada
añade dos ciclos de vida: la abstención del proveedor (Estado 2 con ``ABSTAINED``) y el
fallo técnico o contractual de la generación sin estado final de evidencia (los fragmentos
autorizados se conservan como referencia). El fallo con ``EVIDENCIA_SUFICIENTE`` de 0016 se
conserva solo para filas históricas.

ID de revisión: 0018_rag_policy_result
Revisa: 0017_declared_document_date
"""
from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "0018_rag_policy_result"
down_revision: str | None = "0017_declared_document_date"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Expresión de 0016 (estados de evidencia y fallos), conservada literalmente.
_LIFECYCLE_0016 = """
        (
          (
            state IS NULL
            AND operation_status = 'FAILED'
            AND generation_status = 'NOT_REQUESTED'
            AND safe_cause_code IS NOT NULL
            AND generated_response IS NULL
            AND safe_result_message IS NOT NULL
            AND btrim(safe_result_message) <> ''
          )
          OR
          (
            state IS NOT NULL
            AND (
              (
                state = 'EVIDENCIA_SUFICIENTE'
                AND operation_status = 'COMPLETED'
                AND generation_status = 'SUCCEEDED'
                AND safe_cause_code IS NULL
                AND generated_response IS NOT NULL
                AND btrim(generated_response) <> ''
                AND safe_result_message IS NULL
              )
              OR
              (
                state = 'EVIDENCIA_SUFICIENTE'
                AND operation_status = 'FAILED'
                AND generation_status = 'FAILED'
                AND safe_cause_code IS NOT NULL
                AND generated_response IS NULL
                AND safe_result_message IS NOT NULL
                AND btrim(safe_result_message) <> ''
              )
              OR
              (
                state IN ('EVIDENCIA_INSUFICIENTE', 'SIN_EVIDENCIA', 'SIN_AUTORIZACION')
                AND operation_status = 'COMPLETED'
                AND generation_status = 'NOT_REQUESTED'
                AND safe_cause_code IS NULL
                AND generated_response IS NULL
                AND safe_result_message IS NOT NULL
                AND btrim(safe_result_message) <> ''
              )
            )
          )
        ) IS TRUE
        """

# Generación sustentada: el proveedor se abstuvo (Estado 2) o la generación falló sin
# que exista un estado final de evidencia.
_GROUNDED = """
  (
    (
      state = 'EVIDENCIA_INSUFICIENTE'
      AND operation_status = 'COMPLETED'
      AND generation_status = 'ABSTAINED'
      AND safe_cause_code IS NULL
      AND generated_response IS NULL
      AND safe_result_message IS NOT NULL
      AND btrim(safe_result_message) <> ''
    )
    OR
    (
      state IS NULL
      AND operation_status = 'FAILED'
      AND generation_status = 'FAILED'
      AND safe_cause_code IS NOT NULL
      AND generated_response IS NULL
      AND safe_result_message IS NOT NULL
      AND btrim(safe_result_message) <> ''
    )
  )
"""

# Una solicitud de decisión jurídica autónoma se responde sin recuperar ni generar:
# no tiene estado de evidencia, no reutiliza SIN_AUTORIZACION y no conserva fragmentos.
_RESTRICTED = """
  (
    policy_result = 'RESTRICCION_ALCANCE'
    AND state IS NULL
    AND operation_status = 'COMPLETED'
    AND generation_status = 'NOT_REQUESTED'
    AND safe_cause_code IS NULL
    AND generated_response IS NULL
    AND safe_result_message IS NOT NULL
    AND btrim(safe_result_message) <> ''
  )
"""


def upgrade() -> None:
    op.add_column("rag_operation", sa.Column("policy_result", sa.Text(), nullable=True), schema="app")
    op.create_check_constraint(
        "ck_rag_operation_policy_result", "rag_operation",
        "policy_result IS NULL OR policy_result = 'RESTRICCION_ALCANCE'", schema="app",
    )
    op.drop_constraint("ck_rag_operation_generation_status", "rag_operation", schema="app", type_="check")
    op.create_check_constraint(
        "ck_rag_operation_generation_status", "rag_operation",
        "generation_status IN ('NOT_REQUESTED', 'SUCCEEDED', 'FAILED', 'ABSTAINED')", schema="app",
    )
    op.drop_constraint("ck_rag_operation_lifecycle_consistency", "rag_operation", schema="app", type_="check")
    op.create_check_constraint(
        "ck_rag_operation_lifecycle_consistency", "rag_operation",
        f"((policy_result IS NULL AND (({_LIFECYCLE_0016}) OR {_GROUNDED})) OR {_RESTRICTED}) IS TRUE", schema="app",
    )


def downgrade() -> None:
    # 0017 no puede representar restricciones de alcance ni la generación sustentada:
    # se rechaza antes de perderlas.
    op.execute(
        """
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM app.rag_operation
             WHERE policy_result IS NOT NULL
                OR generation_status = 'ABSTAINED'
                OR (state IS NULL AND generation_status = 'FAILED')
          ) THEN
            RAISE EXCEPTION 'MIGRATION_0018_DOWNGRADE_ABORT: rag_operation rows not representable by 0017 exist'
              USING ERRCODE = '23514';
          END IF;
        END
        $$
        """
    )
    op.drop_constraint("ck_rag_operation_lifecycle_consistency", "rag_operation", schema="app", type_="check")
    op.create_check_constraint("ck_rag_operation_lifecycle_consistency", "rag_operation", _LIFECYCLE_0016, schema="app")
    op.drop_constraint("ck_rag_operation_generation_status", "rag_operation", schema="app", type_="check")
    op.create_check_constraint(
        "ck_rag_operation_generation_status", "rag_operation",
        "generation_status IN ('NOT_REQUESTED', 'SUCCEEDED', 'FAILED')", schema="app",
    )
    op.drop_constraint("ck_rag_operation_policy_result", "rag_operation", schema="app", type_="check")
    op.drop_column("rag_operation", "policy_result", schema="app")

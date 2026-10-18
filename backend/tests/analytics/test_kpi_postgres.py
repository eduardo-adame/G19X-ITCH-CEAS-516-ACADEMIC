from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
import os
from pathlib import Path
from threading import Barrier
from types import MappingProxyType
from uuid import uuid4

from alembic import command
from alembic.config import Config
import pytest
import sqlalchemy as sa
from sqlalchemy.engine import make_url

from app.business_time import day_start
from app.analytics.models import KpiCalculationError, KpiObservationResult, KpiQuery, KpiRecalculationContext, KpiRecalculationRequest, ProactiveAnalysisContext
from app.analytics.repository import AnalyticsRepository
from app.analytics.service import KPIRecalculationService, KpiQueryService, ProactiveAnalysisService, derive_run_operation_id
from app.ingestion.models import SourceFamily
from app.projection.models import ProjectionContext
from app.projection.repository import ProjectionRepository
from app.projection.service import ProjectionService
from app.security.models import AuthenticatedPrincipal, AuthenticationError, AuthorizationError
from app.security.repository import SecurityRepository
from app.security.service import SecurityService
from app.validation.models import ValidatedTabularRecord


BACKEND_ROOT = Path(__file__).resolve().parents[2]


def _url() -> str:
    value = os.getenv("DATA_TEST_DATABASE_URL", "")
    if not value or "test" not in (make_url(value).database or "").lower():
        pytest.fail("La evidencia requiere una base PostgreSQL desechable")
    return make_url(value).set(drivername="postgresql+psycopg").render_as_string(hide_password=False)


@pytest.fixture
def database():
    url = _url()
    parsed = make_url(url)
    os.environ.update(POSTGRES_HOST=parsed.host or "localhost", POSTGRES_PORT=str(parsed.port or 5432), POSTGRES_USER=parsed.username or "", POSTGRES_PASSWORD=parsed.password or "", POSTGRES_DB=parsed.database or "")
    command.upgrade(Config(str(BACKEND_ROOT / "alembic.ini")), "head")
    engine = sa.create_engine(url)
    with engine.begin() as connection:
        connection.execute(sa.text("TRUNCATE app.kpi_observation, app.analytic_run, app.stored_object, app.document CASCADE"))
    try:
        yield engine, make_url(url).set(drivername="postgresql").render_as_string(hide_password=False)
    finally:
        engine.dispose()


@pytest.mark.requires_db
def test_kpi_recalculation_persists_one_monthly_observation(database) -> None:
    engine, conninfo = database
    service = KPIRecalculationService(AnalyticsRepository(conninfo), SecurityRepository(conninfo))
    request = KpiRecalculationRequest(("KPI-LI-05",), date(2026, 1, 1), date(2026, 1, 31), date(2026, 1, 15))
    result = service.recalculate(request, KpiRecalculationContext(uuid4(), uuid4(), process_identifier="analytics-test"))
    with engine.connect() as connection:
        row = connection.execute(sa.text("SELECT analytic_run_id, value, availability FROM app.kpi_observation WHERE kpi_code='KPI-LI-05'")).mappings().one()
    assert row["analytic_run_id"] == result.analytic_run_id
    assert row["value"] == 0
    assert row["availability"] == "DISPONIBLE"


def _request(code: str, day: int = 15) -> KpiRecalculationRequest:
    return KpiRecalculationRequest((code,), date(2026, 1, 1), date(2026, 1, 31), date(2026, 1, day))


def _context(parent=None) -> KpiRecalculationContext:
    return KpiRecalculationContext(parent or uuid4(), uuid4(), process_identifier="analytics-test")


def _service(conninfo: str, audit=None) -> KPIRecalculationService:
    return KPIRecalculationService(AnalyticsRepository(conninfo), audit or SecurityRepository(conninfo))


def _rows(engine, sql: str, **parameters):
    with engine.connect() as connection:
        return connection.execute(sa.text(sql), parameters).mappings().all()


def _query_principal(engine, *, role: str | None = None, valid_session: bool = True) -> AuthenticatedPrincipal:
    account_id, session_id = uuid4(), uuid4()
    username = f"analytics-{account_id}"
    with engine.begin() as connection:
        connection.execute(
            sa.text("INSERT INTO app.user_account (id, username, display_name, password_hash) VALUES (:id, :username, 'Analytics', 'test-only-hash')"),
            {"id": account_id, "username": username},
        )
        if role is not None:
            connection.execute(
                sa.text("INSERT INTO app.user_role (user_id, role_id, active) VALUES (:id, :role, true)"),
                {"id": account_id, "role": role},
            )
        if valid_session:
            connection.execute(
                sa.text("""INSERT INTO app.access_session
                    (id, user_id, refresh_token_sha256, authorization_version, state, expires_at, correlation_id)
                    VALUES (:id, :account_id, :digest, 1, 'ACTIVE', :expires_at, :correlation_id)"""),
                {"id": session_id, "account_id": account_id, "digest": uuid4().bytes + uuid4().bytes,
                 "expires_at": datetime.now(UTC) + timedelta(hours=1), "correlation_id": uuid4()},
            )
    return AuthenticatedPrincipal(account_id, session_id, username, 1, frozenset(), frozenset())


@pytest.mark.requires_db
def test_kpi_query_denial_is_audited_after_transaction_rollback(database) -> None:
    engine, conninfo = database
    actor = _query_principal(engine)
    context = KpiRecalculationContext(uuid4(), uuid4(), actor=actor)
    service = KpiQueryService(AnalyticsRepository(conninfo), SecurityService(SecurityRepository(conninfo)), SecurityRepository(conninfo))

    with pytest.raises(AuthorizationError):
        service.list(KpiQuery("KPI-CD-03"), context)

    events = _rows(engine, "SELECT action, result, safe_cause_code FROM audit.event WHERE correlation_id=:correlation", correlation=context.correlation_id)
    assert [(event["action"], event["result"], event["safe_cause_code"]) for event in events] == [
        ("AUTHORIZATION_DENIED", "DENIED", "DEFAULT_DENY")
    ]


@pytest.mark.requires_db
def test_kpi_query_invalid_session_is_audited_after_transaction_rollback(database) -> None:
    engine, conninfo = database
    actor = _query_principal(engine, role="JURIDICO", valid_session=False)
    context = KpiRecalculationContext(uuid4(), uuid4(), actor=actor)
    service = KpiQueryService(AnalyticsRepository(conninfo), SecurityService(SecurityRepository(conninfo)), SecurityRepository(conninfo))

    with pytest.raises(AuthenticationError):
        service.list(KpiQuery("KPI-CD-03"), context)

    events = _rows(engine, "SELECT action, result, safe_cause_code FROM audit.event WHERE correlation_id=:correlation", correlation=context.correlation_id)
    assert [(event["action"], event["result"], event["safe_cause_code"]) for event in events] == [
        ("AUTHORIZATION_DENIED", "DENIED", "DEFAULT_DENY")
    ]


@pytest.mark.requires_db
def test_kpi_cd03_query_uses_kpi_read_without_extra_role_restriction(database) -> None:
    engine, conninfo = database
    actor = _query_principal(engine, role="JURIDICO")
    context = KpiRecalculationContext(uuid4(), uuid4(), actor=actor)
    service = KpiQueryService(AnalyticsRepository(conninfo), SecurityService(SecurityRepository(conninfo)), SecurityRepository(conninfo))

    assert service.list(KpiQuery("KPI-CD-03"), context) == []
    assert _rows(engine, "SELECT id FROM audit.event WHERE correlation_id=:correlation", correlation=context.correlation_id) == []


def _source(engine, *, family: str = "LITIGIOS", received_at: datetime = datetime(2026, 1, 1, 12, tzinfo=UTC)):
    """Registro fuente con carga tabular aceptada recibida en `received_at` (cobertura de la familia, SRS v0.22)."""
    object_id, file_id, source_id = uuid4(), uuid4(), uuid4()
    with engine.begin() as connection:
        connection.execute(sa.text("""INSERT INTO app.stored_object (id, storage_kind, locator, sha256, mime_type, byte_size, original_name)
            VALUES (:id, 'FILESYSTEM', :locator, :digest, 'text/csv', 1, 'analytics.csv')"""),
            {"id": object_id, "locator": f"analytics/{object_id}", "digest": bytes(32)})
        connection.execute(sa.text("""INSERT INTO app.ingest_file
            (id, stored_object_id, source_family, exchange_format, state, operation_id, correlation_id,
             declared_extension, detected_format, format_classification, technical_result,
             declared_name, source_locator, source_revision, actor_identifier, content_sha256, received_at)
            VALUES (:id, :object_id, :family, 'CSV', 'COMPLETADO', :operation, :correlation,
                    '.csv', 'CSV', 'SUPPORTED', 'ACCEPTED', 'analytics.csv', :locator, 1, 'test', :digest, :received)"""),
            {"id": file_id, "object_id": object_id, "family": family, "operation": uuid4(),
             "correlation": uuid4(), "locator": f"test/{file_id}", "digest": bytes(32), "received": received_at})
        connection.execute(sa.text("""INSERT INTO app.source_record
            (id, ingest_file_id, row_number, source_sheet, raw_payload, record_sha256, extraction_state)
            VALUES (:id, :file_id, 1, 'CSV', '{}'::jsonb, :digest, 'EXTRAIDO')"""),
            {"id": source_id, "file_id": file_id, "digest": bytes(32)})
    return source_id


# Los KPI snapshot se calculan con corte as-of sobre el momento de ingesta
# (created_at); los registros de prueba se fechan dentro del periodo calculado.
INGESTED_AT = datetime(2026, 1, 2, 12, tzinfo=UTC)


def _contract(engine, *, expiry: date = date(2026, 1, 20), created_at: datetime = INGESTED_AT) -> None:
    source = _source(engine, family="CONTRATOS_DOCUMENTOS")
    with engine.begin() as connection:
        connection.execute(sa.text("""INSERT INTO app.contract_record
            (id_contrato, fecha_solicitud, fecha_firma, fecha_vencimiento, estado_revision, payload_sha256, source_record_id, created_at, updated_at)
            VALUES (:id, '2026-01-01', NULL, :expiry, 'No iniciado', :digest, :source, :created, :created)"""),
            {"id": f"C-{uuid4()}", "expiry": expiry, "digest": bytes(32), "source": source, "created": created_at})


def _litigation(engine, severity: str, estimate, claim, *, state: str = "Activo", created_at: datetime = INGESTED_AT) -> None:
    source = _source(engine)
    with engine.begin() as connection:
        connection.execute(sa.text("""INSERT INTO app.litigation
            (id_litigio, fecha_apertura, estado, nivel_severidad, monto_reclamado, estimacion_interna,
             payload_sha256, source_record_id, created_at, updated_at)
            VALUES (:id, '2026-01-02', :state, :severity, :claim, :estimate, :digest, :source, :created, :created)"""),
            {"id": f"L-{uuid4()}", "state": state, "severity": severity, "claim": claim,
             "estimate": estimate, "digest": bytes(32), "source": source, "created": created_at})


@pytest.mark.requires_db
def test_concurrent_identical_recalculation_uses_one_run_and_observation(database) -> None:
    engine, conninfo = database
    request, context = _request("KPI-LI-05"), _context()
    barrier = Barrier(2)

    def invoke():
        barrier.wait(timeout=10)
        return _service(conninfo).recalculate(request, context)

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(invoke) for _ in range(2)]
        results = [future.result(timeout=20) for future in futures]
    assert results[0].analytic_run_id == results[1].analytic_run_id
    assert len(_rows(engine, "SELECT id FROM app.analytic_run")) == 1
    assert len(_rows(engine, "SELECT id FROM app.kpi_observation")) == 1
    assert _rows(engine, "SELECT operation_id FROM app.analytic_run")[0]["operation_id"] == derive_run_operation_id(context.operation_id, request)


@pytest.mark.requires_db
def test_concurrent_stale_and_newer_writers_keep_newer_observation(database) -> None:
    engine, conninfo = database
    _contract(engine)
    barrier = Barrier(2)
    requests = (_request("KPI-RC-03", 15), _request("KPI-RC-03", 25))

    def invoke(request):
        barrier.wait(timeout=10)
        return _service(conninfo).recalculate(request, _context())

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(invoke, request) for request in requests]
        [future.result(timeout=20) for future in futures]
    rows = _rows(engine, "SELECT value, availability, as_of_date, analytic_run_id FROM app.kpi_observation")
    assert len(rows) == 1
    assert rows[0]["as_of_date"] == date(2026, 1, 25)
    assert rows[0]["value"] == 0 and rows[0]["availability"] == "DISPONIBLE"
    assert rows[0]["analytic_run_id"] == _rows(engine, "SELECT id FROM app.analytic_run WHERE rules_reference->>'as_of_date'='2026-01-25'")[0]["id"]


class _FailingAudit:
    def write_audit_event(self, connection, **kwargs):
        SecurityRepository.write_audit_event(connection, **kwargs)
        raise RuntimeError("audit unavailable")


@pytest.mark.requires_db
def test_mandatory_audit_failure_rolls_back_success_and_observation(database) -> None:
    engine, conninfo = database
    context = _context()
    with pytest.raises(KpiCalculationError):
        _service(conninfo, _FailingAudit()).recalculate(_request("KPI-LI-05"), context)
    assert _rows(engine, "SELECT id FROM app.kpi_observation") == []
    assert _rows(engine, "SELECT id FROM app.analytic_run WHERE state='COMPLETED'") == []
    assert _rows(engine, "SELECT id FROM audit.event WHERE correlation_id=:correlation", correlation=context.correlation_id) == []


@pytest.mark.requires_db
def test_stale_as_of_date_preserves_all_columns_of_newer_observation(database) -> None:
    engine, conninfo = database
    _contract(engine)
    service = _service(conninfo)
    service.recalculate(_request("KPI-RC-03", 25), _context())
    before = _rows(engine, "SELECT id, value, availability, analytic_run_id, as_of_date FROM app.kpi_observation")[0]
    service.recalculate(_request("KPI-RC-03", 15), _context())
    assert _rows(engine, "SELECT id, value, availability, analytic_run_id, as_of_date FROM app.kpi_observation") == [before]


@pytest.mark.requires_db
def test_equal_as_of_date_refreshes_one_observation(database) -> None:
    engine, conninfo = database
    _contract(engine)
    service = _service(conninfo)
    first = service.recalculate(_request("KPI-RC-03", 15), _context())
    with engine.begin() as connection:
        connection.execute(sa.text("UPDATE app.contract_record SET estado_revision='En revisión'"))
        connection.execute(sa.text("UPDATE app.kpi_observation SET calculated_at='2000-01-01'::timestamptz"))
    second = service.recalculate(_request("KPI-RC-03", 15), _context())
    rows = _rows(engine, "SELECT value, as_of_date, calculated_at, analytic_run_id FROM app.kpi_observation")
    assert len(rows) == 1 and rows[0]["value"] == 0
    assert rows[0]["as_of_date"] == date(2026, 1, 15)
    assert rows[0]["analytic_run_id"] == second.analytic_run_id != first.analytic_run_id
    assert rows[0]["calculated_at"].year > 2000


@pytest.mark.requires_db
def test_newer_as_of_date_updates_one_observation(database) -> None:
    engine, conninfo = database
    _contract(engine)
    service = _service(conninfo)
    first = service.recalculate(_request("KPI-RC-03", 15), _context())
    second = service.recalculate(_request("KPI-RC-03", 25), _context())
    rows = _rows(engine, "SELECT value, availability, as_of_date, analytic_run_id FROM app.kpi_observation")
    assert len(rows) == 1 and rows[0]["value"] == 0 and rows[0]["availability"] == "DISPONIBLE"
    assert rows[0]["as_of_date"] == date(2026, 1, 25)
    assert rows[0]["analytic_run_id"] == second.analytic_run_id != first.analytic_run_id


@pytest.mark.requires_db
def test_li01_persists_all_three_severities_with_empty_aggregates(database) -> None:
    engine, conninfo = database
    _litigation(engine, "alto", Decimal("120.50"), Decimal("500"))
    _litigation(engine, "bajo", None, None)
    _litigation(engine, "alto", Decimal("999"), None, state="Cerrado")
    result = _service(conninfo).recalculate(_request("KPI-LI-01"), _context())
    rows = _rows(engine, "SELECT dimensions->>'nivel_severidad' AS severity, value, availability FROM app.kpi_observation ORDER BY severity")
    assert len(rows) == 3 and len(result.observations) == 3
    by_severity = {row["severity"]: (row["value"], row["availability"]) for row in rows}
    assert by_severity == {"alto": (Decimal("120.50"), "DISPONIBLE"), "medio": (Decimal(0), "DISPONIBLE"), "bajo": (Decimal(0), "DISPONIBLE")}
    assert _rows(engine, "SELECT monto_reclamado, estimacion_interna FROM app.litigation WHERE nivel_severidad='bajo'")[0] == {"monto_reclamado": None, "estimacion_interna": None}


@pytest.mark.requires_db
def test_known_incident_group_without_rows_in_month_persists_zero(database) -> None:
    engine, conninfo = database
    source = _source(engine, family="AUDITORIA_INTERNA")
    with engine.begin() as connection:
        connection.execute(sa.text("""INSERT INTO app.incident
            (id_incidente, fecha_evento, area, nivel_severidad, payload_sha256, source_record_id)
            VALUES (:id, '2026-02-01', 'Legal', 'alto', :digest, :source)"""),
            {"id": f"I-{uuid4()}", "digest": bytes(32), "source": source})
    _service(conninfo).recalculate(_request("KPI-CN-03"), _context())
    rows = _rows(engine, "SELECT dimensions, value, availability FROM app.kpi_observation")
    assert len(rows) == 1 and rows[0]["dimensions"] == {"area": "Legal", "nivel_severidad": "alto"}
    assert rows[0]["value"] == 0 and rows[0]["availability"] == "DISPONIBLE"


@pytest.mark.requires_db
def test_known_legal_matter_group_without_rows_in_month_persists_zero(database) -> None:
    engine, conninfo = database
    source = _source(engine, family="AUDITORIA_INTERNA")
    matter_id = f"A-{uuid4()}"
    with engine.begin() as connection:
        connection.execute(sa.text("""INSERT INTO app.legal_matter
            (id_asunto, tipo_asunto, estado, fecha, source_entity_type, source_business_id, payload_sha256, source_record_id)
            VALUES (:id, 'Auditoría', 'Abierto', '2026-02-01', 'AUDITORIA_INTERNA', :id, :digest, :source)"""),
            {"id": matter_id, "digest": bytes(32), "source": source})
    _service(conninfo).recalculate(_request("KPI-EO-01"), _context())
    rows = _rows(engine, "SELECT dimensions, value, availability FROM app.kpi_observation")
    assert len(rows) == 1 and rows[0]["dimensions"] == {"tipo_asunto": "Auditoría", "estado": "Abierto"}
    assert rows[0]["value"] == 0 and rows[0]["availability"] == "DISPONIBLE"


def _ocr_version(engine, document_id: str, version_number: int, *, confidence: Decimal | None, processed_at: datetime, final: bool = True, attempt: int = 1, version_id=None):
    object_id = uuid4()
    version_id = version_id or uuid4()
    with engine.begin() as connection:
        if version_number == 1 and attempt == 1:
            connection.execute(sa.text("""INSERT INTO app.document (id_documento, name, document_type, source_family)
                VALUES (:id, 'ocr.pdf', 'PDF', 'CONTRATOS_DOCUMENTOS')"""), {"id": document_id})
        connection.execute(sa.text("""INSERT INTO app.stored_object
            (id, storage_kind, locator, sha256, mime_type, byte_size, original_name)
            VALUES (:id, 'FILESYSTEM', :locator, :digest, 'application/pdf', 1, 'ocr.pdf')"""),
            {"id": object_id, "locator": f"ocr/{object_id}", "digest": bytes(32)})
        connection.execute(sa.text("""INSERT INTO app.document_version
            (id, id_documento, version_number, stored_object_id, processing_state, content_sha256,
             operation_id, correlation_id, completed_at)
            VALUES (:id, :document, :version, :object, :state, :digest, :operation, :correlation, :completed)"""),
            {"id": version_id, "document": document_id, "version": version_number, "object": object_id,
             "state": "LISTA" if final else "PROCESANDO", "digest": bytes(32), "operation": uuid4(),
             "correlation": uuid4(), "completed": processed_at if final else None})
        state = "Pendiente" if confidence is None else ("Exitoso" if confidence >= Decimal("0.80") else "Rechazado por baja confianza")
        run_id = uuid4()
        connection.execute(sa.text("""INSERT INTO app.ocr_run
            (id, document_version_id, attempt_number, estado_ocr, confianza_agregada, is_final,
             operation_id, correlation_id, processed_at)
            VALUES (:id, :version, :attempt, :state, :confidence, :final, :operation, :correlation, :processed)"""),
            {"id": run_id, "version": version_id, "attempt": attempt, "state": state,
             "confidence": confidence, "final": final, "operation": uuid4(), "correlation": uuid4(), "processed": processed_at})
    return version_id, run_id


@pytest.mark.requires_db
def test_cd03_selects_latest_final_per_document_and_percentage_scale(database) -> None:
    engine, conninfo = database
    at = datetime(2026, 1, 15, tzinfo=UTC)
    first = f"D-{uuid4()}"
    _ocr_version(engine, first, 1, confidence=Decimal("0.60"), processed_at=at - timedelta(days=2))
    latest_version, _ = _ocr_version(engine, first, 2, confidence=Decimal("0.80"), processed_at=at)
    with engine.begin() as connection:
        connection.execute(sa.text("""INSERT INTO app.ocr_run
            (id, document_version_id, attempt_number, estado_ocr, confianza_agregada, is_final,
             operation_id, correlation_id, processed_at)
            VALUES (:id, :version, 2, 'Pendiente', NULL, false, :operation, :correlation, :processed)"""),
            {"id": uuid4(), "version": latest_version, "operation": uuid4(), "correlation": uuid4(),
             "processed": at + timedelta(days=1)})
    for _ in range(3):
        _ocr_version(engine, f"D-{uuid4()}", 1, confidence=Decimal("0.90"), processed_at=at)
    tied = f"D-{uuid4()}"
    _ocr_version(engine, tied, 1, confidence=Decimal("0.90"), processed_at=at)
    _ocr_version(engine, tied, 2, confidence=Decimal("0.70"), processed_at=at)
    pending_doc = f"D-{uuid4()}"
    _ocr_version(engine, pending_doc, 1, confidence=None, processed_at=at + timedelta(days=1), final=False)
    result = _service(conninfo).recalculate(_request("KPI-CD-03"), _context())
    assert len(result.observations) == 1 and result.observations[0].value == 80
    with AnalyticsRepository(conninfo).transaction() as connection:
        selected = AnalyticsRepository.ocr_final_rows(connection)
    assert len(selected) == 5
    assert len({row["id_documento"] for row in selected}) == 5
    assert next(row for row in selected if row["id_documento"] == first)["confianza_agregada"] == Decimal("0.80")
    assert next(row for row in selected if row["id_documento"] == tied)["confianza_agregada"] == Decimal("0.70")
    assert all(row["id_documento"] != pending_doc for row in selected)


@pytest.mark.requires_db
def test_same_parent_request_retries_same_run_and_different_request_gets_child_run(database) -> None:
    engine, conninfo = database
    parent = uuid4()
    context = _context(parent)
    request = _request("KPI-LI-05")
    service = _service(conninfo)
    first = service.recalculate(request, context)
    audit_before = _rows(engine, "SELECT id FROM audit.event WHERE correlation_id=:correlation", correlation=context.correlation_id)
    second = service.recalculate(request, context)
    assert first.analytic_run_id == second.analytic_run_id
    assert len(_rows(engine, "SELECT id FROM app.analytic_run")) == 1
    assert len(_rows(engine, "SELECT id FROM app.kpi_observation")) == 1
    assert _rows(engine, "SELECT id FROM audit.event WHERE correlation_id=:correlation", correlation=context.correlation_id) == audit_before
    other_request = _request("KPI-CN-02")
    third = service.recalculate(other_request, context)
    assert third.analytic_run_id != first.analytic_run_id
    operations = {row["operation_id"] for row in _rows(engine, "SELECT operation_id FROM app.analytic_run")}
    assert operations == {derive_run_operation_id(parent, request), derive_run_operation_id(parent, other_request)}


@pytest.mark.requires_db
def test_old_completed_retry_after_newer_observation_preserves_current_state(database) -> None:
    engine, conninfo = database
    _contract(engine)
    service = _service(conninfo)
    older_request, newer_request = _request("KPI-RC-03", 15), _request("KPI-RC-03", 25)
    older_context, newer_context = _context(), _context()
    first = service.recalculate(older_request, older_context)
    second = service.recalculate(newer_request, newer_context)
    before = _rows(engine, "SELECT id, value, availability, analytic_run_id, as_of_date FROM app.kpi_observation")[0]
    run_count = len(_rows(engine, "SELECT id FROM app.analytic_run"))
    retried = service.recalculate(older_request, older_context)
    assert retried.analytic_run_id == first.analytic_run_id
    assert retried.observations[0].as_of_date == newer_request.as_of_date
    assert before["analytic_run_id"] == second.analytic_run_id
    assert _rows(engine, "SELECT id, value, availability, analytic_run_id, as_of_date FROM app.kpi_observation") == [before]
    assert len(_rows(engine, "SELECT id FROM app.analytic_run")) == run_count == 2


class _FailOnceAudit:
    def __init__(self) -> None:
        self.failed = False

    def write_audit_event(self, connection, **kwargs):
        SecurityRepository.write_audit_event(connection, **kwargs)
        if kwargs["result"] == "SUCCESS" and not self.failed:
            self.failed = True
            raise RuntimeError("temporary audit failure")


@pytest.mark.requires_db
def test_failed_run_retries_with_same_identity_and_one_observation(database) -> None:
    engine, conninfo = database
    request, context = _request("KPI-LI-05"), _context()
    failing = _FailOnceAudit()
    with pytest.raises(KpiCalculationError):
        _service(conninfo, failing).recalculate(request, context)
    failed = _rows(engine, "SELECT id, operation_id, state FROM app.analytic_run")
    assert len(failed) == 1 and failed[0]["state"] == "FAILED"
    assert _rows(engine, "SELECT id FROM app.kpi_observation") == []
    finished = _service(conninfo).recalculate(request, context)
    assert finished.analytic_run_id == failed[0]["id"]
    assert _rows(engine, "SELECT operation_id, state FROM app.analytic_run") == [{"operation_id": failed[0]["operation_id"], "state": "COMPLETED"}]
    assert len(_rows(engine, "SELECT id FROM app.kpi_observation")) == 1


@pytest.mark.requires_db
def test_persisted_projection_effect_routes_to_kpi_calculation(database) -> None:
    engine, conninfo = database
    source = _source(engine, family="CONTRATOS_DOCUMENTOS")
    record = ValidatedTabularRecord(source, SourceFamily.CONTRACTS_DOCUMENTS, 1, MappingProxyType({
        "ID_Contrato": f"C-{uuid4()}", "Fecha_Solicitud": "2026-01-01", "Fecha_Firma": "2026-01-10",
        "Fecha_Vencimiento": "2026-02-15", "Estado_Revision": "No iniciado",
    }))
    actor = AuthenticatedPrincipal(uuid4(), uuid4(), "analyst", 1, frozenset({"ANALISTA"}), frozenset({"ingest.execute"}))
    effects = ProjectionService(ProjectionRepository(conninfo)).project(record, ProjectionContext(uuid4(), uuid4(), actor))
    assert len(effects) == 1 and effects[0].result == "INCORPORADO"
    # Simula que la ingesta ocurrió dentro del periodo calculado (corte as-of de RC-03).
    with engine.begin() as connection:
        connection.execute(sa.text("UPDATE app.contract_record SET created_at=:at, updated_at=:at"), {"at": INGESTED_AT})
    service = _service(conninfo)
    request = service.request_for_projection(effects, period_start=date(2026, 1, 1), period_end=date(2026, 1, 31), as_of_date=date(2026, 1, 15))
    assert request is not None and request.kpi_codes == ("KPI-RC-01", "KPI-RC-03")
    result = service.recalculate(request, _context())
    by_code = {row["kpi_code"]: row["value"] for row in _rows(engine, "SELECT kpi_code, value FROM app.kpi_observation")}
    assert by_code == {"KPI-RC-01": Decimal(9), "KPI-RC-03": Decimal(1)}
    assert len(result.observations) == 2


# --- F-01: semántica as-of de los KPI snapshot y agregados por fecha de negocio ---

def _month(month: int, day: int | None = None, codes: tuple[str, ...] = ("KPI-RC-03",)) -> KpiRecalculationRequest:
    start = date(2026, month, 1)
    end = (start.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
    return KpiRecalculationRequest(codes, start, end, end if day is None else date(2026, month, day))


def _state(engine, code: str):
    return _rows(engine, """SELECT id, analytic_run_id, dimensions, value, availability, as_of_date, calculated_at
                              FROM app.kpi_observation WHERE kpi_code=:code ORDER BY period_start, dimensions::text""", code=code)


def _compliance(engine, *, deadline: date = date(2026, 1, 10), created_at: datetime = INGESTED_AT) -> None:
    source = _source(engine, family="CUMPLIMIENTO")
    with engine.begin() as connection:
        connection.execute(sa.text("""INSERT INTO app.compliance_obligation
            (id_obligacion, fecha_limite, evidencia_cumplimiento, payload_sha256, source_record_id, created_at, updated_at)
            VALUES (:id, :deadline, NULL, :digest, :source, :created, :created)"""),
            {"id": f"O-{uuid4()}", "deadline": deadline, "digest": bytes(32), "source": source, "created": created_at})


LATE_IN_PERIOD = datetime(2026, 1, 20, 12, tzinfo=UTC)
SNAPSHOT_SEEDS = {
    "KPI-RC-03": lambda engine, at: _contract(engine, expiry=date(2026, 2, 15), created_at=at),
    "KPI-LI-01": lambda engine, at: _litigation(engine, "alto", Decimal("100"), None, created_at=at),
    "KPI-CN-02": lambda engine, at: _compliance(engine, created_at=at),
    "KPI-CD-03": lambda engine, at: _ocr_version(engine, f"D-{uuid4()}", 1, confidence=Decimal("0.90") if at == INGESTED_AT else Decimal("0.50"), processed_at=at),
}


@pytest.mark.requires_db
@pytest.mark.parametrize("code", sorted(SNAPSHOT_SEEDS))
def test_snapshot_finalizado_al_cierre_no_se_reescribe(database, code) -> None:
    engine, conninfo = database
    SNAPSHOT_SEEDS[code](engine, INGESTED_AT)
    # El cálculo con corte al último día, ejecutado después de terminado el mes, finaliza el snapshot.
    _service(conninfo).recalculate(_month(1, codes=(code,)), _context())
    finalized = _state(engine, code)
    assert finalized and all(row["as_of_date"] == date(2026, 1, 31) for row in finalized)
    # Un registro que sí entra en el corte cambiaría el valor si el snapshot se recalculara.
    SNAPSHOT_SEEDS[code](engine, LATE_IN_PERIOD)
    result = _service(conninfo).recalculate(_month(1, codes=(code,)), _context())
    assert _state(engine, code) == finalized
    assert [(item.value, item.availability) for item in result.observations] == [(row["value"], row["availability"]) for row in finalized]


@pytest.mark.requires_db
def test_snapshot_del_periodo_abierto_se_recalcula_y_el_cierre_lo_finaliza(database) -> None:
    engine, conninfo = database
    _contract(engine, expiry=date(2026, 2, 15))
    _service(conninfo).recalculate(_month(1, 15), _context())
    assert [row["value"] for row in _state(engine, "KPI-RC-03")] == [1]
    _contract(engine, expiry=date(2026, 2, 15), created_at=LATE_IN_PERIOD)
    # Corte al último día calculado mientras ese día sigue en curso: el periodo continúa abierto.
    _service(conninfo).recalculate(_month(1), _context())
    with engine.begin() as connection:
        connection.execute(sa.text("UPDATE app.kpi_observation SET calculated_at='2026-01-31T18:00:00Z'"))
    assert [row["value"] for row in _state(engine, "KPI-RC-03")] == [2]
    _contract(engine, expiry=date(2026, 2, 15), created_at=datetime(2026, 1, 31, 20, tzinfo=UTC))
    _service(conninfo).recalculate(_month(1), _context())
    closed = _state(engine, "KPI-RC-03")
    assert [row["value"] for row in closed] == [3] and closed[0]["calculated_at"] >= datetime(2026, 2, 1, tzinfo=UTC)


@pytest.mark.requires_db
def test_snapshot_excluye_registros_ingresados_despues_del_corte(database) -> None:
    engine, conninfo = database
    # El corte de enero termina a la medianoche de la Ciudad de México (06:00 UTC del 1 de febrero).
    after_cutoff = day_start(date(2026, 2, 1)) + timedelta(seconds=1)
    for at in (INGESTED_AT, after_cutoff):
        _contract(engine, expiry=date(2026, 2, 15), created_at=at)
        _litigation(engine, "medio", Decimal("10"), None, created_at=at)
        _compliance(engine, created_at=at)
    _service(conninfo).recalculate(_month(1, codes=("KPI-RC-03", "KPI-LI-01", "KPI-CN-02")), _context())
    rows = _rows(engine, "SELECT kpi_code, dimensions, value FROM app.kpi_observation")
    values = {(row["kpi_code"], row["dimensions"].get("nivel_severidad")): row["value"] for row in rows}
    assert values[("KPI-RC-03", None)] == 1 and values[("KPI-CN-02", None)] == 1
    assert values[("KPI-LI-01", "medio")] == Decimal("10")


@pytest.mark.requires_db
def test_snapshot_incluye_lo_ingresado_la_ultima_noche_del_mes_en_hora_de_mexico(database) -> None:
    """31 ene 23:00 en la Ciudad de México ya es 1 feb en UTC, pero pertenece al corte de enero."""
    engine, conninfo = database
    last_night = datetime(2026, 2, 1, 5, 0, tzinfo=UTC)
    for at in (INGESTED_AT, last_night):
        _contract(engine, expiry=date(2026, 2, 15), created_at=at)
        _compliance(engine, created_at=at)
    _service(conninfo).recalculate(_month(1, codes=("KPI-RC-03", "KPI-CN-02")), _context())
    rows = _rows(engine, "SELECT kpi_code, value FROM app.kpi_observation")
    values = {row["kpi_code"]: row["value"] for row in rows}
    assert values["KPI-RC-03"] == 2 and values["KPI-CN-02"] == 2


@pytest.mark.requires_db
def test_kpi_por_fecha_de_negocio_admite_recalculo_historico(database) -> None:
    engine, conninfo = database
    _litigation(engine, "bajo", None, None)
    _service(conninfo).recalculate(_month(1, codes=("KPI-LI-05",)), _context())
    assert [row["value"] for row in _state(engine, "KPI-LI-05")] == [1]
    # Ingesta tardía de un litigio abierto en enero: RF-038 reemplaza el agregado del mes de negocio.
    _litigation(engine, "bajo", None, None, created_at=datetime.now(UTC))
    _service(conninfo).recalculate(_month(1, codes=("KPI-LI-05",)), _context())
    assert [row["value"] for row in _state(engine, "KPI-LI-05")] == [2]


@pytest.mark.requires_db
def test_cd03_no_consume_ocr_procesados_despues_del_corte(database) -> None:
    engine, conninfo = database
    revised = f"D-{uuid4()}"
    _ocr_version(engine, revised, 1, confidence=Decimal("0.90"), processed_at=datetime(2026, 1, 10, tzinfo=UTC))
    _ocr_version(engine, revised, 2, confidence=Decimal("0.50"), processed_at=datetime(2026, 2, 3, tzinfo=UTC))
    _ocr_version(engine, f"D-{uuid4()}", 1, confidence=Decimal("0.40"), processed_at=datetime(2026, 2, 3, tzinfo=UTC))
    _service(conninfo).recalculate(_month(1, codes=("KPI-CD-03",)), _context())
    _service(conninfo).recalculate(_month(2, codes=("KPI-CD-03",)), _context())
    january, february = _state(engine, "KPI-CD-03")
    assert (january["value"], january["availability"]) == (Decimal(100), "DISPONIBLE")
    assert (february["value"], february["availability"]) == (Decimal(0), "DISPONIBLE")


@pytest.mark.requires_db
def test_cd03_sin_ocr_hasta_el_corte_es_no_disponible(database) -> None:
    engine, conninfo = database
    _ocr_version(engine, f"D-{uuid4()}", 1, confidence=Decimal("0.95"), processed_at=datetime(2026, 2, 3, tzinfo=UTC))
    _service(conninfo).recalculate(_month(1, codes=("KPI-CD-03",)), _context())
    assert [(row["value"], row["availability"]) for row in _state(engine, "KPI-CD-03")] == [(None, "NO_DISPONIBLE")]


def _proactive(engine, conninfo):
    job_id, operation_id, correlation_id = uuid4(), uuid4(), uuid4()
    with engine.begin() as connection:
        connection.execute(sa.text("""INSERT INTO app.job_run (id, case_type, state, actor_process, result_references, operation_id, correlation_id)
            VALUES (:id, 'PROACTIVE_ANALYSIS', 'STARTED', 'controlled_ingestion.proactive_analysis', '{}'::jsonb, :operation, :correlation)"""),
            {"id": job_id, "operation": operation_id, "correlation": correlation_id})
    context = ProactiveAnalysisContext(job_id, operation_id, correlation_id, "controlled_ingestion.proactive_analysis")
    return ProactiveAnalysisService(AnalyticsRepository(conninfo), SecurityRepository(conninfo)).execute(context)


@pytest.mark.requires_db
def test_intento_de_recalculo_historico_no_altera_el_analisis_vigente(database) -> None:
    engine, conninfo = database
    for month in range(1, 8):
        end = _month(month).period_end
        _contract(engine, expiry=end + timedelta(days=10), created_at=datetime(2026, month, 2, 12, tzinfo=UTC))
        _service(conninfo).recalculate(_month(month), _context())
    first = _proactive(engine, conninfo)
    assert first.status == "COMPLETED"
    observations = _state(engine, "KPI-RC-03")
    _contract(engine, expiry=date(2026, 6, 5), created_at=datetime(2026, 5, 20, tzinfo=UTC))
    _service(conninfo).recalculate(_month(5), _context())
    assert _state(engine, "KPI-RC-03") == observations
    second = _proactive(engine, conninfo)
    assert second.status == "NO_RELEVANT_WORK"
    assert second.input_fingerprint_sha256 == first.input_fingerprint_sha256
    completed = _rows(engine, "SELECT id FROM app.analytic_run WHERE run_type='PROACTIVE_ANALYSIS' AND state='COMPLETED'")
    assert [row["id"] for row in completed] == [first.analytic_run_id]


@pytest.mark.requires_db
def test_snapshot_sin_carga_aceptada_antes_del_corte_es_no_disponible(database) -> None:
    """SRS v0.22: la familia sin cobertura al corte da No disponible; con cobertura y cero elegibles da 0."""
    engine, conninfo = database
    with engine.begin() as connection:
        connection.execute(sa.text("TRUNCATE app.ingest_file, app.source_record, app.contract_record, app.litigation, app.compliance_obligation CASCADE"))
    _service(conninfo).recalculate(_month(1, codes=("KPI-RC-03", "KPI-LI-01", "KPI-CN-02")), _context())
    rows = _rows(engine, "SELECT kpi_code, value, availability FROM app.kpi_observation ORDER BY kpi_code, dimensions::text")
    assert len(rows) == 5 and all((row["value"], row["availability"]) == (None, "NO_DISPONIBLE") for row in rows)
    # Carga aceptada de cada familia antes del corte, sin elementos elegibles: el snapshot es 0.
    for family in ("CONTRATOS_DOCUMENTOS", "LITIGIOS", "CUMPLIMIENTO"):
        _source(engine, family=family, received_at=datetime(2026, 2, 3, tzinfo=UTC))
    _service(conninfo).recalculate(_month(2, codes=("KPI-RC-03", "KPI-LI-01", "KPI-CN-02")), _context())
    february = _rows(engine, "SELECT value, availability FROM app.kpi_observation WHERE period_start='2026-02-01'")
    assert len(february) == 5 and all((row["value"], row["availability"]) == (0, "DISPONIBLE") for row in february)

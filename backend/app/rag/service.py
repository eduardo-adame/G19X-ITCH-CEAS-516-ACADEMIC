"""Composición segura de recuperación, generación y auditoría RAG."""
from __future__ import annotations

from dataclasses import dataclass
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5

import psycopg
from psycopg.rows import dict_row

from app.rag.gates import is_decision_request
from app.rag.grounded_generation import SUPPORTED, build_messages, parse_grounded_output, response_format, split_citable_evidence
from app.rag.models import EvidenceState, ProcessingOutcome, RankedFragment, RetrievalContext, RetrievalError
from app.rag.operation_repository import RagOperationRepository
from app.rag.provider import GroqFailure, GroqProvider
from app.rag.retrieval import RetrievalService
from app.rag.retrieval_repository import RetrievalRepository
from app.security.models import AuthenticatedPrincipal, AuthenticationError, AuthorizationError, SecurityError
from app.security.rag_query_hash import canonical_rag_query_sha256
from app.security.repository import SecurityRepository
from app.security.service import SecurityService


_MESSAGES = {
    "EVIDENCIA_INSUFICIENTE": "La evidencia recuperada es insuficiente para responder con fundamento.",
    "SIN_EVIDENCIA": "No se recuperaron fragmentos autorizados para la consulta.",
    "SIN_AUTORIZACION": "Acceso no autorizado.",
}
_FAILURE_MESSAGE = "La generación no pudo completarse; se conservan los fragmentos autorizados disponibles."
# Gate 1: restricción de aplicación, distinta de los estados de evidencia y del Estado 4.
SCOPE_RESTRICTION = "RESTRICCION_ALCANCE"
_RESTRICTION_MESSAGE = (
    "El sistema puede aportar evidencia documental, pero no toma decisiones jurídicas por usted. "
    "Reformule la consulta como una solicitud de evidencia, por ejemplo: «¿Qué cláusulas o documentos "
    "son relevantes para evaluar esta decisión?»."
)


class RagApplicationError(RuntimeError):
    """Error de aplicación apto para traducirse sin detalles protegidos."""

    def __init__(self, message: str, status_code: int = 503) -> None:
        super().__init__(message)
        self.status_code = status_code


@dataclass(frozen=True)
class RagApplicationResult:
    status_code: int
    payload: dict


class RagApplicationService:
    """Es dueño de la finalización transaccional, nunca de las reglas de RETRIEVAL."""

    def __init__(
        self,
        *,
        conninfo: str,
        security: SecurityService,
        retrieval: RetrievalService,
        provider: GroqProvider,
        repository: RagOperationRepository | None = None,
    ) -> None:
        self.conninfo = conninfo
        self.security = security
        self.retrieval = retrieval
        self.provider = provider
        self.repository = repository or RagOperationRepository()

    def _connection(self) -> psycopg.Connection:
        return psycopg.connect(self.conninfo, autocommit=True, row_factory=dict_row)

    @staticmethod
    def _identity(principal: AuthenticatedPrincipal, key: UUID | None) -> UUID:
        if key is None:
            return uuid4()
        return uuid5(NAMESPACE_URL, f"riesgo-legal:rag-query:{principal.account_id}:{key}")

    def _context_reference(
        self, connection: psycopg.Connection, principal: AuthenticatedPrincipal, candidate: UUID | None
    ) -> UUID | None:
        if candidate is None:
            return None
        try:
            self.security.revalidate_functional_access(connection, principal, "dashboard.read")
        except SecurityError:
            return None
        return candidate if self.repository.valid_context_reference(connection, candidate) else None

    def _audit_denied_retry(self, principal: AuthenticatedPrincipal) -> None:
        try:
            with self._connection() as connection:
                with connection.transaction():
                    SecurityRepository.write_audit_event(
                        connection, actor=principal, action="AUTHORIZATION_DENIED",
                        resource_type="RAG_OPERATION", resource_identifier=None,
                        result="DENIED", correlation_id=uuid4(), safe_cause_code="DEFAULT_DENY",
                    )
        except (psycopg.Error, SecurityError):
            raise RagApplicationError("La operación no pudo completarse") from None

    @staticmethod
    def _matches(
        row: dict,
        principal: AuthenticatedPrincipal,
        query_hash: bytes,
        context_reference_id: UUID | None,
    ) -> bool:
        return bool(
            row["user_id"] == principal.account_id
            and row["session_id"] == principal.session_id
            and bytes(row["query_sha256"]) == query_hash
            and row["context_reference_id"] == context_reference_id
        )

    def _present(
        self, connection: psycopg.Connection, principal: AuthenticatedPrincipal, row: dict,
        *, audit_denial_retry: bool = True,
    ) -> RagApplicationResult:
        try:
            # El bloqueo de cuenta/sesión vive hasta materializar el texto final.
            with connection.transaction():
                scope = self.security.authorized_document_scope(connection, principal)
                if row["state"] == "SIN_AUTORIZACION":
                    fragments = ()
                else:
                    fragment_ids = self.repository.final_fragment_ids(connection, row["id"])
                    if not RetrievalRepository().final_fragments_still_authorized(connection, scope, fragment_ids):
                        raise AuthorizationError("Acceso no autorizado")
                    fragments = self.repository.final_fragments(connection, row["id"])
        except AuthenticationError:
            raise RagApplicationError("Credenciales o sesión no válidas", 401) from None
        except AuthorizationError:
            if row["state"] != "SIN_AUTORIZACION":
                if audit_denial_retry:
                    self._audit_denied_retry(principal)
                raise RagApplicationError("Acceso no autorizado", 403) from None
            fragments = ()
        if row.get("policy_result") == SCOPE_RESTRICTION:
            return RagApplicationResult(
                200,
                {
                    "operation_id": row["operation_id"],
                    "correlation_id": row["correlation_id"],
                    "state": None,
                    "policy_result": SCOPE_RESTRICTION,
                    "operation_status": row["operation_status"],
                    "generation_status": row["generation_status"],
                    "generated_response": None,
                    "safe_result_message": row["safe_result_message"],
                    "context_reference_id": row["context_reference_id"],
                    "fragments": [],
                    "citations": [],
                },
            )
        if row["state"] == "SIN_AUTORIZACION":
            if audit_denial_retry:
                self._audit_denied_retry(principal)
            return RagApplicationResult(
                403,
                {
                    "operation_id": row["operation_id"],
                    "correlation_id": row["correlation_id"],
                    "state": "SIN_AUTORIZACION",
                    "policy_result": None,
                    "operation_status": "COMPLETED",
                    "generation_status": "NOT_REQUESTED",
                    "generated_response": None,
                    "safe_result_message": _MESSAGES["SIN_AUTORIZACION"],
                    "context_reference_id": None,
                    "fragments": [],
                    "citations": [],
                },
            )
        public_fragments = [
            {
                "fragment_id": item["fragment_id"],
                "fragment_text": item["fragment_text"],
                "usage": item["usage"],
                "document_id": str(item["document_id"]),
                "document_name": item["document_name"],
                "document_type": item["document_type"],
                "document_date": item["document_date"],
                "page_start": item["page_start"],
                "page_end": item["page_end"],
                "section": item["section"],
                "clause": item["clause"],
            }
            for item in fragments
        ]
        citations = [
            {
                "handle": f"E{position}",
                "fragment_id": item["fragment_id"],
                "document_id": str(item["document_id"]),
                "document_name": item["document_name"],
                "document_type": item["document_type"],
                "document_date": item["document_date"],
                "page_start": item["page_start"],
                "page_end": item["page_end"],
                "section": item["section"],
                "clause": item["clause"],
            }
            for position, item in enumerate(fragments, 1)
            if item["usage"] == "EVIDENCE"
        ]
        state = row["state"]
        status = 503 if row["operation_status"] == "FAILED" else 200
        return RagApplicationResult(
            status,
            {
                "operation_id": row["operation_id"],
                "correlation_id": row["correlation_id"],
                "state": state,
                "policy_result": None,
                "operation_status": row["operation_status"],
                "generation_status": row["generation_status"],
                "generated_response": row["generated_response"] if status == 200 else None,
                "safe_result_message": row["safe_result_message"],
                "context_reference_id": row["context_reference_id"],
                "fragments": public_fragments,
                "citations": citations,
            },
        )

    def _existing_result(
        self,
        principal: AuthenticatedPrincipal,
        operation_id: UUID,
        query_hash: bytes,
        context_reference_id: UUID | None,
        *, audit_denial_retry: bool = True,
    ) -> RagApplicationResult | None:
        with self._connection() as connection:
            row = self.repository.find(connection, operation_id)
            if row is None:
                return None
            if not self._matches(row, principal, query_hash, context_reference_id):
                raise RagApplicationError("Conflicto de identidad de operación", 409)
            return self._present(connection, principal, row, audit_denial_retry=audit_denial_retry)

    def _authorize_final(
        self, connection: psycopg.Connection, principal: AuthenticatedPrincipal,
        fragments: tuple[RankedFragment, ...],
    ) -> bool:
        with connection.transaction():
            try:
                scope = self.security.authorized_document_scope(connection, principal)
            except SecurityError:
                return False
            return RetrievalRepository().final_fragments_still_authorized(
                connection, scope, tuple(fragment.fragment_id for fragment in fragments)
            )

    def _finalize(
        self,
        *,
        principal: AuthenticatedPrincipal,
        operation_id: UUID,
        correlation_id: UUID,
        query_hash: bytes,
        context_reference_id: UUID | None,
        state: str | None,
        fragments: tuple[RankedFragment, ...] = (),
        generated_response: str | None = None,
        evidence_ids: frozenset[UUID] = frozenset(),
        failure_cause: str | None = None,
        policy_result: str | None = None,
        generation_attempted: bool = False,
        abstained: bool = False,
    ) -> RagApplicationResult:
        created = False
        try:
            with self._connection() as connection:
                with connection.transaction():
                    self.repository.lock_operation(connection, operation_id)
                    existing = self.repository.find(connection, operation_id)
                    if existing is not None:
                        if not self._matches(existing, principal, query_hash, context_reference_id):
                            raise RagApplicationError("Conflicto de identidad de operación", 409)
                        # La autorización se comprueba otra vez al leer el resultado confirmado.
                    else:
                        audit_cause = failure_cause
                        if policy_result is None and state != "SIN_AUTORIZACION" and not self._authorize_final(connection, principal, fragments):
                            state, fragments, generated_response = "SIN_AUTORIZACION", (), None
                            evidence_ids, failure_cause = frozenset(), None
                        if policy_result == SCOPE_RESTRICTION:
                            # Sin recuperación ni proveedor: no hay fragmentos ni recursos documentales.
                            state, fragments, generated_response = None, (), None
                            operation_status, generation_status = "COMPLETED", "NOT_REQUESTED"
                            message, action, audit_result = _RESTRICTION_MESSAGE, "RAG_QUERY", "RESTRICTED"
                            audit_cause = "AUTONOMOUS_DECISION_REQUEST"
                        elif state == "SIN_AUTORIZACION":
                            fragments, generated_response = (), None
                            operation_status, generation_status = "COMPLETED", "NOT_REQUESTED"
                            message, action, audit_result = _MESSAGES[state], "AUTHORIZATION_DENIED", "DENIED"
                        elif state is None and generation_attempted:
                            # Fallo técnico o contractual del proveedor: sin estado final de evidencia,
                            # se conservan los fragmentos autorizados como referencia (RF-060).
                            operation_status, generation_status = "FAILED", "FAILED"
                            message, action, audit_result = _FAILURE_MESSAGE, "RAG_QUERY", "FAILURE"
                        elif state is None:
                            fragments = ()
                            operation_status, generation_status = "FAILED", "NOT_REQUESTED"
                            message, action, audit_result = "La consulta no pudo completarse.", "RAG_QUERY", "FAILURE"
                        elif state == "EVIDENCIA_SUFICIENTE":
                            operation_status, generation_status = "COMPLETED", "SUCCEEDED"
                            message, action, audit_result = None, "RAG_QUERY", "SUCCESS"
                        elif state == "EVIDENCIA_INSUFICIENTE" and abstained:
                            # El proveedor se abstuvo: la evidencia no responde lo preguntado (Estado 2).
                            operation_status, generation_status = "COMPLETED", "ABSTAINED"
                            message, action, audit_result = _MESSAGES[state], "RAG_QUERY", "SUCCESS"
                        else:
                            operation_status, generation_status = "COMPLETED", "NOT_REQUESTED"
                            message, action, audit_result = _MESSAGES[state], "RAG_QUERY", "SUCCESS"
                        row_id = self.repository.insert_operation(
                            connection,
                            operation_id=operation_id,
                            user_id=principal.account_id,
                            session_id=principal.session_id,
                            query_sha256=query_hash,
                            correlation_id=correlation_id,
                            context_reference_id=context_reference_id,
                            state=state,
                            operation_status=operation_status,
                            generation_status=generation_status,
                            safe_cause_code=failure_cause,
                            generated_response=generated_response,
                            safe_result_message=message,
                            policy_result=policy_result,
                        )
                        resources = self.repository.insert_fragments(
                            connection, row_id, fragments, evidence_ids, state=state
                        )
                        SecurityRepository.write_rag_audit_event(
                            connection, actor=principal, rag_operation_id=row_id,
                            operation_id=operation_id, correlation_id=correlation_id,
                            query_sha256=query_hash, action=action, result=audit_result,
                            safe_cause_code=audit_cause if policy_result else failure_cause, resources=resources,
                        )
                        created = True
            result = self._existing_result(
                principal, operation_id, query_hash, context_reference_id,
                audit_denial_retry=not (created and state == "SIN_AUTORIZACION"),
            )
            if result is None:
                raise RagApplicationError("La operación no pudo completarse")
            return result
        except RagApplicationError:
            raise
        except (psycopg.Error, SecurityError):
            raise RagApplicationError("La operación no pudo completarse") from None

    def execute(
        self,
        *,
        principal: AuthenticatedPrincipal,
        query: str,
        idempotency_key: UUID | None = None,
        context_reference_id: UUID | None = None,
    ) -> RagApplicationResult:
        if not isinstance(query, str) or not query.strip() or len(query) > 4096:
            raise RagApplicationError("Consulta no válida", 422)
        query_hash = canonical_rag_query_sha256(query)
        operation_id = self._identity(principal, idempotency_key)
        correlation_id = uuid4()
        try:
            with self._connection() as connection:
                reference = self._context_reference(connection, principal, context_reference_id)
                if idempotency_key is not None:
                    existing = self._existing_result(principal, operation_id, query_hash, reference)
                    if existing is not None:
                        return existing
                try:
                    self.security.revalidate_functional_access(connection, principal, "document.query")
                except AuthenticationError:
                    raise RagApplicationError("Credenciales o sesión no válidas", 401) from None
                except AuthorizationError:
                    return self._finalize(
                        principal=principal, operation_id=operation_id, correlation_id=correlation_id,
                        query_hash=query_hash, context_reference_id=reference,
                        state="SIN_AUTORIZACION",
                    )
                # Gate 1 (política): antes de recuperar documentos y sin consultar el corpus.
                try:
                    query_vector = tuple(float(value) for value in self.retrieval.encoder.encode_query(query))
                    restricted = is_decision_request(query, query_vector)
                except Exception:
                    return self._finalize(
                        principal=principal, operation_id=operation_id, correlation_id=correlation_id,
                        query_hash=query_hash, context_reference_id=reference,
                        state=None, failure_cause="EMBEDDING_UNAVAILABLE",
                    )
                if restricted:
                    return self._finalize(
                        principal=principal, operation_id=operation_id, correlation_id=correlation_id,
                        query_hash=query_hash, context_reference_id=reference,
                        state=None, policy_result=SCOPE_RESTRICTION,
                    )
                try:
                    result = self.retrieval.retrieve(
                        connection,
                        RetrievalContext(principal, query, operation_id, correlation_id, reference, query_vector),
                    )
                except AuthenticationError:
                    raise RagApplicationError("Credenciales o sesión no válidas", 401) from None
                except AuthorizationError:
                    return self._finalize(
                        principal=principal, operation_id=operation_id, correlation_id=correlation_id,
                        query_hash=query_hash, context_reference_id=reference,
                        state="SIN_AUTORIZACION",
                    )
                except RetrievalError:
                    return self._finalize(
                        principal=principal, operation_id=operation_id, correlation_id=correlation_id,
                        query_hash=query_hash, context_reference_id=reference,
                        state=None, failure_cause="RETRIEVAL_FAILED",
                    )
            # El schema terminal no conserva rangos; estos handles permanecen
            # estables entre la primera respuesta y los reintentos persistidos.
            fragments = tuple(sorted(result.fragments, key=lambda item: str(item.fragment_id)))
            if result.state is not ProcessingOutcome.GENERATION_CANDIDATE:
                if result.state not in (EvidenceState.EVIDENCIA_INSUFICIENTE, EvidenceState.SIN_EVIDENCIA):
                    # Los controles locales solo descartan; nunca declaran Estado 1 por sí solos.
                    return self._finalize(
                        principal=principal, operation_id=operation_id, correlation_id=correlation_id,
                        query_hash=query_hash, context_reference_id=reference,
                        state=None, failure_cause="INTERNAL_FAILURE",
                    )
                return self._finalize(
                    principal=principal, operation_id=operation_id, correlation_id=correlation_id,
                    query_hash=query_hash, context_reference_id=reference,
                    state=str(result.state), fragments=fragments,
                )

            # Elegibilidad de la evidencia: al proveedor solo llega la evidencia con cita completa.
            # La incompleta sigue disponible como referencia parcial, pero no puede sustentar el Estado 1.
            citable, _reference_only = split_citable_evidence(fragments)
            if not citable:
                return self._finalize(
                    principal=principal, operation_id=operation_id, correlation_id=correlation_id,
                    query_hash=query_hash, context_reference_id=reference,
                    state="EVIDENCIA_INSUFICIENTE", fragments=fragments,
                )

            def before_send() -> None:
                with self._connection() as fresh:
                    if not self._authorize_final(fresh, principal, citable):
                        raise AuthorizationError("Acceso no autorizado")

            # Una sola llamada: verifica el soporte, se abstiene o responde con handles entregados.
            try:
                raw = self.provider.generate(
                    build_messages(query, citable), before_send=before_send, response_format=response_format(citable),
                )
                outcome = parse_grounded_output(raw, citable)
            except AuthorizationError:
                return self._finalize(
                    principal=principal, operation_id=operation_id, correlation_id=correlation_id,
                    query_hash=query_hash, context_reference_id=reference,
                    state="SIN_AUTORIZACION",
                )
            except GroqFailure as exc:
                # Error técnico o salida que incumple el contrato: nunca Estado 1, 2 ni 3.
                return self._finalize(
                    principal=principal, operation_id=operation_id, correlation_id=correlation_id,
                    query_hash=query_hash, context_reference_id=reference,
                    state=None, fragments=fragments, failure_cause=exc.cause_code, generation_attempted=True,
                )
            if outcome.status == SUPPORTED:
                # El Estado 1 conserva exactamente la evidencia enviada: sus handles públicos coinciden
                # con los que vio el proveedor (mismo orden por fragment_id).
                return self._finalize(
                    principal=principal, operation_id=operation_id, correlation_id=correlation_id,
                    query_hash=query_hash, context_reference_id=reference,
                    state="EVIDENCIA_SUFICIENTE", fragments=citable,
                    generated_response=outcome.answer, evidence_ids=outcome.evidence_ids,
                )
            return self._finalize(
                principal=principal, operation_id=operation_id, correlation_id=correlation_id,
                query_hash=query_hash, context_reference_id=reference,
                state="EVIDENCIA_INSUFICIENTE", fragments=fragments, abstained=True,
            )
        except RagApplicationError:
            raise
        except psycopg.Error:
            raise RagApplicationError("La operación no pudo completarse") from None

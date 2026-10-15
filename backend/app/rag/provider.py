"""Cliente HTTPS acotado para la generación RAG con Groq."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
import json
import logging
import math
import random
import re
from http.client import IncompleteRead
import socket
import ssl
import time
from collections.abc import Callable, Hashable, Sequence
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, HTTPSHandler, ProxyHandler, Request, build_opener

from app.rag.provider_capacity import (
    LOCAL_CAPACITY_EXHAUSTED,
    CapacityLimits,
    CapacityRejected,
    ProviderCapacityManager,
)


GROQ_BASE_URL = "https://api.groq.com/openai/v1"
GROQ_MODEL = "openai/gpt-oss-120b"
GROQ_CHAT_URL = f"{GROQ_BASE_URL}/chat/completions"
GROQ_USER_AGENT = "RiesgoLegalMVP/0.1"
PROVIDER_CONTRACT_FAILURE = "PROVIDER_CONTRACT_FAILURE"

_LOGGER = logging.getLogger("app.rag.provider")
_DURATION_PART = re.compile(r"(\d+(?:\.\d+)?)(ms|h|m|s)")


class GroqFailure(RuntimeError):
    """Fallo seguro de la dependencia externa, sin contenido de la solicitud."""

    def __init__(self, cause_code: str, retry_after_seconds: float | None = None) -> None:
        super().__init__("La generación no pudo completarse")
        self.cause_code = cause_code
        self.retry_after_seconds = retry_after_seconds


@dataclass
class ProviderTelemetry:
    """Telemetría exacta de una operación lógica con el proveedor; nunca contiene contenido."""

    http_attempts: int = 0
    rate_limit_count: int = 0
    wait_ms: int = 0
    latency_ms: int = 0
    failure_cause: str | None = None
    retry_after_seconds: float | None = None
    started: bool = False

    @property
    def retries(self) -> int:
        return max(self.http_attempts - 1, 0)


@dataclass(frozen=True)
class ProviderPolicy:
    """Política de reintentos y plazos; los valores de producción provienen de ``Settings``."""

    max_retries: int = 2
    backoff_base_seconds: float = 1.0
    backoff_max_seconds: float = 8.0
    retry_after_max_seconds: float = 60.0
    operation_deadline_seconds: float = 45.0
    prompt_bytes_per_token: float = 3.0
    completion_token_reserve: int = 512

    def __post_init__(self) -> None:
        if (not 0 <= self.max_retries <= 2 or not 0 < self.backoff_base_seconds <= self.backoff_max_seconds
                or self.retry_after_max_seconds <= 0 or self.operation_deadline_seconds <= 0
                or self.prompt_bytes_per_token <= 0 or self.completion_token_reserve <= 0):
            raise ValueError("Política del proveedor no válida")


DEFAULT_LIMITS = CapacityLimits(max_concurrency=1, rpm_limit=27, tpm_limit=6_400, max_queue=8, max_in_flight_per_owner=1)


class _RejectRedirects(HTTPRedirectHandler):
    """Impide reenviar la clave o los fragmentos a cualquier URL redirigida."""

    def redirect_request(self, request, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None


def _default_opener():
    return build_opener(
        ProxyHandler({}),
        HTTPSHandler(context=ssl.create_default_context()),
        _RejectRedirects(),
    )


def _header(headers, name: str) -> str | None:
    if headers is None or not hasattr(headers, "get"):
        return None
    for key in (name, name.lower(), name.title()):
        value = headers.get(key)
        if value is not None:
            return str(value).strip()
    return None


def _parse_duration(value: str | None) -> float | None:
    """Duraciones de Groq como «7.66s», «2m59.56s» o «120ms»."""
    if not value:
        return None
    try:
        return float(value)
    except ValueError:
        pass
    parts = _DURATION_PART.findall(value)
    if not parts or "".join(number + unit for number, unit in parts) != value.replace(" ", ""):
        return None
    factors = {"h": 3600.0, "m": 60.0, "s": 1.0, "ms": 0.001}
    return sum(float(number) * factors[unit] for number, unit in parts)


def _parse_int(value: str | None) -> int | None:
    try:
        return int(value) if value is not None else None
    except ValueError:
        return None


def parse_retry_after(value: str | None, *, now: datetime | None = None) -> float | None:
    """Segundos de ``Retry-After`` (número o fecha HTTP); None si falta o no es válido."""
    if not value:
        return None
    try:
        seconds = float(value)
    except ValueError:
        try:
            moment = parsedate_to_datetime(value)
        except (TypeError, ValueError, IndexError):
            return None
        if moment.tzinfo is None:
            return None
        seconds = (moment - (now or datetime.now(UTC))).total_seconds()
    if not math.isfinite(seconds) or seconds < 0:
        return None
    return seconds


class GroqProvider:
    """Envía solo mensajes aprobados al único origen HTTPS permitido, dentro del presupuesto compartido."""

    def __init__(
        self,
        *,
        api_key: str | None,
        timeout_seconds: float,
        max_request_bytes: int = 60_000,
        opener=None,
        sleep: Callable[[float], None] = time.sleep,
        capacity: ProviderCapacityManager | None = None,
        policy: ProviderPolicy | None = None,
        clock: Callable[[], float] = time.monotonic,
        jitter: Callable[[], float] = random.random,
    ) -> None:
        if timeout_seconds <= 0 or max_request_bytes <= 0 or max_request_bytes > 60_000:
            raise ValueError("Configuración Groq no válida")
        self._api_key = api_key or ""
        self._timeout_seconds = timeout_seconds
        self._max_request_bytes = max_request_bytes
        self._opener = opener or _default_opener()
        self._sleep = sleep
        self._policy = policy or ProviderPolicy()
        # Producción comparte un único gestor por proceso; una instancia sin gestor recibe uno propio.
        self._capacity = capacity or ProviderCapacityManager(DEFAULT_LIMITS, clock=clock)
        self._clock = clock
        self._jitter = jitter

    @property
    def capacity(self) -> ProviderCapacityManager:
        return self._capacity

    def _backoff(self, attempt: int) -> float:
        """Backoff exponencial acotado con jitter (mitad fija y mitad aleatoria)."""
        ceiling = min(self._policy.backoff_max_seconds, self._policy.backoff_base_seconds * (2 ** attempt))
        return ceiling / 2 + max(min(self._jitter(), 1.0), 0.0) * ceiling / 2

    def _note_limits(self, headers) -> None:
        self._capacity.note_provider_limits(
            _parse_int(_header(headers, "x-ratelimit-remaining-tokens")),
            _parse_duration(_header(headers, "x-ratelimit-reset-tokens")),
            _parse_int(_header(headers, "x-ratelimit-remaining-requests")),
            _parse_duration(_header(headers, "x-ratelimit-reset-requests")),
        )

    def generate(
        self,
        messages: Sequence[dict[str, str]],
        *,
        before_send: Callable[[], None],
        response_format: dict | None = None,
        owner: Hashable | None = None,
        telemetry: ProviderTelemetry | None = None,
    ) -> str:
        """Revalida antes de cada POST, incluso al reintentar un 429; cada intento vuelve a pedir capacidad.

        ``response_format`` solicita salida estructurada con esquema estricto en la misma llamada.
        ``owner`` es la identidad autenticada que limita a una generación activa por usuario.
        """
        telemetry = telemetry if telemetry is not None else ProviderTelemetry()
        telemetry.started = True
        started = self._clock()
        outcome = "ABORTED"
        try:
            value = self._generate(messages, before_send, response_format, owner, telemetry, started)
            outcome = "SUCCESS"
            return value
        except GroqFailure:
            outcome = "FAILURE"
            self._capacity.record("provider_failures")
            raise
        finally:
            telemetry.latency_ms = int(round((self._clock() - started) * 1000))
            # Línea estructurada sin contenido: ni consulta, ni prompt, ni fragmentos, ni identidad, ni secretos.
            _LOGGER.info(json.dumps({
                "event": "provider_operation", "http_attempts": telemetry.http_attempts,
                "rate_limited_responses": telemetry.rate_limit_count, "retries": telemetry.retries,
                "wait_ms": telemetry.wait_ms, "latency_ms": telemetry.latency_ms,
                "outcome": outcome, "cause": telemetry.failure_cause,
            }, separators=(",", ":")))

    def _fail(self, telemetry: ProviderTelemetry, cause: str, retry_after: float | None = None) -> GroqFailure:
        telemetry.failure_cause = PROVIDER_CONTRACT_FAILURE if cause == "INVALID_PROVIDER_OUTPUT" else cause
        telemetry.retry_after_seconds = retry_after
        return GroqFailure(cause, retry_after)

    def _generate(self, messages, before_send, response_format, owner, telemetry, started) -> str:
        if not self._api_key:
            raise self._fail(telemetry, "PROVIDER_UNAVAILABLE")
        body = {
            "model": GROQ_MODEL,
            "messages": list(messages),
            "max_completion_tokens": 4096,
            "include_reasoning": False,
        }
        if response_format is not None:
            body["response_format"] = response_format
        payload = json.dumps(
            body,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        if len(payload) > self._max_request_bytes:
            raise self._fail(telemetry, "CONTEXT_LIMIT_EXCEEDED")
        # Reserva conservadora: bytes del cuerpo como entrada más una reserva fija para la salida.
        estimate = math.ceil(len(payload) / self._policy.prompt_bytes_per_token) + self._policy.completion_token_reserve
        deadline = started + self._policy.operation_deadline_seconds
        owner_key = owner if owner is not None else object()
        operation = object()
        try:
            self._capacity.begin_operation(owner_key)
        except CapacityRejected as exc:
            raise self._fail(telemetry, LOCAL_CAPACITY_EXHAUSTED, exc.retry_after_seconds) from None
        try:
            for attempt in range(self._policy.max_retries + 1):
                waited_from = self._clock()
                try:
                    lease = self._capacity.acquire(estimate, deadline=deadline, operation=operation)
                except CapacityRejected as exc:
                    telemetry.wait_ms += int(round((self._clock() - waited_from) * 1000))
                    raise self._fail(telemetry, LOCAL_CAPACITY_EXHAUSTED, exc.retry_after_seconds) from None
                telemetry.wait_ms += int(round((self._clock() - waited_from) * 1000))
                actual_tokens = None
                delay = None
                try:
                    before_send()
                    remaining = deadline - self._clock()
                    if remaining <= 0:
                        raise self._fail(telemetry, LOCAL_CAPACITY_EXHAUSTED, 1.0)
                    request = Request(
                        GROQ_CHAT_URL,
                        data=payload,
                        method="POST",
                        headers={
                            "Authorization": f"Bearer {self._api_key}",
                            "Content-Type": "application/json",
                            "Accept": "application/json",
                            "User-Agent": GROQ_USER_AGENT,
                        },
                    )
                    telemetry.http_attempts += 1
                    self._capacity.record("http_attempts")
                    if attempt:
                        self._capacity.record("retries")
                    try:
                        with self._opener.open(request, timeout=min(self._timeout_seconds, remaining)) as response:
                            if response.status != 200 or response.geturl() != GROQ_CHAT_URL:
                                raise self._fail(telemetry, "PROVIDER_UNAVAILABLE")
                            raw = response.read(1_048_577)
                            self._note_limits(getattr(response, "headers", None))
                        if len(raw) > 1_048_576:
                            raise self._fail(telemetry, "INVALID_PROVIDER_OUTPUT")
                        parsed = json.loads(raw)
                        usage = parsed.get("usage") if isinstance(parsed, dict) else None
                        if isinstance(usage, dict) and isinstance(usage.get("total_tokens"), int):
                            actual_tokens = usage["total_tokens"]
                        value = parsed["choices"][0]["message"]["content"]
                        if not isinstance(value, str) or not value.strip():
                            raise self._fail(telemetry, "INVALID_PROVIDER_OUTPUT")
                        self._capacity.record("provider_success")
                        return value.strip()
                    except HTTPError as exc:
                        self._note_limits(exc.headers)
                        if exc.code != 429:
                            raise self._fail(telemetry, "PROVIDER_UNAVAILABLE") from None
                        telemetry.rate_limit_count += 1
                        self._capacity.record("http_429")
                        retry_after = parse_retry_after(_header(exc.headers, "Retry-After"))
                        if retry_after is not None and retry_after > self._policy.retry_after_max_seconds:
                            # Un Retry-After largo no se espera: se informa para reintentar más tarde.
                            raise self._fail(telemetry, "PROVIDER_RATE_LIMITED", retry_after) from None
                        delay = retry_after if retry_after is not None else self._backoff(attempt)
                        self._capacity.note_rate_limited(delay, operation)
                        if attempt == self._policy.max_retries or self._clock() + delay > deadline:
                            raise self._fail(telemetry, "PROVIDER_RATE_LIMITED", delay) from None
                    except (socket.timeout, TimeoutError):
                        raise self._fail(telemetry, "PROVIDER_TIMEOUT") from None
                    except URLError as exc:
                        if isinstance(exc.reason, (TimeoutError, socket.timeout)):
                            raise self._fail(telemetry, "PROVIDER_TIMEOUT") from None
                        raise self._fail(telemetry, "PROVIDER_UNAVAILABLE") from None
                    except GroqFailure:
                        raise
                    except (OSError, IncompleteRead):
                        raise self._fail(telemetry, "PROVIDER_UNAVAILABLE") from None
                    except (ValueError, KeyError, IndexError, TypeError, UnicodeDecodeError):
                        raise self._fail(telemetry, "INVALID_PROVIDER_OUTPUT") from None
                finally:
                    # La ranura no se retiene mientras se espera el reintento.
                    self._capacity.release(lease, actual_tokens)
                waited_from = self._clock()
                self._sleep(delay)
                telemetry.wait_ms += int(round((self._clock() - waited_from) * 1000))
            raise self._fail(telemetry, "PROVIDER_RATE_LIMITED")
        finally:
            self._capacity.end_operation(owner_key)

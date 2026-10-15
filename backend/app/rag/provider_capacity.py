"""Control centralizado de capacidad del proveedor generativo, local al proceso (F-14).

Todas las operaciones RAG del proceso comparten un único presupuesto: concurrencia,
solicitudes por minuto (RPM) y tokens por minuto (TPM) estimados antes de cada intento y
conciliados con el uso real. Un 429 con ``Retry-After`` enfría todo el proceso, no solo la
solicitud que lo recibió. Las cabeceras ``x-ratelimit-*`` del proveedor solo pueden hacer el
control más restrictivo. La espera es acotada, ordenada por llegada y sin espera activa.

El presupuesto es correcto con un único proceso; ``Settings`` exige un solo worker.
"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
import itertools
import threading
import time
from typing import Callable, Hashable

LOCAL_CAPACITY_EXHAUSTED = "LOCAL_CAPACITY_EXHAUSTED"


@dataclass(frozen=True)
class CapacityLimits:
    max_concurrency: int
    rpm_limit: int
    tpm_limit: int
    max_queue: int
    max_in_flight_per_owner: int
    window_seconds: float = 60.0

    def __post_init__(self) -> None:
        if (self.max_concurrency < 1 or self.rpm_limit < 1 or self.tpm_limit < 1 or self.max_queue < 0
                or self.max_in_flight_per_owner < 1 or self.window_seconds <= 0):
            raise ValueError("Límites de capacidad del proveedor no válidos")


class CapacityRejected(Exception):
    """No hay capacidad dentro del plazo de la operación: no se envía nada al proveedor."""

    def __init__(self, reason: str, retry_after_seconds: float | None) -> None:
        super().__init__("Capacidad del proveedor no disponible")
        self.reason = reason
        self.retry_after_seconds = retry_after_seconds


@dataclass
class _Reservation:
    at: float
    tokens: int


@dataclass
class AttemptLease:
    """Una ranura de concurrencia y una reserva de tokens para un único intento HTTP."""

    reservation: _Reservation
    released: bool = field(default=False)


class ProviderCapacityManager:
    def __init__(
        self,
        limits: CapacityLimits,
        *,
        clock: Callable[[], float] = time.monotonic,
        wait: Callable[[threading.Condition, float], object] | None = None,
    ) -> None:
        self.limits = limits
        self._clock = clock
        self._condition = threading.Condition()
        # En pruebas con reloj simulado, la espera avanza el reloj en lugar de dormir.
        self._wait = wait or (lambda condition, timeout: condition.wait(timeout))
        self._tickets = itertools.count()
        self._queue: deque[int] = deque()
        self._in_flight = 0
        self._owners: dict[Hashable, int] = {}
        self._attempt_times: deque[float] = deque()
        self._reservations: deque[_Reservation] = deque()
        self._cooldown_until = 0.0
        self._cooldown_source: object | None = None
        self._remote_tokens: int | None = None
        self._remote_tokens_reset = 0.0
        self._remote_requests_reset = 0.0
        self._counters = {
            "logical_operations": 0, "http_attempts": 0, "http_429": 0, "provider_success": 0,
            "provider_failures": 0, "retries": 0, "local_capacity_rejections": 0, "wait_ms": 0,
        }

    # --- Operaciones lógicas y equidad -----------------------------------

    def begin_operation(self, owner: Hashable) -> None:
        """Una generación activa por propietario (identidad autenticada); el presupuesto sigue siendo global."""
        with self._condition:
            if self._owners.get(owner, 0) >= self.limits.max_in_flight_per_owner:
                self._counters["local_capacity_rejections"] += 1
                raise CapacityRejected("OWNER_BUSY", None)
            self._owners[owner] = self._owners.get(owner, 0) + 1
            self._counters["logical_operations"] += 1

    def end_operation(self, owner: Hashable) -> None:
        with self._condition:
            remaining = self._owners.get(owner, 0) - 1
            if remaining > 0:
                self._owners[owner] = remaining
            else:
                self._owners.pop(owner, None)
            self._condition.notify_all()

    # --- Intentos HTTP ----------------------------------------------------

    def acquire(self, tokens: int, *, deadline: float, operation: object,
                cancelled: Callable[[], bool] | None = None) -> AttemptLease:
        """Espera turno, ranura y presupuesto RPM/TPM sin superar el plazo; si no caben, rechaza sin enviar."""
        tokens = max(int(tokens), 1)
        with self._condition:
            if tokens > self.limits.tpm_limit:
                self._counters["local_capacity_rejections"] += 1
                raise CapacityRejected("REQUEST_EXCEEDS_TPM", None)
            ticket = next(self._tickets)
            now = self._clock()
            self._prune(now)
            immediate = (not self._queue and self._in_flight < self.limits.max_concurrency
                         and self._available_at(now, tokens, operation) <= now)
            # Cola acotada: si hay que esperar y ya hay max_queue en espera, se rechaza al instante sin ocupar un hilo.
            if not immediate and len(self._queue) >= self.limits.max_queue:
                self._counters["local_capacity_rejections"] += 1
                raise CapacityRejected("QUEUE_FULL", self._time_estimate(now, tokens, operation))
            self._queue.append(ticket)
            started = self._clock()
            try:
                while True:
                    now = self._clock()
                    self._prune(now)
                    if cancelled is not None and cancelled():
                        raise CapacityRejected("CANCELLED", None)
                    available_at = self._available_at(now, tokens, operation)
                    if self._queue[0] == ticket and self._in_flight < self.limits.max_concurrency and available_at <= now:
                        self._queue.popleft()
                        self._in_flight += 1
                        self._attempt_times.append(now)
                        reservation = _Reservation(now, tokens)
                        self._reservations.append(reservation)
                        if self._remote_tokens is not None and now < self._remote_tokens_reset:
                            self._remote_tokens = max(self._remote_tokens - tokens, 0)
                        self._counters["wait_ms"] += int(round((now - started) * 1000))
                        self._condition.notify_all()
                        return AttemptLease(reservation)
                    if available_at > deadline or now >= deadline:
                        raise CapacityRejected("DEADLINE", max(available_at - now, 1.0))
                    wake = available_at if available_at > now else deadline
                    self._wait(self._condition, max(min(wake, deadline) - now, 0.0))
            except CapacityRejected:
                self._counters["local_capacity_rejections"] += 1
                raise
            finally:
                if ticket in self._queue:
                    self._queue.remove(ticket)
                    self._condition.notify_all()

    def release(self, lease: AttemptLease, actual_tokens: int | None = None) -> None:
        """Libera la ranura y concilia la reserva con el uso real cuando el proveedor lo informa."""
        with self._condition:
            if lease.released:
                return
            lease.released = True
            self._in_flight -= 1
            if actual_tokens is not None and actual_tokens >= 0:
                lease.reservation.tokens = int(actual_tokens)
            self._condition.notify_all()

    def note_rate_limited(self, delay_seconds: float, operation: object) -> None:
        """Enfriamiento global: ninguna otra operación envía antes de que venza."""
        with self._condition:
            until = self._clock() + max(delay_seconds, 0.0)
            if until > self._cooldown_until:
                self._cooldown_until = until
                self._cooldown_source = operation
            self._condition.notify_all()

    def note_provider_limits(self, remaining_tokens: int | None, tokens_reset_seconds: float | None,
                             remaining_requests: int | None, requests_reset_seconds: float | None) -> None:
        """Las señales del proveedor solo endurecen el control: nunca amplían los límites locales."""
        with self._condition:
            now = self._clock()
            if remaining_tokens is not None and remaining_tokens >= 0:
                self._remote_tokens = remaining_tokens
                self._remote_tokens_reset = now + (tokens_reset_seconds if tokens_reset_seconds and tokens_reset_seconds > 0
                                                   else self.limits.window_seconds)
            if remaining_requests == 0 and requests_reset_seconds and requests_reset_seconds > 0:
                self._remote_requests_reset = max(self._remote_requests_reset, now + requests_reset_seconds)

    # --- Contadores exactos (sin contenido) --------------------------------

    def record(self, counter: str, amount: int = 1) -> None:
        with self._condition:
            self._counters[counter] += amount

    def snapshot(self) -> dict[str, float | int]:
        with self._condition:
            now = self._clock()
            return {**self._counters, "in_flight": self._in_flight, "queue_depth": len(self._queue),
                    "cooldown_remaining_seconds": max(self._cooldown_until - now, 0.0)}

    # --- Cálculo interno -----------------------------------------------------

    def _prune(self, now: float) -> None:
        horizon = now - self.limits.window_seconds
        while self._attempt_times and self._attempt_times[0] <= horizon:
            self._attempt_times.popleft()
        while self._reservations and self._reservations[0].at <= horizon:
            self._reservations.popleft()

    def _available_at(self, now: float, tokens: int, operation: object) -> float:
        """Primer instante en que caben RPM, TPM, enfriamiento y señales del proveedor."""
        at = now
        # La operación que recibió el 429 ya espera su propio Retry-After/backoff; el resto respeta el enfriamiento.
        if self._cooldown_until > now and self._cooldown_source is not operation:
            at = max(at, self._cooldown_until)
        window = self.limits.window_seconds
        if len(self._attempt_times) >= self.limits.rpm_limit:
            at = max(at, self._attempt_times[len(self._attempt_times) - self.limits.rpm_limit] + window)
        used = sum(item.tokens for item in self._reservations)
        if used + tokens > self.limits.tpm_limit:
            running = used
            for item in self._reservations:
                running -= item.tokens
                if running + tokens <= self.limits.tpm_limit:
                    at = max(at, item.at + window)
                    break
        if self._remote_tokens is not None and now < self._remote_tokens_reset and tokens > self._remote_tokens:
            at = max(at, self._remote_tokens_reset)
        if now < self._remote_requests_reset:
            at = max(at, self._remote_requests_reset)
        return at

    def _time_estimate(self, now: float, tokens: int, operation: object) -> float:
        return max(self._available_at(now, tokens, operation) - now, 1.0)


def capacity_limits_from_settings(settings) -> CapacityLimits:
    return CapacityLimits(
        max_concurrency=settings.groq_max_concurrency,
        rpm_limit=settings.groq_rpm_limit,
        tpm_limit=settings.groq_tpm_limit,
        max_queue=settings.groq_max_queue,
        max_in_flight_per_owner=settings.groq_max_in_flight_per_user,
    )

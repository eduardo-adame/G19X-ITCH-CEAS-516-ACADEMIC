"""Pruebas del transporte Groq sin filtrar secretos ni datos documentales."""
from __future__ import annotations

import json
from http.client import IncompleteRead
import socket
from urllib.error import HTTPError, URLError

import pytest

from app.config import Settings
from app.rag.provider import GROQ_CHAT_URL, GROQ_USER_AGENT, GroqFailure, GroqProvider, _RejectRedirects


class _Response:
    status = 200

    def __init__(self, content: str = "Respuesta [E1]", reasoning: str | None = None) -> None:
        self.content = content
        self.reasoning = reasoning

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def geturl(self):
        return GROQ_CHAT_URL

    def read(self, _size):
        return json.dumps({"choices": [{"message": {"content": self.content, "reasoning": self.reasoning}}]}).encode()


class _Opener:
    def __init__(self, outcomes):
        self.outcomes = iter(outcomes)
        self.requests = []

    def open(self, request, timeout):
        self.requests.append((request, timeout))
        outcome = next(self.outcomes)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


def _messages():
    return ({"role": "system", "content": "Solo evidencia"}, {"role": "user", "content": "Texto sintético"})


def test_groq_key_is_masked_in_settings_representation() -> None:
    settings = Settings(_env_file=None, groq_api_key="clave-sintetica")
    assert settings.groq_api_key is not None
    assert settings.groq_api_key.get_secret_value() == "clave-sintetica"
    assert "clave-sintetica" not in repr(settings)


def test_provider_sends_only_to_fixed_https_origin_with_timeout() -> None:
    opener = _Opener([_Response()])
    provider = GroqProvider(api_key="clave-sintetica", timeout_seconds=7, opener=opener)
    assert provider.generate(_messages(), before_send=lambda: None) == "Respuesta [E1]"
    request, timeout = opener.requests[0]
    assert request.full_url == GROQ_CHAT_URL
    assert timeout == 7
    assert request.get_header("User-agent") == GROQ_USER_AGENT
    payload = json.loads(request.data)
    assert payload["model"] == "openai/gpt-oss-120b"
    assert payload["include_reasoning"] is False
    assert b"Texto sint" in request.data


def test_provider_uses_final_content_not_separate_reasoning() -> None:
    provider = GroqProvider(
        api_key="clave-sintetica", timeout_seconds=7,
        opener=_Opener([_Response("Respuesta final [E1]", "Razón interna no presentable")]),
    )
    assert provider.generate(_messages(), before_send=lambda: None) == "Respuesta final [E1]"


def test_429_retries_twice_and_revalidates_before_every_post() -> None:
    error = HTTPError(GROQ_CHAT_URL, 429, "rate", {}, None)
    opener = _Opener([error, error, _Response()])
    checks = []
    provider = GroqProvider(api_key="clave-sintetica", timeout_seconds=1, opener=opener, sleep=lambda delay: None)
    assert provider.generate(_messages(), before_send=lambda: checks.append(True)) == "Respuesta [E1]"
    assert len(checks) == len(opener.requests) == 3


def test_revocation_between_429_attempts_prevents_second_post() -> None:
    opener = _Opener([HTTPError(GROQ_CHAT_URL, 429, "rate", {}, None)])
    calls = 0

    def check():
        nonlocal calls
        calls += 1
        if calls == 2:
            raise PermissionError("revocado")

    provider = GroqProvider(api_key="clave-sintetica", timeout_seconds=1, opener=opener, sleep=lambda delay: None)
    with pytest.raises(PermissionError):
        provider.generate(_messages(), before_send=check)
    assert calls == 2
    assert len(opener.requests) == 1


@pytest.mark.parametrize("code", [302, 307, 308])
def test_redirect_is_not_followed_or_retried(code) -> None:
    assert _RejectRedirects().redirect_request(None, None, code, "redirect", {}, "https://other.invalid") is None
    opener = _Opener([HTTPError(GROQ_CHAT_URL, code, "redirect", {"Location": "https://other.invalid"}, None)])
    provider = GroqProvider(api_key="clave-sintetica", timeout_seconds=1, opener=opener)
    with pytest.raises(GroqFailure) as error:
        provider.generate(_messages(), before_send=lambda: None)
    assert error.value.cause_code == "PROVIDER_UNAVAILABLE"
    assert len(opener.requests) == 1
    assert "clave-sintetica" not in str(error.value)


def test_timeout_and_invalid_provider_output_are_safe() -> None:
    timeout = GroqProvider(api_key="clave-sintetica", timeout_seconds=1, opener=_Opener([URLError(socket.timeout())]))
    with pytest.raises(GroqFailure) as error:
        timeout.generate(_messages(), before_send=lambda: None)
    assert error.value.cause_code == "PROVIDER_TIMEOUT"
    invalid = GroqProvider(api_key="clave-sintetica", timeout_seconds=1, opener=_Opener([_Response("")]))
    with pytest.raises(GroqFailure) as error:
        invalid.generate(_messages(), before_send=lambda: None)
    assert error.value.cause_code == "INVALID_PROVIDER_OUTPUT"


def test_missing_key_and_oversized_request_fail_before_post() -> None:
    opener = _Opener([])
    with pytest.raises(GroqFailure):
        GroqProvider(api_key=None, timeout_seconds=1, opener=opener).generate(_messages(), before_send=lambda: None)
    with pytest.raises(GroqFailure) as error:
        GroqProvider(api_key="clave-sintetica", timeout_seconds=1, max_request_bytes=10, opener=opener).generate(
            _messages(), before_send=lambda: None
        )
    assert error.value.cause_code == "CONTEXT_LIMIT_EXCEEDED"
    assert opener.requests == []


@pytest.mark.parametrize("failure", [ConnectionResetError("synthetic"), BrokenPipeError("synthetic")])
def test_transport_failure_is_a_safe_provider_failure(failure: OSError) -> None:
    provider = GroqProvider(api_key="clave-sintetica", timeout_seconds=1, opener=_Opener([failure]))
    with pytest.raises(GroqFailure) as error:
        provider.generate(_messages(), before_send=lambda: None)
    assert error.value.cause_code == "PROVIDER_UNAVAILABLE"
    assert "synthetic" not in str(error.value)


def test_truncated_response_is_a_safe_provider_failure() -> None:
    class Truncated(_Response):
        def read(self, _size):
            raise IncompleteRead(b"partial", 100)

    provider = GroqProvider(api_key="clave-sintetica", timeout_seconds=1, opener=_Opener([Truncated()]))
    with pytest.raises(GroqFailure) as error:
        provider.generate(_messages(), before_send=lambda: None)
    assert error.value.cause_code == "PROVIDER_UNAVAILABLE"


def test_exhausted_rate_limit_is_safe_and_revalidates_each_attempt() -> None:
    opener = _Opener([HTTPError(GROQ_CHAT_URL, 429, "rate", {}, None) for _ in range(3)])
    checks = []
    provider = GroqProvider(api_key="clave-sintetica", timeout_seconds=1, opener=opener, sleep=lambda _: None)
    with pytest.raises(GroqFailure) as error:
        provider.generate(_messages(), before_send=lambda: checks.append(True))
    assert error.value.cause_code == "PROVIDER_RATE_LIMITED"
    assert len(checks) == len(opener.requests) == 3


def test_request_limit_cannot_exceed_approved_maximum() -> None:
    with pytest.raises(ValueError):
        Settings(_env_file=None, groq_max_request_bytes=60_001)
    with pytest.raises(ValueError):
        GroqProvider(api_key="clave-sintetica", timeout_seconds=1, max_request_bytes=60_001)


# --- F-14: capacidad centralizada, 429, telemetría exacta (sin Groq real) ---

import logging  # noqa: E402

from app.rag.provider import ProviderPolicy, ProviderTelemetry, parse_retry_after  # noqa: E402
from app.rag.provider_capacity import CapacityLimits, ProviderCapacityManager  # noqa: E402


class _Clock:
    def __init__(self):
        self.now = 0.0
        self.sleeps = []

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds

    def wait(self, _condition, timeout):
        self.now += timeout


def _clocked(limits=None, policy=None, outcomes=(), jitter=lambda: 0.5):
    clock = _Clock()
    capacity = ProviderCapacityManager(limits or CapacityLimits(1, 27, 6_400, 8, 1), clock=clock, wait=clock.wait)
    opener = _Opener(list(outcomes))
    provider = GroqProvider(api_key="clave-sintetica", timeout_seconds=30, opener=opener, sleep=clock.sleep,
                            capacity=capacity, policy=policy or ProviderPolicy(), clock=clock, jitter=jitter)
    return provider, opener, clock, capacity


class _UsageResponse(_Response):
    def __init__(self, total_tokens=None, headers=None):
        super().__init__("Respuesta [E1]")
        self.total_tokens = total_tokens
        self.headers = headers or {}

    def read(self, _size):
        body = {"choices": [{"message": {"content": self.content}}]}
        if self.total_tokens is not None:
            body["usage"] = {"total_tokens": self.total_tokens}
        return json.dumps(body).encode()


def _rate_limited(headers=None):
    return HTTPError(GROQ_CHAT_URL, 429, "rate", headers or {}, None)


@pytest.mark.contract
def test_f_retry_after_valido_se_respeta_y_d_el_reintento_vuelve_a_pasar_por_el_gestor() -> None:
    provider, opener, clock, capacity = _clocked(outcomes=[_rate_limited({"Retry-After": "3"}), _UsageResponse(120)])
    telemetry = ProviderTelemetry()
    assert provider.generate(_messages(), before_send=lambda: None, telemetry=telemetry) == "Respuesta [E1]"
    assert clock.sleeps == [3.0]
    snapshot = capacity.snapshot()
    assert snapshot["http_attempts"] == 2 and snapshot["http_429"] == 1 and snapshot["retries"] == 1
    assert (telemetry.http_attempts, telemetry.rate_limit_count, telemetry.retries, telemetry.failure_cause) == (2, 1, 1, None)
    assert telemetry.wait_ms == 3_000 and telemetry.latency_ms == 3_000


@pytest.mark.contract
@pytest.mark.parametrize(("jitter", "expected"), [(0.0, [0.5, 1.0]), (1.0, [1.0, 2.0])])
def test_g_sin_retry_after_backoff_exponencial_con_jitter_controlable(jitter, expected) -> None:
    provider, _opener, clock, _ = _clocked(outcomes=[_rate_limited(), _rate_limited(), _UsageResponse()], jitter=lambda: jitter)
    provider.generate(_messages(), before_send=lambda: None)
    assert clock.sleeps == expected


@pytest.mark.contract
def test_backoff_queda_acotado_por_el_maximo() -> None:
    policy = ProviderPolicy(backoff_base_seconds=4.0, backoff_max_seconds=5.0)
    provider, _opener, clock, _ = _clocked(policy=policy, outcomes=[_rate_limited(), _rate_limited(), _UsageResponse()], jitter=lambda: 1.0)
    provider.generate(_messages(), before_send=lambda: None)
    assert clock.sleeps == [4.0, 5.0]


@pytest.mark.contract
def test_retry_after_mayor_que_el_maximo_no_se_espera_y_se_informa() -> None:
    provider, opener, clock, _ = _clocked(outcomes=[_rate_limited({"Retry-After": "600"})])
    telemetry = ProviderTelemetry()
    with pytest.raises(GroqFailure) as error:
        provider.generate(_messages(), before_send=lambda: None, telemetry=telemetry)
    assert error.value.cause_code == "PROVIDER_RATE_LIMITED" and error.value.retry_after_seconds == 600
    assert clock.sleeps == [] and len(opener.requests) == 1 and telemetry.failure_cause == "PROVIDER_RATE_LIMITED"


@pytest.mark.contract
def test_429_persistente_maximo_tres_intentos_y_telemetria_exacta() -> None:
    provider, opener, _clock, capacity = _clocked(outcomes=[_rate_limited({"Retry-After": "1"}) for _ in range(3)])
    telemetry = ProviderTelemetry()
    with pytest.raises(GroqFailure) as error:
        provider.generate(_messages(), before_send=lambda: None, telemetry=telemetry)
    assert error.value.cause_code == "PROVIDER_RATE_LIMITED"
    assert len(opener.requests) == 3 == telemetry.http_attempts == telemetry.rate_limit_count
    assert capacity.snapshot()["provider_failures"] == 1


@pytest.mark.contract
def test_e_un_429_enfria_globalmente_a_otras_operaciones() -> None:
    provider, _opener, clock, capacity = _clocked(outcomes=[_rate_limited({"Retry-After": "10"}), _rate_limited({"Retry-After": "10"}),
                                                            _rate_limited({"Retry-After": "10"})])
    with pytest.raises(GroqFailure):
        provider.generate(_messages(), before_send=lambda: None)
    # El último 429 deja un enfriamiento de 10 s que la operación de origen no espera (falla), pero sí cualquier otra.
    started = clock.now
    capacity.release(capacity.acquire(100, deadline=clock.now + 45, operation=object()))
    assert clock.now - started == pytest.approx(10.0)


@pytest.mark.contract
def test_k_plazo_insuficiente_cero_llamadas_http_y_retry_after() -> None:
    provider, opener, _clock, capacity = _clocked(limits=CapacityLimits(1, 1, 6_400, 8, 1),
                                                  policy=ProviderPolicy(operation_deadline_seconds=5), outcomes=[_UsageResponse()])
    capacity.release(capacity.acquire(100, deadline=45, operation=object()))      # RPM local agotado
    telemetry = ProviderTelemetry()
    with pytest.raises(GroqFailure) as error:
        provider.generate(_messages(), before_send=lambda: None, telemetry=telemetry)
    assert error.value.cause_code == "LOCAL_CAPACITY_EXHAUSTED" and error.value.retry_after_seconds > 5
    assert opener.requests == [] and telemetry.http_attempts == 0
    assert telemetry.failure_cause == "LOCAL_CAPACITY_EXHAUSTED"


@pytest.mark.contract
def test_c_mismo_usuario_segunda_generacion_simultanea_sin_http() -> None:
    provider, opener, _clock, capacity = _clocked(outcomes=[_UsageResponse()])
    capacity.begin_operation("usuario-a")                                          # generación en curso del mismo usuario
    with pytest.raises(GroqFailure) as error:
        provider.generate(_messages(), before_send=lambda: None, owner="usuario-a")
    assert error.value.cause_code == "LOCAL_CAPACITY_EXHAUSTED" and opener.requests == []
    assert provider.generate(_messages(), before_send=lambda: None, owner="usuario-b") == "Respuesta [E1]"


@pytest.mark.contract
def test_i_uso_real_concilia_la_reserva_y_j_cabeceras_endurecen() -> None:
    headers = {"x-ratelimit-remaining-tokens": "10", "x-ratelimit-reset-tokens": "7.5s"}
    provider, _opener, clock, capacity = _clocked(outcomes=[_UsageResponse(total_tokens=80, headers=headers)])
    provider.generate(_messages(), before_send=lambda: None)
    assert sum(item.tokens for item in capacity._reservations) == 80               # reserva conciliada con el uso real
    capacity.release(capacity.acquire(600, deadline=clock.now + 45, operation=object()))
    assert clock.now == pytest.approx(7.5)                                          # «remaining» bajo obliga a esperar el reset


@pytest.mark.contract
def test_timeout_y_no_disponible_sin_reintento_con_telemetria() -> None:
    for failure, cause in ((URLError(socket.timeout()), "PROVIDER_TIMEOUT"), (ConnectionResetError("x"), "PROVIDER_UNAVAILABLE"),
                           (HTTPError(GROQ_CHAT_URL, 503, "down", {}, None), "PROVIDER_UNAVAILABLE")):
        provider, opener, clock, capacity = _clocked(outcomes=[failure])
        telemetry = ProviderTelemetry()
        with pytest.raises(GroqFailure) as error:
            provider.generate(_messages(), before_send=lambda: None, telemetry=telemetry)
        assert error.value.cause_code == cause and len(opener.requests) == 1 and clock.sleeps == []
        assert (telemetry.http_attempts, telemetry.failure_cause) == (1, cause)
        assert capacity.snapshot()["in_flight"] == 0


@pytest.mark.contract
def test_revocacion_durante_la_espera_impide_el_envio_y_libera_la_ranura() -> None:
    provider, opener, _clock, capacity = _clocked(outcomes=[_UsageResponse()])

    def revoked():
        raise PermissionError("revocado")

    with pytest.raises(PermissionError):
        provider.generate(_messages(), before_send=revoked)
    assert opener.requests == [] and capacity.snapshot()["in_flight"] == 0


@pytest.mark.contract
def test_p_log_estructurado_sin_secretos_ni_contenido(caplog, monkeypatch) -> None:
    # El fileConfig de Alembic, ejecutado en proceso por las pruebas de migración, deshabilita los loggers existentes.
    monkeypatch.setattr(logging.getLogger("app.rag.provider"), "disabled", False)
    provider, _opener, _clock, _ = _clocked(outcomes=[_rate_limited({"Retry-After": "1"}), _UsageResponse()])
    with caplog.at_level(logging.INFO, logger="app.rag.provider"):
        provider.generate(_messages(), before_send=lambda: None, owner="usuario-a")
    lines = [record.getMessage() for record in caplog.records if record.name == "app.rag.provider"]
    assert len(lines) == 1
    entry = json.loads(lines[0])
    assert entry == {"event": "provider_operation", "http_attempts": 2, "rate_limited_responses": 1, "retries": 1,
                     "wait_ms": 1000, "latency_ms": 1000, "outcome": "SUCCESS", "cause": None}
    for secret in ("clave-sintetica", "Texto sintético", "Solo evidencia", "usuario-a", "Bearer"):
        assert secret not in lines[0]


@pytest.mark.contract
@pytest.mark.parametrize(("value", "expected"), [("3", 3.0), ("0", 0.0), ("2.5", 2.5), ("-1", None), ("abc", None), ("", None), (None, None)])
def test_parse_retry_after_valida_el_valor(value, expected) -> None:
    assert parse_retry_after(value) == expected


@pytest.mark.contract
def test_politica_invalida_se_rechaza() -> None:
    with pytest.raises(ValueError):
        ProviderPolicy(max_retries=3)
    with pytest.raises(ValueError):
        ProviderPolicy(backoff_base_seconds=5, backoff_max_seconds=1)


class _TimedOpener:
    """Opener seguro entre hilos que registra el instante monotónico de cada POST."""

    def __init__(self, outcomes):
        import threading
        self._lock = threading.Lock()
        self.outcomes = iter(outcomes)
        self.sent_at = []
        self.in_flight = 0
        self.max_in_flight = 0

    def open(self, request, timeout):
        import time
        with self._lock:
            self.sent_at.append(time.monotonic())
            self.in_flight += 1
            self.max_in_flight = max(self.max_in_flight, self.in_flight)
            outcome = next(self.outcomes)
        try:
            time.sleep(0.02)
            if isinstance(outcome, Exception):
                raise outcome
            return outcome
        finally:
            with self._lock:
                self.in_flight -= 1


@pytest.mark.contract
def test_16_tormenta_n_hilos_ante_429_ningun_post_antes_del_enfriamiento_y_total_acotado() -> None:
    import threading
    import time
    workers = 4
    opener = _TimedOpener([_rate_limited({"Retry-After": "1"})] + [_UsageResponse(50) for _ in range(workers)])
    capacity = ProviderCapacityManager(CapacityLimits(1, 27, 6_400, 8, 1))
    provider = GroqProvider(api_key="clave-sintetica", timeout_seconds=30, opener=opener, capacity=capacity,
                            policy=ProviderPolicy())
    results, start = [], threading.Barrier(workers)

    def run(index):
        start.wait()
        results.append(provider.generate(_messages(), before_send=lambda: None, owner=f"usuario-{index}"))

    threads = [threading.Thread(target=run, args=(index,)) for index in range(workers)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=20)
    assert results == ["Respuesta [E1]"] * workers
    # Un único 429 y un POST correcto por operación: N + 1 envíos, nunca una ráfaga de reintentos.
    assert len(opener.sent_at) == workers + 1 and opener.max_in_flight == 1
    first_429 = opener.sent_at[0]
    assert all(sent - first_429 >= 1.0 for sent in opener.sent_at[1:])
    snapshot = capacity.snapshot()
    assert (snapshot["http_attempts"], snapshot["http_429"], snapshot["retries"]) == (workers + 1, 1, 1)

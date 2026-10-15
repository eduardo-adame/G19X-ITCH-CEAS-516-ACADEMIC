"""Configuración centralizada de capacidad del proveedor e invariante de un único worker (F-14)."""
from __future__ import annotations

from pathlib import Path
import re

import pytest

from app.config import Settings
from app.rag.api import RagQueryResponse, query_rag
from app.rag.service import RagApplicationResult

PRODUCT_ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.contract
def test_valores_por_defecto_aprobados() -> None:
    settings = Settings(_env_file=None)
    assert (settings.groq_rpm_limit, settings.groq_tpm_limit, settings.groq_max_concurrency, settings.groq_max_retries) == (27, 6_400, 1, 2)
    assert settings.groq_max_in_flight_per_user == 1 and settings.backend_workers == 1


@pytest.mark.contract
@pytest.mark.parametrize("override", [
    {"groq_max_retries": 3}, {"groq_max_concurrency": 0}, {"groq_rpm_limit": 0}, {"groq_tpm_limit": 100},
    {"groq_backoff_base_seconds": 5, "groq_backoff_max_seconds": 2}, {"groq_operation_deadline_seconds": 1},
    {"groq_completion_token_reserve": 6_400, "groq_tpm_limit": 6_400}, {"groq_prompt_bytes_per_token": 0.5},
    {"groq_max_queue": -1}, {"backend_workers": 2},
])
def test_configuracion_invalida_impide_arrancar(override) -> None:
    with pytest.raises(ValueError):
        Settings(_env_file=None, **override)


@pytest.mark.contract
def test_web_concurrency_distinto_de_uno_impide_arrancar(monkeypatch) -> None:
    monkeypatch.setenv("WEB_CONCURRENCY", "4")
    with pytest.raises(ValueError):
        Settings(_env_file=None)
    monkeypatch.setenv("WEB_CONCURRENCY", "1")
    assert Settings(_env_file=None).backend_workers == 1


@pytest.mark.contract
def test_despliegue_fija_un_unico_worker() -> None:
    """Verificación estática: ningún arranque del backend declara más de un worker."""
    compose = (PRODUCT_ROOT / "docker-compose.yml").read_text(encoding="utf-8")
    dockerfile = (PRODUCT_ROOT / "backend" / "Dockerfile").read_text(encoding="utf-8")
    for source in (compose, dockerfile):
        for workers in re.findall(r"--workers[=\s]+(\S+)", source):
            assert workers.strip("\"'],") == "1"
    backend = compose.split("\n  backend:", 1)[1].split("\n  frontend:", 1)[0]
    assert 'BACKEND_WORKERS: "1"' in backend and 'WEB_CONCURRENCY: "1"' in backend


@pytest.mark.contract
def test_api_publica_retry_after_solo_cuando_el_servicio_lo_calcula() -> None:
    from fastapi import Response

    base = {"operation_id": "11111111-1111-4111-8111-111111111111", "correlation_id": "22222222-2222-4222-8222-222222222222",
            "state": None, "policy_result": None, "operation_status": "FAILED", "generation_status": "FAILED",
            "generated_response": None, "safe_result_message": "Límite de uso", "context_reference_id": None,
            "fragments": [], "citations": []}

    class Service:
        def __init__(self, payload):
            self.payload = payload
            self.calls = []

        def execute(self, **kwargs):
            self.calls.append(kwargs)
            return RagApplicationResult(503, self.payload)

    class Payload:
        query = "consulta"
        context_reference_id = None
        retry_of_operation_id = None

    response = Response()
    body = query_rag(Payload(), response, principal=object(), idempotency_key=None, service=Service({**base, "retry_after_seconds": 7}))
    assert response.status_code == 503 and response.headers["Retry-After"] == "7"
    assert isinstance(body, RagQueryResponse) and body.retry_after_seconds == 7
    replay = Response()
    query_rag(Payload(), replay, principal=object(), idempotency_key=None, service=Service({**base, "retry_after_seconds": None}))
    assert "Retry-After" not in replay.headers

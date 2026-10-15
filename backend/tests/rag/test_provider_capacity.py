"""Gestor de capacidad del proveedor (F-14): reloj monotónico simulado, sin Groq real."""
from __future__ import annotations

import threading
import time

import pytest

from app.rag.provider_capacity import CapacityLimits, CapacityRejected, ProviderCapacityManager


class FakeClock:
    """Reloj monotónico simulado: esperar avanza el tiempo en lugar de dormir (sin espera activa)."""

    def __init__(self) -> None:
        self.now = 0.0
        self.waits: list[float] = []

    def __call__(self) -> float:
        return self.now

    def wait(self, _condition, timeout: float) -> None:
        self.waits.append(timeout)
        self.now += timeout


def _manager(clock: FakeClock | None = None, **overrides) -> ProviderCapacityManager:
    limits = {"max_concurrency": 1, "rpm_limit": 27, "tpm_limit": 6_400, "max_queue": 8, "max_in_flight_per_owner": 1, **overrides}
    clock = clock or FakeClock()
    return ProviderCapacityManager(CapacityLimits(**limits), clock=clock, wait=clock.wait)


@pytest.mark.contract
def test_una_llamada_bajo_el_limite_no_espera() -> None:
    clock = FakeClock()
    manager = _manager(clock)
    lease = manager.acquire(1_000, deadline=45, operation=object())
    assert clock.waits == [] and manager.snapshot()["in_flight"] == 1
    manager.release(lease, actual_tokens=900)
    assert manager.snapshot()["in_flight"] == 0


@pytest.mark.contract
def test_rpm_agotado_espera_a_la_ventana_o_rechaza_si_no_cabe_en_el_plazo() -> None:
    clock = FakeClock()
    manager = _manager(clock, rpm_limit=2)
    for _ in range(2):
        manager.release(manager.acquire(100, deadline=45, operation=object()))
    with pytest.raises(CapacityRejected) as rejected:
        manager.acquire(100, deadline=10, operation=object())
    assert rejected.value.reason == "DEADLINE" and rejected.value.retry_after_seconds == pytest.approx(60)
    lease = manager.acquire(100, deadline=120, operation=object())
    assert clock.now == pytest.approx(60)
    manager.release(lease)


@pytest.mark.contract
def test_h_reserva_tpm_no_permite_sobrecompromiso_y_i_conciliacion_libera_el_exceso() -> None:
    clock = FakeClock()
    manager = _manager(clock, tpm_limit=1_000, max_concurrency=2)
    first = manager.acquire(600, deadline=45, operation=object())
    with pytest.raises(CapacityRejected) as rejected:
        manager.acquire(600, deadline=5, operation=object())
    assert rejected.value.reason == "DEADLINE"
    manager.release(first, actual_tokens=100)          # uso real informado por el proveedor
    second = manager.acquire(600, deadline=45, operation=object())
    assert clock.now == 0.0                            # cabe de inmediato tras conciliar
    manager.release(second)


@pytest.mark.contract
def test_solicitud_mayor_que_el_limite_tpm_se_rechaza_sin_esperar() -> None:
    with pytest.raises(CapacityRejected) as rejected:
        _manager(tpm_limit=1_000).acquire(5_000, deadline=45, operation=object())
    assert rejected.value.reason == "REQUEST_EXCEEDS_TPM"


@pytest.mark.contract
def test_j_cabeceras_del_proveedor_solo_endurecen_nunca_amplian() -> None:
    clock = FakeClock()
    manager = _manager(clock, tpm_limit=1_000)
    manager.note_provider_limits(remaining_tokens=50, tokens_reset_seconds=5, remaining_requests=None, requests_reset_seconds=None)
    lease = manager.acquire(600, deadline=45, operation=object())
    assert clock.now == pytest.approx(5)               # más restrictivo: espera al reset informado
    manager.release(lease)
    # Un «remaining» enorme no permite superar el límite local configurado.
    clock.now = 1_000
    manager.note_provider_limits(remaining_tokens=10_000_000, tokens_reset_seconds=60, remaining_requests=None, requests_reset_seconds=None)
    held = manager.acquire(900, deadline=1_045, operation=object())
    manager.release(held)
    with pytest.raises(CapacityRejected):
        manager.acquire(900, deadline=1_005, operation=object())


@pytest.mark.contract
def test_e_enfriamiento_global_afecta_a_otras_operaciones_no_a_la_que_recibio_el_429() -> None:
    clock = FakeClock()
    manager = _manager(clock)
    origin = object()
    manager.note_rate_limited(5.0, origin)
    manager.release(manager.acquire(100, deadline=45, operation=origin))
    assert clock.now == 0.0                            # la operación de origen ya espera su propio Retry-After
    other = manager.acquire(100, deadline=45, operation=object())
    assert clock.now == pytest.approx(5.0)             # el resto respeta el enfriamiento global
    manager.release(other)


@pytest.mark.contract
def test_c_mismo_usuario_no_tiene_dos_generaciones_y_b_usuarios_distintos_comparten_presupuesto() -> None:
    manager = _manager(rpm_limit=1)
    manager.begin_operation("usuario-a")
    with pytest.raises(CapacityRejected) as rejected:
        manager.begin_operation("usuario-a")
    assert rejected.value.reason == "OWNER_BUSY"
    manager.begin_operation("usuario-b")               # otro usuario puede operar...
    manager.release(manager.acquire(100, deadline=45, operation=object()))
    with pytest.raises(CapacityRejected):              # ...pero el presupuesto RPM es el mismo para ambos
        manager.acquire(100, deadline=10, operation=object())
    manager.end_operation("usuario-a")
    manager.begin_operation("usuario-a")


@pytest.mark.contract
def test_cola_llena_rechaza_al_instante_sin_bloquear() -> None:
    clock = FakeClock()
    manager = _manager(clock, max_queue=0)
    held = manager.acquire(100, deadline=45, operation=object())
    with pytest.raises(CapacityRejected) as rejected:
        manager.acquire(100, deadline=45, operation=object())
    assert rejected.value.reason == "QUEUE_FULL" and clock.waits == []
    manager.release(held)


@pytest.mark.contract
def test_cancelacion_durante_la_espera_libera_el_turno() -> None:
    clock = FakeClock()
    manager = _manager(clock, rpm_limit=1)
    manager.release(manager.acquire(100, deadline=45, operation=object()))
    with pytest.raises(CapacityRejected) as rejected:
        manager.acquire(100, deadline=120, operation=object(), cancelled=lambda: clock.now > 0)
    assert rejected.value.reason == "CANCELLED"
    assert manager.snapshot()["queue_depth"] == 0 and manager.snapshot()["in_flight"] == 0


@pytest.mark.contract
def test_k_plazo_insuficiente_no_concede_ningun_intento() -> None:
    manager = _manager(rpm_limit=1)
    manager.release(manager.acquire(100, deadline=45, operation=object()))
    with pytest.raises(CapacityRejected) as rejected:
        manager.acquire(100, deadline=3, operation=object())
    assert rejected.value.retry_after_seconds > 3
    assert manager.snapshot()["in_flight"] == 0


@pytest.mark.contract
def test_a_dos_solicitudes_simultaneas_respetan_la_concurrencia_global_con_hilos_reales() -> None:
    manager = ProviderCapacityManager(CapacityLimits(max_concurrency=1, rpm_limit=100, tpm_limit=100_000, max_queue=8,
                                                     max_in_flight_per_owner=1))
    active, peak, order = 0, 0, []
    lock = threading.Lock()

    def worker(name: str) -> None:
        nonlocal active, peak
        lease = manager.acquire(100, deadline=time.monotonic() + 10, operation=object())
        with lock:
            active += 1
            peak = max(peak, active)
            order.append(name)
        time.sleep(0.05)
        with lock:
            active -= 1
        manager.release(lease)

    threads = [threading.Thread(target=worker, args=(f"u{i}",)) for i in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(5)
    assert peak == 1 and len(order) == 4
    assert manager.snapshot()["in_flight"] == 0 and manager.snapshot()["queue_depth"] == 0


@pytest.mark.contract
def test_limites_invalidos_se_rechazan() -> None:
    with pytest.raises(ValueError):
        CapacityLimits(max_concurrency=0, rpm_limit=1, tpm_limit=1, max_queue=0, max_in_flight_per_owner=1)

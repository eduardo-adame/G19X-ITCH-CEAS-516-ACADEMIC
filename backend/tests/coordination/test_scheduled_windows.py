"""Ventanas de ejecución programada: no se aceptan periodos futuros, invertidos o extensos (RF-039)."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta, timezone

import pytest

from app.coordination.windows import ScheduledWindowError, validate_scheduled_window

NOW = datetime(2026, 10, 13, 12, 0, tzinfo=UTC)


@pytest.mark.contract
def test_ventana_diaria_transcurrida_se_acepta_en_utc() -> None:
    start, end = validate_scheduled_window(datetime(2026, 10, 12, tzinfo=UTC), datetime(2026, 10, 13, tzinfo=UTC), now=NOW)
    assert (start, end) == (datetime(2026, 10, 12, tzinfo=UTC), datetime(2026, 10, 13, tzinfo=UTC))


@pytest.mark.contract
def test_ventana_con_otra_zona_horaria_se_normaliza() -> None:
    cst = timezone(timedelta(hours=-6))
    start, _ = validate_scheduled_window(datetime(2026, 10, 12, 18, tzinfo=cst), datetime(2026, 10, 13, 6, tzinfo=cst), now=NOW)
    assert start == datetime(2026, 10, 13, 0, tzinfo=UTC)


@pytest.mark.contract
@pytest.mark.parametrize("start,end", [
    (datetime(2030, 1, 1, tzinfo=UTC), datetime(2030, 1, 2, tzinfo=UTC)),          # periodo futuro
    (datetime(2026, 10, 13, tzinfo=UTC), datetime(2026, 10, 14, tzinfo=UTC)),       # ventana aún no transcurrida
    (datetime(2026, 10, 12, tzinfo=UTC), datetime(2026, 10, 11, tzinfo=UTC)),       # invertida
    (datetime(2026, 10, 12, tzinfo=UTC), datetime(2026, 10, 12, tzinfo=UTC)),       # vacía
    (datetime(2026, 5, 1, tzinfo=UTC), datetime(2026, 10, 1, tzinfo=UTC)),          # rango extenso
    (datetime(2026, 10, 12), datetime(2026, 10, 13)),                                # sin zona horaria
])
def test_ventanas_no_programables_se_rechazan(start, end) -> None:
    with pytest.raises(ScheduledWindowError):
        validate_scheduled_window(start, end, now=NOW)


@pytest.mark.robustness
def test_tolerancia_de_reloj_acotada() -> None:
    validate_scheduled_window(datetime(2026, 10, 12, 12, 4, tzinfo=UTC), datetime(2026, 10, 13, 12, 4, tzinfo=UTC), now=NOW)
    with pytest.raises(ScheduledWindowError):
        validate_scheduled_window(datetime(2026, 10, 12, 12, 6, tzinfo=UTC), datetime(2026, 10, 13, 12, 6, tzinfo=UTC), now=NOW)

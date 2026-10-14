"""Validación de ventanas de ejecución programada (RF-039: ejecución diaria desatendida)."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

# El orquestador ejecuta una vez por día sobre el intervalo ya transcurrido; una
# ventana futura o de varios días no corresponde a una ejecución programada y
# permitiría fabricar observaciones de periodos que aún no existen.
MAX_WINDOW = timedelta(days=1)
CLOCK_TOLERANCE = timedelta(minutes=5)


class ScheduledWindowError(ValueError):
    """La ventana solicitada no corresponde a una ejecución programada válida."""


def validate_scheduled_window(start: datetime, end: datetime, *, now: datetime | None = None) -> tuple[datetime, datetime]:
    """Devuelve la ventana en UTC o rechaza ventanas futuras, invertidas o extensas."""
    if start.tzinfo is None or start.utcoffset() is None or end.tzinfo is None or end.utcoffset() is None:
        raise ScheduledWindowError("la ventana requiere zona horaria")
    start, end = start.astimezone(UTC), end.astimezone(UTC)
    if end <= start:
        raise ScheduledWindowError("la ventana debe terminar después de iniciar")
    if end - start > MAX_WINDOW:
        raise ScheduledWindowError("la ventana excede una ejecución diaria")
    if end > (now or datetime.now(UTC)) + CLOCK_TOLERANCE:
        raise ScheduledWindowError("la ventana todavía no ha transcurrido")
    return start, end

"""Calendario de negocio del sistema: hora de la Ciudad de México.

Los instantes se guardan como TIMESTAMPTZ y no cambian. Lo que depende de la zona
es el calendario: a qué día y a qué mes pertenece un instante, dónde termina el día
de corte de un KPI y qué fecha es «hoy». Todas esas derivaciones usan esta zona
(decisión del usuario, 2026-10-17), no la del contenedor ni la de la sesión SQL.
"""
from __future__ import annotations

from datetime import UTC, date, datetime, time
from zoneinfo import ZoneInfo

BUSINESS_TIMEZONE = "America/Mexico_City"
BUSINESS_TZ = ZoneInfo(BUSINESS_TIMEZONE)


def business_date(moment: datetime) -> date:
    """Día del calendario de negocio al que pertenece un instante (un instante sin zona se trata como UTC)."""
    if moment.tzinfo is None or moment.utcoffset() is None:
        moment = moment.replace(tzinfo=UTC)
    return moment.astimezone(BUSINESS_TZ).date()


def business_today(now: datetime | None = None) -> date:
    return business_date(now or datetime.now(UTC))


def day_start(value: date) -> datetime:
    """Primer instante del día de negocio."""
    return datetime.combine(value, time.min, tzinfo=BUSINESS_TZ)


def day_end(value: date) -> datetime:
    """Último instante representable del día de negocio."""
    return datetime.combine(value, time.max, tzinfo=BUSINESS_TZ)

"""Calendario de negocio en hora de la Ciudad de México (decisión del usuario, 2026-10-17)."""
from __future__ import annotations

from datetime import UTC, date, datetime, timedelta, timezone
import inspect

from app.analytics.dashboard_service import DashboardService
from app.analytics.repository import AnalyticsRepository
from app.business_time import BUSINESS_TIMEZONE, business_date, business_today, day_end, day_start


def test_srs_required_a_late_evening_instant_belongs_to_the_mexico_city_day() -> None:
    # 31 oct 2026, 20:00 en la Ciudad de México = 1 nov 2026, 02:00 UTC: cuenta en octubre, no en noviembre.
    assert business_date(datetime(2026, 11, 1, 2, 0, tzinfo=UTC)) == date(2026, 10, 31)
    assert business_date(datetime(2026, 10, 31, 20, 0, tzinfo=timezone(timedelta(hours=-6)))) == date(2026, 10, 31)


def test_srs_required_day_bounds_are_mexico_city_midnights() -> None:
    assert day_start(date(2026, 10, 31)) == datetime(2026, 10, 31, 6, 0, tzinfo=UTC)
    assert day_end(date(2026, 10, 31)).astimezone(UTC) == datetime(2026, 11, 1, 5, 59, 59, 999999, tzinfo=UTC)


def test_srs_required_today_follows_mexico_city_not_utc() -> None:
    # 17 oct 2026, 23:30 en la Ciudad de México; en UTC ya es 18 de octubre.
    assert business_today(datetime(2026, 10, 18, 5, 30, tzinfo=UTC)) == date(2026, 10, 17)


def test_robustness_naive_instants_are_read_as_utc() -> None:
    assert business_date(datetime(2026, 11, 1, 2, 0)) == date(2026, 10, 31)


def test_robustness_dashboard_and_sql_cutoffs_use_the_business_zone() -> None:
    assert inspect.signature(DashboardService.__init__).parameters["today"].default is business_today
    source = inspect.getsource(AnalyticsRepository)
    assert "AT TIME ZONE 'UTC'" not in source
    assert f"AT TIME ZONE '{BUSINESS_TIMEZONE}'" in source

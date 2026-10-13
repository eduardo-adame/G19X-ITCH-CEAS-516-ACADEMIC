"""Interpretación compartida de valores tabulares.

La validación certifica un registro con estas reglas y la proyección lo
materializa con las mismas: un valor que la validación acepta nunca debe volverse
no representable al persistirlo. Una celda vacía o con solo espacios representa
ausencia (SRS 5.5.2).
"""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal, InvalidOperation

_DATE_FORMATS = ("%Y-%m-%d", "%Y/%m/%d", "%d/%m/%Y")


def is_absent(value: object) -> bool:
    """Indica si el valor representa ausencia/null en el contrato tabular."""
    return value is None or (isinstance(value, str) and value.strip() == "")


def parse_date(value: object) -> date | None:
    """Devuelve la fecha calendario o None si el valor no es una fecha válida."""
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = str(value).strip()
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    return None


def parse_decimal(value: object) -> Decimal | None:
    """Devuelve el decimal finito o None; acepta separador de miles y números de hoja de cálculo."""
    if isinstance(value, bool):
        return None
    text = str(value).strip().replace(",", "")
    try:
        parsed = Decimal(text)
    except (InvalidOperation, ValueError):
        return None
    return parsed if parsed.is_finite() else None

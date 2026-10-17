"""Evidencia PostgreSQL real de las consultas administrativas (requiere una BD de pruebas dedicada)."""
from __future__ import annotations

import os
from uuid import uuid4

import psycopg
import pytest
from psycopg.rows import dict_row
from sqlalchemy.engine import make_url

from app.security.repository import SecurityRepository


@pytest.fixture()
def connection():
    url = os.getenv("DATA_TEST_DATABASE_URL", "")
    if not url:
        pytest.skip("dedicated DATA_TEST_DATABASE_URL is required")
    parsed = make_url(url)
    if "test" not in (parsed.database or "").lower() or parsed.database in {"riesgo_legal", "riesgo_legal_test"}:
        pytest.fail("a dedicated Security/runtime test database is required")
    with psycopg.connect(host=parsed.host, port=parsed.port or 5432, dbname=parsed.database, user=parsed.username,
                         password=parsed.password, row_factory=dict_row) as conn:
        try:
            yield conn
        finally:
            conn.rollback()


def _account(connection, username, display_name, roles, state="ACTIVE"):
    account_id = uuid4()
    with connection.cursor() as cursor:
        cursor.execute(
            "INSERT INTO app.user_account (id, username, display_name, password_hash, state, disabled_at) "
            "VALUES (%s, %s, %s, 'test-only-hash', %s, CASE WHEN %s = 'DISABLED' THEN CURRENT_TIMESTAMP END)",
            (account_id, username, display_name, state, state),
        )
        for role in roles:
            cursor.execute("INSERT INTO app.user_role (user_id, role_id) VALUES (%s, %s)", (account_id, role))
    return account_id


def test_accounts_are_filtered_escaped_ordered_and_paginated(connection):
    prefix = f"dir_{uuid4().hex[:8]}"
    _account(connection, f"{prefix}_b", "Beatriz 50% Ruiz", ["ANALISTA", "JURIDICO"])
    _account(connection, f"{prefix}_a", "Ana Martínez", ["TI"])
    _account(connection, f"{prefix}_c", "Carlos", ["JURIDICO"], state="DISABLED")
    rows = SecurityRepository.list_accounts(connection, q=prefix, state=None, role=None, after=None, limit=10)
    assert [row["username"] for row in rows] == [f"{prefix}_a", f"{prefix}_b", f"{prefix}_c"]
    assert rows[1]["roles"] == ["ANALISTA", "JURIDICO"] and "password_hash" not in rows[1]
    assert [row["username"] for row in SecurityRepository.list_accounts(connection, q="50%", state=None, role=None, after=None, limit=10)
            if row["username"].startswith(prefix)] == [f"{prefix}_b"]
    assert [row["username"] for row in SecurityRepository.list_accounts(connection, q=prefix, state="DISABLED", role=None, after=None, limit=10)] == [f"{prefix}_c"]
    assert [row["username"] for row in SecurityRepository.list_accounts(connection, q=prefix, state=None, role="TI", after=None, limit=10)] == [f"{prefix}_a"]
    assert [row["username"] for row in SecurityRepository.list_accounts(connection, q=prefix, state=None, role=None, after=f"{prefix}_a", limit=1)] == [f"{prefix}_b"]

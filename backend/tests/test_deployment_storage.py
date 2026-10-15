"""NF-01: el almacenamiento persistente de ingesta funciona en instalaciones nuevas.

Comprobación estática del empaquetado. La verificación con volúmenes Docker realmente nuevos
y escritura funcional se ejecuta con `scripts/check_fresh_volumes.py` sobre la imagen construida.
"""
from __future__ import annotations

import ast
from pathlib import Path
import re

import pytest

BACKEND = Path(__file__).resolve().parents[1]
PRODUCT = BACKEND.parent
DOCKERFILE = (BACKEND / "Dockerfile").read_text(encoding="utf-8")
COMPOSE = (PRODUCT / "docker-compose.yml").read_text(encoding="utf-8")


def _instructions() -> list[str]:
    return [line.strip() for line in DOCKERFILE.splitlines() if line.strip() and not line.strip().startswith("#")]


@pytest.mark.contract
def test_image_prepares_ingestion_mount_points_for_appuser_before_switching_user() -> None:
    lines = _instructions()
    useradd = next(i for i, line in enumerate(lines) if "useradd" in line and "appuser" in line)
    prepare = next(i for i, line in enumerate(lines)
                   if line.startswith("RUN install -d -o appuser -g appuser") and "/data/ingestion" in line and "/data/controlled" in line)
    user = next(i for i, line in enumerate(lines) if line == "USER appuser")
    assert useradd < prepare < user


@pytest.mark.contract
def test_backend_keeps_running_as_unprivileged_user_without_world_writable_storage() -> None:
    users = [line for line in _instructions() if line.startswith("USER ")]
    assert users[-1] == "USER appuser"
    assert not re.search(r"chmod\s+(-R\s+)?0?777", DOCKERFILE)


@pytest.mark.contract
def test_compose_mounts_named_volumes_on_the_prepared_paths_without_user_override() -> None:
    backend = COMPOSE.split("\n  backend:\n", 1)[1].split("\n  frontend:\n", 1)[0]
    assert "- ingestion_storage:/data/ingestion" in backend
    assert "- ingestion_controlled:/data/controlled" in backend
    assert "\n    user:" not in backend


@pytest.mark.contract
def test_fresh_volume_check_script_performs_functional_writes() -> None:
    script = (PRODUCT / "scripts" / "check_fresh_volumes.py").read_text(encoding="utf-8")
    module = ast.parse(script)
    code = script.replace(ast.get_docstring(module, clean=False) or "", "", 1)
    for marker in ('"volume", "create"', "IngestionService", "_stage(", "CONTROLLED_STORAGE_WRITABLE", "INGESTION_STORAGE_WRITABLE", "BACKEND_USER"):
        assert marker in code
    # La verificación no puede forzar el resultado cambiando el usuario ni el propietario tras montar.
    assert '"--user"' not in code and "chown" not in code

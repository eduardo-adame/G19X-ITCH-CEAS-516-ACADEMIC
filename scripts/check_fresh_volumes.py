"""Verifica que la imagen del backend escribe en volúmenes nombrados recién creados.

Crea volúmenes Docker nuevos para /data/ingestion y /data/controlled, ejecuta la imagen
con su usuario por defecto (sin --user ni chown posterior) y realiza escrituras
funcionales: el staging real de la ingesta (IngestionService._stage) y un archivo en una
ubicación controlada. Elimina los volúmenes al terminar.

Uso: python scripts/check_fresh_volumes.py [--image riesgo-legal-backend:bootstrap]
Sale con código 0 solo si todas las comprobaciones pasan.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import uuid

IN_CONTAINER = r"""
import json, os, pwd
from io import BytesIO
from pathlib import Path
from app.config import get_settings
from app.ingestion.api import _limits
from app.ingestion.service import IngestionService

settings = get_settings()
result = {"BACKEND_USER": pwd.getpwuid(os.getuid()).pw_name, "UID": os.getuid()}
for name in ("/data/ingestion", "/data/controlled"):
    info = os.stat(name)
    result[name] = {"owner_uid": info.st_uid, "mode": oct(info.st_mode & 0o777)}
try:
    service = IngestionService(None, None, Path(settings.ingestion_storage_root), _limits(settings))
    staged = service._stage(BytesIO(b"ID_Litigio,Fecha_Apertura,Estado,Nivel_Severidad\n"), "fresh-volume-check.csv")
    result["INGESTION_STORAGE_WRITABLE"] = staged.path.is_file() and staged.path.read_bytes().startswith(b"ID_Litigio")
    result["staging_dir"] = (Path(settings.ingestion_storage_root) / "staging").is_dir()
except Exception as exc:
    result["INGESTION_STORAGE_WRITABLE"] = False
    result["ingestion_error"] = type(exc).__name__
try:
    location = Path(settings.ingestion_controlled_root) / "litigation"
    location.mkdir(exist_ok=True)
    probe = location / "fresh-volume-check.csv"
    probe.write_bytes(b"ID_Litigio,Fecha_Apertura,Estado,Nivel_Severidad\n")
    result["CONTROLLED_STORAGE_WRITABLE"] = probe.read_bytes().startswith(b"ID_Litigio")
except Exception as exc:
    result["CONTROLLED_STORAGE_WRITABLE"] = False
    result["controlled_error"] = type(exc).__name__
print(json.dumps(result))
"""


def docker(*args: str, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(["docker", *args], capture_output=True, text=True, check=check,
                          env=dict(os.environ, MSYS_NO_PATHCONV="1"))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", default="riesgo-legal-backend:bootstrap")
    image = parser.parse_args().image
    suffix = uuid.uuid4().hex[:8]
    volumes = (f"riesgo-legal-fresh-check-ingestion-{suffix}", f"riesgo-legal-fresh-check-controlled-{suffix}")
    for volume in volumes:
        if docker("volume", "inspect", volume, check=False).returncode == 0:
            raise SystemExit("el volumen de prueba ya existe; no es un volumen nuevo")
        docker("volume", "create", "--label", "purpose=fresh-volume-check", volume)
    try:
        completed = docker("run", "--rm", "-v", f"{volumes[0]}:/data/ingestion", "-v", f"{volumes[1]}:/data/controlled",
                           "-e", "INGESTION_STORAGE_ROOT=/data/ingestion", "-e", "INGESTION_CONTROLLED_ROOT=/data/controlled",
                           "--entrypoint", "python", image, "-c", IN_CONTAINER, check=False)
        if completed.returncode != 0:
            print(json.dumps({"error": "container_failed", "stderr_tail": completed.stderr[-400:]}))
            return 1
        result = json.loads(completed.stdout.strip().splitlines()[-1])
    finally:
        for volume in volumes:
            docker("volume", "rm", volume, check=False)
    result["FRESH_NAMED_VOLUMES"] = True
    result["IMAGE"] = image
    print(json.dumps(result, indent=1))
    ok = (result.get("BACKEND_USER") == "appuser" and result.get("INGESTION_STORAGE_WRITABLE") is True
          and result.get("CONTROLLED_STORAGE_WRITABLE") is True)
    print("FRESH_VOLUME_CHECK", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

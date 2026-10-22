"""Primera instalación en un solo paso: prepara la base, crea la primera cuenta TI y la cuenta de proceso de Airflow y
concede el alcance documental.

Reúne los pasos 2.4, 2.5, 2.7 y la cuenta de proceso del 2.9 del README con las funciones existentes del repositorio. Se ejecuta dentro del
contenedor del backend con el código montado en ``/administracion`` y el ``.env`` en ``/configuracion/.env``:

    docker compose run --rm --no-deps -T --volume "./backend:/administracion:ro" --volume "./.env:/configuracion/.env:ro"
        --workdir /administracion -e SECURITY_BOOTSTRAP_USERNAME=ti-inicial -e SECURITY_BOOTSTRAP_PASSWORD=<contraseña>
        backend python scripts/primera_instalacion.py

Puede repetirse sin efectos duplicados: Alembic deja el esquema en ``head``, una cuenta TI activa se conserva y solo se
conceden los alcances que todavía no están activos. Nunca imprime contraseñas ni tokens.
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

ROLES = ("JURIDICO", "ANALISTA", "TI")
FAMILIAS = ("CONTRATOS_DOCUMENTOS", "LITIGIOS", "CUMPLIMIENTO", "AUDITORIA_INTERNA")
REQUERIDAS = ("POSTGRES_USER", "POSTGRES_PASSWORD", "RUNTIME_POSTGRES_USER", "RUNTIME_POSTGRES_PASSWORD",
              "AUDIT_POSTGRES_USER", "AUDIT_POSTGRES_PASSWORD")


class InstalacionError(RuntimeError):
    """La primera instalación no puede continuar; el mensaje es seguro para mostrarse."""


def cargar_configuracion(ruta: Path) -> dict[str, str]:
    from dotenv import dotenv_values

    if not ruta.exists():
        raise InstalacionError(f"No existe {ruta}: monta el .env de la raíz del repositorio")
    local = {clave: valor for clave, valor in dotenv_values(ruta).items() if valor is not None}
    faltantes = [clave for clave in REQUERIDAS if not local.get(clave)]
    if faltantes:
        raise InstalacionError("Faltan credenciales obligatorias en .env: " + ", ".join(faltantes))
    return local


def preparar_base(local: dict[str, str]) -> None:
    """Migraciones con la identidad administradora y aprovisionamiento del usuario limitado y del lector de auditoría."""
    from alembic import command
    from alembic.config import Config
    from scripts.provision_audit_reader import provision_protected_payload
    from scripts.provision_runtime_role import main as provision_runtime

    os.environ.update(local)
    os.environ.update(POSTGRES_HOST="postgres", POSTGRES_PORT="5432",
                      POSTGRES_DB=local.get("RUNTIME_POSTGRES_DB") or local.get("POSTGRES_DB") or "riesgo_legal")
    command.upgrade(Config(str(BACKEND_ROOT / "alembic.ini")), "head")
    provision_runtime()
    provision_protected_payload({
        "host": "postgres", "port": 5432, "database": os.environ["POSTGRES_DB"],
        "owner": local["POSTGRES_USER"], "owner_password": local["POSTGRES_PASSWORD"],
        "login": local["AUDIT_POSTGRES_USER"], "password": local["AUDIT_POSTGRES_PASSWORD"], "configured": True,
    })


def servicio_de_seguridad(local: dict[str, str]):
    """Servicio de la aplicación con el usuario limitado, como lo usa el backend en operación normal."""
    from app.config import get_settings
    from app.security.api import configured_security_service

    os.environ.update(POSTGRES_USER=local["RUNTIME_POSTGRES_USER"], POSTGRES_PASSWORD=local["RUNTIME_POSTGRES_PASSWORD"])
    get_settings.cache_clear()
    return configured_security_service()


def crear_cuenta_ti(servicio, usuario: str | None, contrasena: str | None) -> str:
    from app.security.models import BootstrapAlreadyCompletedError, ValidationError

    if not usuario or not contrasena:
        return "SIN_CREDENCIALES"
    try:
        servicio.bootstrap_first_ti(username=usuario, password=contrasena)
    except BootstrapAlreadyCompletedError:
        return "EXISTENTE"
    except ValidationError:
        raise InstalacionError("La cuenta TI no es válida: usuario no vacío y contraseña de 12 a 128 caracteres") from None
    return "CREADA"


def _principal(servicio, usuario: str, contrasena: str):
    from app.security.models import AuthenticationError

    try:
        token, _ = servicio.login(usuario, contrasena)
    except AuthenticationError:
        raise InstalacionError("La cuenta TI indicada no puede iniciar sesión") from None
    return servicio.authenticated_principal(token)


def crear_cuenta_proceso(servicio, usuario: str, contrasena: str, proceso: str | None, clave: str | None) -> str:
    """Cuenta de la aplicación que usa el DAG (rol Analista); su usuario debe figurar en SCHEDULED_PROCESS_ACCOUNTS."""
    from app.security.models import AccountConflictError, ValidationError

    if not proceso or not clave:
        return "SIN_CREDENCIALES"
    try:
        servicio.create_account(_principal(servicio, usuario, contrasena), username=proceso, display_name="Proceso de ingesta Airflow",
                                password=clave, roles=frozenset({"ANALISTA"}))
    except AccountConflictError:
        return "EXISTENTE"
    except ValidationError:
        raise InstalacionError("La cuenta de proceso no es válida: contraseña de 12 a 128 caracteres en AIRFLOW_INGESTION_PASSWORD") from None
    return "CREADA"


def conceder_alcance(servicio, usuario: str, contrasena: str, roles=ROLES, familias=FAMILIAS) -> int:
    """Concede solo los alcances inactivos. Conceder un alcance al rol TI cierra la sesión TI vigente, por eso cada
    concesión usa una sesión nueva."""
    def principal():
        return _principal(servicio, usuario, contrasena)

    vigentes = {(row.role_id, row.source_family) for row in servicio.list_scope_grants(principal()).items if row.active}
    concedidos = 0
    for rol in roles:
        for familia in familias:
            if (rol, familia) in vigentes:
                continue
            servicio.set_scope_grant(principal(), rol, familia, True)
            concedidos += 1
    return concedidos


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Primera instalación: base, cuenta TI inicial y alcance documental.")
    parser.add_argument("--configuracion", default="/configuracion/.env", help="Ruta del .env montado en el contenedor.")
    parser.add_argument("--sin-alcance", action="store_true", help="No conceder alcance documental (queda la denegación por defecto).")
    parser.add_argument("--roles", default=",".join(ROLES), help="Roles a los que se concede el alcance, separados por coma.")
    parser.add_argument("--familias", default=",".join(FAMILIAS), help="Familias documentales a conceder, separadas por coma.")
    args = parser.parse_args(argv)
    try:
        local = cargar_configuracion(Path(args.configuracion))
        usuario = os.environ.get("SECURITY_BOOTSTRAP_USERNAME") or local.get("SECURITY_BOOTSTRAP_USERNAME")
        contrasena = os.environ.get("SECURITY_BOOTSTRAP_PASSWORD") or local.get("SECURITY_BOOTSTRAP_PASSWORD")
        preparar_base(local)
        print("BASE_PREPARADA")
        servicio = servicio_de_seguridad(local)
        cuenta = crear_cuenta_ti(servicio, usuario, contrasena)
        if cuenta == "SIN_CREDENCIALES":
            print("CUENTA_TI_OMITIDA: define SECURITY_BOOTSTRAP_USERNAME y SECURITY_BOOTSTRAP_PASSWORD para crearla")
        else:
            print(f"CUENTA_TI_{cuenta}")
        if cuenta == "SIN_CREDENCIALES":
            print("CUENTA_PROCESO_OMITIDA")
            print("ALCANCE_DOCUMENTAL_OMITIDO")
        else:
            try:
                proceso = crear_cuenta_proceso(servicio, usuario, contrasena, local.get("AIRFLOW_INGESTION_USERNAME"), local.get("AIRFLOW_INGESTION_PASSWORD"))
                print("CUENTA_PROCESO_OMITIDA: sin AIRFLOW_INGESTION_PASSWORD en .env" if proceso == "SIN_CREDENCIALES" else f"CUENTA_PROCESO_{proceso}")
                if args.sin_alcance:
                    print("ALCANCE_DOCUMENTAL_OMITIDO")
                else:
                    roles = tuple(item.strip() for item in args.roles.split(",") if item.strip())
                    familias = tuple(item.strip() for item in args.familias.split(",") if item.strip())
                    print(f"ALCANCE_DOCUMENTAL_CONCEDIDO: {conceder_alcance(servicio, usuario, contrasena, roles, familias)} nuevos")
            except InstalacionError:
                if cuenta != "EXISTENTE":
                    raise
                # Reinstalación con una contraseña distinta de la cuenta TI que ya existía: la base queda preparada.
                print("CONFIGURACION_DE_CUENTAS_OMITIDA: la cuenta TI ya existía y la contraseña indicada no coincide")
    except InstalacionError as exc:
        print(f"PRIMERA_INSTALACION_NO_CONFIRMADA: {exc}")
        return 1
    except Exception as exc:  # El tipo basta para diagnosticar; el detalle puede contener datos de conexión.
        print(f"PRIMERA_INSTALACION_NO_CONFIRMADA: {type(exc).__name__}")
        return 1
    print("PRIMERA_INSTALACION_COMPLETADA")
    return 0


if __name__ == "__main__":
    sys.exit(main())

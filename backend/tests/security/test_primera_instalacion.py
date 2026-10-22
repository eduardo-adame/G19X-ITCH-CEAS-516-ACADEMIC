"""Pruebas del script de primera instalación (cuenta TI inicial y alcance documental) con un servicio simulado."""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.security.models import AccountConflictError, AuthenticationError, BootstrapAlreadyCompletedError, ValidationError
from scripts import primera_instalacion as instalacion


class _Servicio:
    def __init__(self, *, ti_existente=False, vigentes=(), login_valido=True):
        self.ti_existente = ti_existente
        self.vigentes = set(vigentes)
        self.login_valido = login_valido
        self.creadas, self.concedidos, self.sesiones = [], [], 0

    def bootstrap_first_ti(self, *, username, password):
        if self.ti_existente:
            raise BootstrapAlreadyCompletedError("BOOTSTRAP_ALREADY_COMPLETED")
        if len(password) < 12:
            raise ValidationError("contraseña corta")
        self.creadas.append(username)

    def login(self, username, password):
        if not self.login_valido:
            raise AuthenticationError("Credenciales o sesión no válidas")
        self.sesiones += 1
        return f"token-{self.sesiones}", "refresh"

    def authenticated_principal(self, token):
        return token

    def list_scope_grants(self, principal):
        return SimpleNamespace(items=[SimpleNamespace(role_id=r, source_family=f, active=True) for r, f in self.vigentes])

    def create_account(self, principal, *, username, display_name, password, roles):
        if username in getattr(self, "cuentas", set()):
            raise AccountConflictError("existe")
        if len(password) < 12:
            raise ValidationError("contraseña corta")
        self.cuentas = getattr(self, "cuentas", set()) | {username}
        self.roles_proceso = roles

    def set_scope_grant(self, principal, role, family, active):
        self.concedidos.append((principal, role, family, active))
        self.vigentes.add((role, family))


@pytest.mark.contract
def test_crea_la_cuenta_ti_solo_una_vez():
    servicio = _Servicio()
    assert instalacion.crear_cuenta_ti(servicio, "ti-inicial", "contraseña-segura-1") == "CREADA"
    assert instalacion.crear_cuenta_ti(_Servicio(ti_existente=True), "ti-inicial", "contraseña-segura-1") == "EXISTENTE"
    assert servicio.creadas == ["ti-inicial"]


@pytest.mark.contract
def test_sin_credenciales_no_crea_cuenta_ni_falla():
    assert instalacion.crear_cuenta_ti(_Servicio(), None, None) == "SIN_CREDENCIALES"


@pytest.mark.contract
def test_cuenta_ti_no_valida_se_informa_sin_detalles():
    with pytest.raises(instalacion.InstalacionError, match="12 a 128"):
        instalacion.crear_cuenta_ti(_Servicio(), "ti-inicial", "corta")


@pytest.mark.contract
def test_concede_solo_los_alcances_inactivos_con_una_sesion_nueva_por_concesion():
    servicio = _Servicio(vigentes={("TI", "LITIGIOS")})
    concedidos = instalacion.conceder_alcance(servicio, "ti-inicial", "contraseña-segura-1", ("JURIDICO", "TI"), ("CONTRATOS_DOCUMENTOS", "LITIGIOS"))
    assert concedidos == 3
    assert [(rol, familia) for _, rol, familia, _ in servicio.concedidos] == [("JURIDICO", "CONTRATOS_DOCUMENTOS"), ("JURIDICO", "LITIGIOS"), ("TI", "CONTRATOS_DOCUMENTOS")]
    # Conceder alcance al rol TI cierra la sesión TI vigente: ninguna concesión reutiliza una sesión anterior.
    assert len({principal for principal, *_ in servicio.concedidos}) == 3


@pytest.mark.contract
def test_repetir_la_instalacion_no_concede_nada_nuevo():
    servicio = _Servicio()
    instalacion.conceder_alcance(servicio, "ti-inicial", "contraseña-segura-1")
    assert instalacion.conceder_alcance(servicio, "ti-inicial", "contraseña-segura-1") == 0
    assert len(servicio.concedidos) == len(instalacion.ROLES) * len(instalacion.FAMILIAS)


@pytest.mark.contract
def test_credenciales_ti_incorrectas_detienen_la_concesion():
    with pytest.raises(instalacion.InstalacionError, match="no puede iniciar sesión"):
        instalacion.conceder_alcance(_Servicio(login_valido=False), "ti-inicial", "contraseña-equivocada")


@pytest.mark.contract
def test_configuracion_incompleta_se_rechaza(tmp_path):
    ruta = tmp_path / ".env"
    ruta.write_text("POSTGRES_USER=app\nPOSTGRES_PASSWORD=x\n", encoding="utf-8")
    with pytest.raises(instalacion.InstalacionError, match="RUNTIME_POSTGRES_USER"):
        instalacion.cargar_configuracion(ruta)
    with pytest.raises(instalacion.InstalacionError, match="No existe"):
        instalacion.cargar_configuracion(tmp_path / "otro.env")


@pytest.mark.contract
def test_crea_la_cuenta_de_proceso_como_analista_una_sola_vez():
    servicio = _Servicio()
    assert instalacion.crear_cuenta_proceso(servicio, "ti-inicial", "contraseña-segura-1", "airflow-ingestion", "clave-de-proceso-1") == "CREADA"
    assert servicio.roles_proceso == frozenset({"ANALISTA"})
    assert instalacion.crear_cuenta_proceso(servicio, "ti-inicial", "contraseña-segura-1", "airflow-ingestion", "clave-de-proceso-1") == "EXISTENTE"
    assert instalacion.crear_cuenta_proceso(servicio, "ti-inicial", "contraseña-segura-1", "airflow-ingestion", None) == "SIN_CREDENCIALES"


@pytest.mark.contract
def test_cuenta_de_proceso_con_contrasena_corta_se_rechaza():
    with pytest.raises(instalacion.InstalacionError, match="AIRFLOW_INGESTION_PASSWORD"):
        instalacion.crear_cuenta_proceso(_Servicio(), "ti-inicial", "contraseña-segura-1", "airflow-ingestion", "corta")

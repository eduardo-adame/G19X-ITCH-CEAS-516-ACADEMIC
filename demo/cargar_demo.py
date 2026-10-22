"""Carga los datos de demostración ficticios de esta carpeta por la API, como lo haría un analista.

Se ejecuta dentro del contenedor del backend (solo usa la biblioteca estándar), con el backend ya iniciado:

    docker compose run --rm --no-deps -T --volume "./demo:/demo:ro" --volume "./.env:/configuracion/.env:ro"
        -e DEMO_TI_USUARIO=ti-inicial -e DEMO_TI_CONTRASENA=<contraseña> backend python /demo/cargar_demo.py

Qué hace:
1. Crea las cuentas de demostración (Jurídico y Analista) y la cuenta de proceso de Airflow si faltan.
2. Desplaza las fechas de los archivos para que el último mes de datos sea el mes en curso, así el tablero siempre
   muestra un periodo actual. Las fechas de evento nunca quedan en el futuro y un valor inválido a propósito se conserva.
3. Carga y procesa los CSV y documentos; los registros inválidos quedan en la Zona de cuarentena.
4. Ejecuta el recálculo programado y el análisis proactivo con la cuenta de proceso para que aparezcan las alertas.

Puede repetirse: las cuentas existentes se conservan y, si los documentos de la demostración ya están en el sistema, no se
vuelve a cargar nada (las cargas repetidas duplicarían recepciones, cuarentena y documentos).
"""
from __future__ import annotations

import calendar
import csv
import io
import json
import os
import secrets
import sys
import time
import urllib.error
import urllib.request
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

DEMO = Path(__file__).resolve().parent
API = os.environ.get("DEMO_API", "http://backend:8000").rstrip("/")
REFERENCIA = (2026, 10)  # Mes nominal de los archivos; se desplaza al mes en curso.
CIUDAD_DE_MEXICO = timezone(timedelta(hours=-6))
EVENTOS = {"Fecha_Solicitud", "Fecha_Firma", "Fecha_Apertura", "Fecha_Evento", "Fecha"}
PLAZOS = {"Fecha_Vencimiento", "Fecha_Limite"}
CARGAS = [  # (ubicación controlada, archivo, fecha del documento nominal)
    ("contracts-documents", "contracts-documents/contratos.csv", None),
    ("litigation", "litigation/litigios.csv", None),
    ("compliance", "compliance/obligaciones.csv", None),
    ("internal-audit", "internal-audit/incidentes.csv", None),
    ("internal-audit", "internal-audit/asuntos-juridicos.csv", None),
    ("contracts-documents", "contracts-documents/contrato-arrendamiento-oficinas.pdf", "2026-06-10"),
    ("contracts-documents", "contracts-documents/contrato-servicios-mantenimiento.pdf", "2026-08-01"),
    ("contracts-documents", "contracts-documents/acuerdo-confidencialidad-proveedor.docx", "2026-09-03"),
    ("litigation", "litigation/demanda-laboral-expediente-1458.pdf", "2026-08-12"),
    # Segunda carga del mismo contrato con otro estado: conflicto de identidad, solo puede descartarse.
    ("contracts-documents", "contracts-documents/contratos-actualizacion.csv", None),
]
TIPOS = {".csv": "text/csv", ".pdf": "application/pdf", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}


def hoy() -> date:
    return datetime.now(CIUDAD_DE_MEXICO).date()


def desplazamiento_meses(actual: date) -> int:
    # El día 1 el mes en curso aún no tiene días transcurridos: los datos terminan en el mes anterior.
    referencia = actual if actual.day >= 2 else actual.replace(day=1) - timedelta(days=1)
    return (referencia.year * 12 + referencia.month) - (REFERENCIA[0] * 12 + REFERENCIA[1])


def desplazar(valor: str, meses: int, *, tope: date | None) -> str:
    try:
        original = date.fromisoformat(valor)
    except ValueError:
        return valor  # Fecha inválida a propósito: debe llegar tal cual para que la cuarentena la muestre.
    indice = original.year * 12 + original.month - 1 + meses
    anio, mes = divmod(indice, 12)
    nueva = date(anio, mes + 1, min(original.day, calendar.monthrange(anio, mes + 1)[1]))
    return (min(nueva, tope) if tope else nueva).isoformat()


def csv_desplazado(contenido: bytes, meses: int, ayer: date) -> bytes:
    filas = list(csv.DictReader(io.StringIO(contenido.decode("utf-8"))))
    salida = io.StringIO()
    escritor = csv.DictWriter(salida, fieldnames=list(filas[0].keys()), lineterminator="\n")
    escritor.writeheader()
    for fila in filas:
        for columna, valor in fila.items():
            if valor and columna in EVENTOS | PLAZOS:
                fila[columna] = desplazar(valor, meses, tope=ayer if columna in EVENTOS else None)
        escritor.writerow(fila)
    return salida.getvalue().encode("utf-8")


class Api:
    def __init__(self, usuario: str, contrasena: str):
        respuesta = self.llamar("POST", "/api/auth/login", {"username": usuario, "password": contrasena}, token=None)
        if respuesta[0] != 200:
            raise SystemExit(f"DEMO_NO_CARGADA: la cuenta {usuario} no puede iniciar sesión")
        self.token = respuesta[1]["access_token"]

    @staticmethod
    def llamar(metodo, ruta, cuerpo=None, *, token, cabeceras=None, datos=None):
        headers = dict(cabeceras or {})
        if token:
            headers["Authorization"] = f"Bearer {token}"
        if cuerpo is not None:
            datos = json.dumps(cuerpo).encode("utf-8")
            headers["Content-Type"] = "application/json"
        peticion = urllib.request.Request(API + ruta, data=datos, method=metodo, headers=headers)
        try:
            with urllib.request.urlopen(peticion, timeout=900) as respuesta:
                texto = respuesta.read().decode("utf-8")
                return respuesta.status, json.loads(texto) if texto else {}
        except urllib.error.HTTPError as error:
            texto = error.read().decode("utf-8", errors="replace")
            try:
                return error.code, json.loads(texto)
            except ValueError:
                return error.code, {}

    def __call__(self, metodo, ruta, cuerpo=None, **kwargs):
        return self.llamar(metodo, ruta, cuerpo, token=self.token, **kwargs)

    def subir(self, nombre: str, contenido: bytes, ubicacion: str, fecha_documento: str | None):
        limite = "----demo" + uuid.uuid4().hex
        partes = [(f'--{limite}\r\nContent-Disposition: form-data; name="controlled_location"\r\n\r\n{ubicacion}\r\n').encode("utf-8")]
        if fecha_documento:
            partes.append((f'--{limite}\r\nContent-Disposition: form-data; name="document_date"\r\n\r\n{fecha_documento}\r\n').encode("utf-8"))
        partes.append((f'--{limite}\r\nContent-Disposition: form-data; name="file"; filename="{nombre}"\r\n'
                       f'Content-Type: {TIPOS[Path(nombre).suffix]}\r\n\r\n').encode("utf-8") + contenido + b"\r\n")
        partes.append(f"--{limite}--\r\n".encode("utf-8"))
        return self("POST", "/api/ingestion/uploads", datos=b"".join(partes),
                    cabeceras={"Content-Type": f"multipart/form-data; boundary={limite}", "Idempotency-Key": str(uuid.uuid4())})


def configuracion_local() -> dict[str, str]:
    ruta = Path(os.environ.get("DEMO_CONFIGURACION", "/configuracion/.env"))
    valores = {}
    if ruta.exists():
        for linea in ruta.read_text(encoding="utf-8").splitlines():
            if "=" in linea and not linea.lstrip().startswith("#"):
                clave, valor = linea.split("=", 1)
                valores[clave.strip()] = valor.strip().strip("'\"")
    return valores


def ventana(dia: date) -> dict[str, str]:
    inicio = datetime(dia.year, dia.month, dia.day, tzinfo=CIUDAD_DE_MEXICO)
    return {"data_interval_start": inicio.isoformat(), "data_interval_end": (inicio + timedelta(days=1)).isoformat()}


def main() -> int:
    usuario, contrasena = os.environ.get("DEMO_TI_USUARIO"), os.environ.get("DEMO_TI_CONTRASENA")
    if not usuario or not contrasena:
        print("DEMO_NO_CARGADA: define DEMO_TI_USUARIO y DEMO_TI_CONTRASENA con la cuenta TI")
        return 2
    local = configuracion_local()
    ti = Api(usuario, contrasena)

    # 1. Cuentas de demostración y de proceso.
    existentes = {cuenta["username"] for cuenta in ti("GET", "/api/security/users")[1].get("items", [])}
    nuevas = {}
    cuentas = [("ana.martinez", "Ana Martínez", ["JURIDICO"], os.environ.get("DEMO_JURIDICO_CONTRASENA")),
               ("luis.hernandez", "Luis Hernández", ["ANALISTA"], os.environ.get("DEMO_ANALISTA_CONTRASENA"))]
    proceso = local.get("AIRFLOW_INGESTION_USERNAME") or "airflow-ingestion"
    if local.get("AIRFLOW_INGESTION_PASSWORD"):
        cuentas.append((proceso, "Proceso de ingesta Airflow", ["ANALISTA"], local["AIRFLOW_INGESTION_PASSWORD"]))
    for nombre, visible, roles, clave in cuentas:
        if nombre in existentes:
            continue
        clave = clave or "Demo-" + secrets.token_urlsafe(12)
        estado, _ = ti("POST", "/api/security/users", {"username": nombre, "display_name": visible, "password": clave, "roles": roles})
        if estado != 201:
            print(f"DEMO_NO_CARGADA: no se pudo crear la cuenta {nombre} ({estado})")
            return 1
        if nombre != proceso:
            nuevas[nombre] = clave
    print(f"CUENTAS_LISTAS: {len(cuentas)} ({len(cuentas) - len([c for c in cuentas if c[0] in existentes])} nuevas)")

    # La demostración ya cargada no se repite: una carga nueva crea otra recepción, otro documento y otra cuarentena.
    _, ocr = ti("GET", "/api/documents/ocr")
    nombres = {item.get("document_name") for item in ocr.get("items", [])}
    if {Path(archivo).name for _, archivo, fecha in CARGAS if fecha} <= nombres:
        print("DEMO_YA_CARGADA: los documentos de la demostración ya están en el sistema; no se vuelve a cargar")
        return 0

    # 2 y 3. Carga con las fechas desplazadas al mes en curso; las realiza el Analista si su contraseña es conocida.
    analista_clave = nuevas.get("luis.hernandez") or os.environ.get("DEMO_ANALISTA_CONTRASENA")
    cargador = Api("luis.hernandez", analista_clave) if analista_clave else ti
    actual = hoy()
    meses, ayer = desplazamiento_meses(actual), actual - timedelta(days=1)
    for ubicacion, archivo, fecha_documento in CARGAS:
        contenido = (DEMO / archivo).read_bytes()
        if archivo.endswith(".csv"):
            contenido = csv_desplazado(contenido, meses, ayer)
        fecha = desplazar(fecha_documento, meses, tope=ayer) if fecha_documento else None
        estado, cuerpo = cargador.subir(Path(archivo).name, contenido, ubicacion, fecha)
        if estado == 201 and cuerpo.get("state") == "COMPLETADO" and cuerpo.get("routing_target") != "NONE":
            cargador("POST", "/api/coordination/dispatch", {"file_id": cuerpo["file_id"], "correlation_id": cuerpo["correlation_id"]})
        print(f"CARGADO: {Path(archivo).name} → {estado} {cuerpo.get('state', '')}")

    # Los documentos terminan de procesarse (OCR e índice) antes del análisis.
    for _ in range(60):
        estado, ocr = ti("GET", "/api/documents/ocr")
        if estado == 200 and not any(item.get("processing_state") == "PROCESANDO" for item in ocr.get("items", [])):
            break
        time.sleep(10)

    # 4. Recálculo y análisis programados con la cuenta de proceso (lo mismo que hace el DAG cada noche).
    if local.get("AIRFLOW_INGESTION_PASSWORD"):
        proceso_api = Api(proceso, local["AIRFLOW_INGESTION_PASSWORD"])
        kpi = proceso_api("POST", "/api/coordination/kpi-recalculations/scheduled", ventana(ayer))[1].get("state")
        analisis = proceso_api("POST", "/api/coordination/proactive-analysis/scheduled", ventana(ayer))[1].get("state")
        print(f"ANALISIS: recálculo {kpi}, análisis proactivo {analisis}")
    else:
        print("ANALISIS_OMITIDO: sin AIRFLOW_INGESTION_PASSWORD en .env; las alertas aparecerán con el DAG de Airflow")

    alertas = ti("GET", "/api/dashboard/analysis")[1].get("alert_count")
    pendientes = len(ti("GET", "/api/validation/quarantine", cabeceras={})[1].get("items", []))
    print(f"RESUMEN: {alertas} alertas vigentes, {pendientes} elementos en cuarentena")
    for nombre, clave in nuevas.items():
        print(f"CUENTA_DEMO: {nombre} contraseña {clave}")  # Solo se muestra una vez; cámbiala en Administración.
    print("DEMO_CARGADA")
    return 0


if __name__ == "__main__":
    sys.exit(main())

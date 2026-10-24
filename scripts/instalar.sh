#!/usr/bin/env bash
# Instalación rápida para Linux y macOS (equivalente a scripts/instalar.ps1; README, instalación rápida).
#
#   1. Crea .env desde .env.example con secretos aleatorios si todavía no existe (un .env existente se conserva).
#   2. Construye las imágenes, inicia PostgreSQL y ejecuta backend/scripts/primera_instalacion.py: migraciones, usuarios de
#      base, primera cuenta TI, cuenta de proceso de Airflow y alcance documental.
#   3. Inicia backend y frontend y comprueba su salud.
#   4. Con --con-airflow inicia Airflow; con --con-demo carga los datos ficticios de demo/; con --groq-api-key escribe la
#      clave de Groq en .env (no se muestra).
#   Al final muestra una sola vez la contraseña de la cuenta TI si la generó el propio script.
#
# Uso: ./scripts/instalar.sh [--con-airflow] [--con-demo] [--usuario-ti USUARIO] [--contrasena-ti CONTRASEÑA] [--groq-api-key CLAVE]
set -euo pipefail
# En Git Bash para Windows evita que las rutas del contenedor (/administracion, /demo) se conviertan en rutas de Windows.
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."

con_airflow=false
con_demo=false
usuario_ti="ti-inicial"
contrasena_ti=""
groq_api_key=""
while [ $# -gt 0 ]; do
  case "$1" in
    --con-airflow) con_airflow=true ;;
    --con-demo) con_demo=true ;;
    --usuario-ti) usuario_ti="$2"; shift ;;
    --contrasena-ti) contrasena_ti="$2"; shift ;;
    --groq-api-key) groq_api_key="$2"; shift ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "Opción no reconocida: $1" >&2; exit 2 ;;
  esac
  shift
done

paso() { printf '\n=== %s\n' "$1"; }
falla() { echo "ERROR: $1" >&2; exit 1; }
# Base64 URL sin relleno de 32 bytes aleatorios (o de los indicados).
secreto() { head -c "${1:-32}" /dev/urandom | base64 | tr -d '\n=' | tr '+/' '-_'; }
contrasena() { printf 'Ll%s' "$(secreto 18)"; }  # 26 caracteres: cumple el mínimo de 12 de las cuentas de la aplicación.
# Sustituye (o agrega) una variable de .env conservando el resto del archivo.
escribir_variable() {
  local temporal
  temporal="$(mktemp)"
  NOMBRE="$1" VALOR="$2" awk 'BEGIN { n = ENVIRON["NOMBRE"]; v = ENVIRON["VALOR"]; hecho = 0 }
    index($0, n "=") == 1 { print n "=" v; hecho = 1; next } { print }
    END { if (!hecho) print n "=" v }' .env > "$temporal"
  cat "$temporal" > .env && rm -f "$temporal"
}

paso '1/5 Configuración local (.env)'
generada_ti=false
if [ -z "$contrasena_ti" ]; then contrasena_ti="$(contrasena)"; generada_ti=true; fi
if [ -f .env ]; then
  echo '.env ya existe: se conserva sin cambios.'
else
  cp .env.example .env
  for nombre in POSTGRES_PASSWORD RUNTIME_POSTGRES_PASSWORD AUDIT_POSTGRES_PASSWORD AIRFLOW_ADMIN_PASSWORD AIRFLOW_INGESTION_PASSWORD; do
    escribir_variable "$nombre" "$(contrasena)"
  done
  escribir_variable AUDIT_POSTGRES_USER riesgo_legal_audit_app
  escribir_variable SCHEDULED_PROCESS_ACCOUNTS airflow-ingestion
  escribir_variable AIRFLOW_FERNET_KEY "$(secreto)="
  escribir_variable AIRFLOW_WEBSERVER_SECRET_KEY "$(secreto)"
  escribir_variable SECURITY_JWT_KEYRING_JSON "'{\"local\":\"$(secreto)\"}'"
  echo '.env creado con secretos aleatorios (no se muestran; quedan solo en .env, excluido de Git).'
fi
if [ -n "$groq_api_key" ]; then escribir_variable GROQ_API_KEY "$groq_api_key"; echo 'GROQ_API_KEY escrita en .env (no se muestra).'; fi
if grep -Eq 'CHANGE_ME_|REEMPLAZAR_CON_SECRETO' .env; then falla '.env conserva valores de ejemplo: reemplázalos antes de continuar.'; fi
docker compose config --quiet || falla 'La validación de docker-compose.yml no terminó correctamente.'

paso '2/5 Imágenes y PostgreSQL'
docker compose build backend frontend || falla 'La construcción de las imágenes no terminó correctamente.'
docker compose up -d --wait postgres || falla 'El arranque de PostgreSQL no terminó correctamente.'

paso '3/5 Primera instalación (base, cuentas y alcance documental)'
docker compose run --rm --no-deps -T --volume ./backend:/administracion:ro --volume ./.env:/configuracion/.env:ro --workdir /administracion \
  -e "SECURITY_BOOTSTRAP_USERNAME=$usuario_ti" -e "SECURITY_BOOTSTRAP_PASSWORD=$contrasena_ti" backend python scripts/primera_instalacion.py \
  || falla 'La primera instalación no terminó correctamente.'

paso '4/5 Backend y frontend'
docker compose run --rm --no-deps backend python -m app.security.runtime_check || falla 'La verificación de identidad y privilegios del backend no terminó correctamente.'
docker compose up -d --wait backend frontend || falla 'El arranque de backend y frontend no terminó correctamente.'
for url in http://localhost:3000/health http://localhost:8000/health/ready; do
  echo "$url -> $(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$url")"
done

paso '5/5 Opcionales'
if [ "$con_airflow" = true ]; then
  docker compose --profile airflow up -d --wait || falla 'El arranque de Airflow no terminó correctamente.'
  echo 'Airflow: http://localhost:8080 (AIRFLOW_ADMIN_USER y AIRFLOW_ADMIN_PASSWORD de .env). El DAG controlled_ingestion queda en pausa.'
fi
if [ "$con_demo" = true ]; then
  docker compose run --rm --no-deps -T --volume ./demo:/demo:ro --volume ./.env:/configuracion/.env:ro \
    -e "DEMO_TI_USUARIO=$usuario_ti" -e "DEMO_TI_CONTRASENA=$contrasena_ti" backend python /demo/cargar_demo.py \
    || falla 'La carga de los datos de demostración no terminó correctamente.'
fi

printf '\nSistema disponible en http://localhost:3000\n'
if ! grep -Eq '^GROQ_API_KEY=.+' .env; then
  echo 'AVISO: GROQ_API_KEY está vacía. La consulta documental mostrará las fuentes, pero no generará respuestas; vuelve a ejecutar con --groq-api-key CLAVE.'
fi
if [ "$generada_ti" = true ]; then
  echo "Cuenta TI: $usuario_ti  Contraseña: $contrasena_ti"
  echo 'Guárdala ahora: no se vuelve a mostrar. Si la cuenta ya existía, se conserva su contraseña anterior.'
fi

#!/usr/bin/env bash
# Comprueba una instalación en ejecución (equivalente a scripts/verificar_instalacion.ps1; README, sección 6.5):
# configuración, servicios, salud, esquema y cuentas.
#
# Cada comprobación se informa como PASS o FAIL; el código de salida es 0 solo si todas pasan. No modifica datos ni
# imprime secretos. Airflow se comprueba solo si sus contenedores están en ejecución. Los avisos (AVISO) señalan lo que
# la consulta documental necesita para generar respuestas, sin contar como fallo: el sistema funciona sin ello.
#
# Uso: ./scripts/verificar_instalacion.sh
# Las funciones auxiliares se invocan a través de comprobar, que ShellCheck no sigue (SC2317).
# shellcheck disable=SC2317
set -uo pipefail
# En Git Bash para Windows evita que las rutas del contenedor se conviertan en rutas de Windows.
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.." || exit 1

if [ -t 1 ]; then verde=$'\e[32m'; rojo=$'\e[31m'; amarillo=$'\e[33m'; normal=$'\e[0m'; else verde=''; rojo=''; amarillo=''; normal=''; fi
fallos=0
# comprobar ID DESCRIPCIÓN DETALLE COMANDO...: PASS si COMANDO termina con código 0; DETALLE se muestra solo en FAIL.
comprobar() {
  local id="$1" descripcion="$2" detalle="$3"; shift 3
  if "$@"; then printf '%s[PASS] %s  %s%s\n' "$verde" "$id" "$descripcion" "$normal"
  else fallos=$((fallos + 1)); printf '%s[FAIL] %s  %s%s%s\n' "$rojo" "$id" "$descripcion" "${detalle:+ → $detalle}" "$normal"; fi
}
aviso() { printf '%s[AVISO] %s  %s%s\n' "$amarillo" "$1" "$2" "$normal"; }
contiene() { [[ $1 == *"$2"* ]]; }
iguales() { [ "$1" = "$2" ]; }
en_silencio() { "$@" > /dev/null 2>&1; }
# Valor de una variable de .env sin comillas envolventes.
valor() {
  local linea
  linea="$(grep -m1 "^$1=" .env 2>/dev/null)" || return 0
  linea="${linea#*=}"; linea="${linea%$'\r'}"; linea="${linea#[\'\"]}"; printf '%s' "${linea%[\'\"]}"
}
http() { curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$1"; }
sql() { docker compose exec -T postgres psql -U "$usuario" -d "$base" -Atc "$1" 2>/dev/null | tr -d '\r[:space:]'; }

# Configuración
env_sin_ejemplos() { test -f .env && ! grep -Eq 'CHANGE_ME_|REEMPLAZAR_CON_SECRETO' .env; }
comprobar CONF-01 '.env existe y no conserva valores de ejemplo' '' env_sin_ejemplos
comprobar CONF-02 'docker compose interpreta la configuración' '' en_silencio docker compose config --quiet
comprobar CONF-03 '.env no está versionado en Git' '' test -z "$(git ls-files .env 2>/dev/null)"
sensibles=' POSTGRES_PASSWORD RUNTIME_POSTGRES_PASSWORD AUDIT_POSTGRES_PASSWORD AIRFLOW_ADMIN_PASSWORD AIRFLOW_INGESTION_PASSWORD AIRFLOW_WEBSERVER_SECRET_KEY GROQ_API_KEY SECURITY_BOOTSTRAP_PASSWORD '
expuestos=''
while IFS= read -r linea || [ -n "$linea" ]; do
  linea="${linea%$'\r'}"
  [[ $linea =~ ^[[:space:]]*# || $linea != *=* ]] && continue
  nombre="${linea%%=*}"; contenido="${linea#*=}"
  if [[ $sensibles == *" $nombre "* && -n $contenido && $contenido != CHANGE_ME_* ]]; then expuestos="${expuestos:+$expuestos, }$nombre"; fi
done < .env.example
comprobar CONF-04 '.env.example no contiene secretos reales' "$expuestos" test -z "$expuestos"

# Servicios y salud
estados="$(docker compose --profile airflow ps --format '{{.Service}}|{{.Health}}' 2>/dev/null | tr -d '\r')"
estado() { printf '%s\n' "$estados" | awk -F'|' -v s="$1" '$1 == s { print $2; exit }'; }
for servicio in postgres backend frontend; do
  comprobar SERV-01 "$servicio en ejecución y sano" "$(estado "$servicio")" iguales "$(estado "$servicio")" healthy
done
comprobar SALUD-01 'Frontend /health responde 200' '' iguales "$(http http://localhost:3000/health)" 200
comprobar SALUD-02 'Backend /health responde 200' '' iguales "$(http http://localhost:8000/health)" 200
listo="$(curl -s --max-time 20 http://localhost:8000/health/ready)"
listo_con_vectores() { contiene "$listo" '"healthy":true' && contiene "$listo" '"vector_1024_accepted":true'; }
comprobar SALUD-03 'Readiness: PostgreSQL alcanzable y pgvector con vectores de 1,024 dimensiones' '' listo_con_vectores

# Base de datos y cuentas
esperada="$(find backend/migrations/versions -maxdepth 1 -name '*.py' -exec basename {} .py \; | LC_ALL=C sort | tail -n 1)"
usuario="$(valor POSTGRES_USER)"; base="$(valor RUNTIME_POSTGRES_DB)"; [ -n "$base" ] || base="$(valor POSTGRES_DB)"
revision="$(sql 'select version_num from alembic_version')"
comprobar BD-01 "Esquema en la última revisión ($esperada)" "$revision" iguales "$revision" "$esperada"
comprobar BD-02 'El backend usa el usuario limitado con los privilegios esperados (runtime_check)' '' \
  en_silencio docker compose run --rm --no-deps backend python -m app.security.runtime_check
ti="$(sql "select count(*) from app.user_account a join app.user_role r on r.user_id = a.id where a.state = 'ACTIVE' and r.active and r.role_id = 'TI'")"
comprobar BD-03 'Existe al menos una cuenta TI activa' "$ti" en_silencio test "${ti:-0}" -ge 1

# Consulta documental: lo que necesita para generar respuestas (avisos, no fallos)
if [ -n "$(valor GROQ_API_KEY)" ]; then comprobar RAG-01 'GROQ_API_KEY configurada en .env' '' true
else aviso RAG-01 'GROQ_API_KEY vacía: la consulta documental mostrará las fuentes recuperadas, pero no generará respuestas (README 2.10).'; fi
modelo="$(curl -s --max-time 20 http://localhost:8000/health/embeddings)"
if contiene "$modelo" '"available":true'; then
  comprobar RAG-02 'Modelo BGE-M3 cargado (1,024 dimensiones)' '' contiene "$modelo" '"dimensions":1024'
elif docker compose exec -T backend test -d /home/appuser/.cache/bge-m3/huggingface/hub/models--BAAI--bge-m3 2>/dev/null; then
  aviso RAG-02 'BGE-M3 está en caché y se cargará en la primera indexación o consulta (unos segundos).'
else
  aviso RAG-02 'BGE-M3 aún no se ha descargado: la primera indexación o consulta lo descargará (unos 4.6 GB, requiere Internet).'
fi

# Airflow (opcional)
if contiene $'\n'"$estados" $'\nairflow-scheduler|'; then
  for servicio in airflow-scheduler airflow-webserver; do
    comprobar AIR-01 "$servicio sano" "$(estado "$servicio")" iguales "$(estado "$servicio")" healthy
  done
  comprobar AIR-02 'Airflow /health responde 200' '' iguales "$(http http://localhost:8080/health)" 200
  # Se captura la salida completa: con pipefail, un grep -q que cierra la tubería antes de tiempo daría un falso FAIL.
  dags="$(docker compose --profile airflow exec -T airflow-scheduler airflow dags list -o plain 2>/dev/null)"
  comprobar AIR-03 'El DAG controlled_ingestion está registrado' '' contiene "$dags" controlled_ingestion
  proceso="$(valor AIRFLOW_INGESTION_USERNAME)"
  cuenta="$(sql "select count(*) from app.user_account where username = '$proceso' and state = 'ACTIVE'")"
  comprobar AIR-04 "La cuenta de proceso $proceso existe y está activa" "$cuenta" iguales "$cuenta" 1
else
  echo '[INFO] Airflow no está en ejecución: se omiten sus comprobaciones.'
fi

echo
if [ "$fallos" -gt 0 ]; then printf '%sVEREDICTO: %s comprobaciones fallaron%s\n' "$rojo" "$fallos" "$normal"; exit 1; fi
printf '%sVEREDICTO: instalación correcta%s\n' "$verde" "$normal"
exit 0

<#
.SYNOPSIS
  Comprueba una instalación en ejecución (README, sección 6.1): configuración, servicios, salud, esquema y cuentas.

.DESCRIPTION
  Cada comprobación se informa como PASS o FAIL; el código de salida es 0 solo si todas pasan. No modifica datos ni
  imprime secretos. Airflow se comprueba solo si sus contenedores están en ejecución.

.EXAMPLE
  .\scripts\verificar_instalacion.ps1
#>
$ErrorActionPreference = 'Continue'
Set-Location (Split-Path $PSScriptRoot -Parent)
$fallos = 0
function Resultado([string] $id, [string] $descripcion, [bool] $ok, [string] $detalle = '') {
  if ($ok) { Write-Host "[PASS] $id  $descripcion" -ForegroundColor Green }
  else { $script:fallos++; Write-Host "[FAIL] $id  $descripcion $(if ($detalle) { "→ $detalle" })" -ForegroundColor Red }
}
function Valor([string] $nombre) {
  $linea = Get-Content .env -Encoding UTF8 -ErrorAction SilentlyContinue | Where-Object { $_ -match "^$nombre=" } | Select-Object -First 1
  if ($linea) { ($linea -split '=', 2)[1].Trim("'", '"') } else { '' }
}
function Http([string] $url) {
  try { (Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 20).StatusCode } catch { if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 } }
}

# Configuración
Resultado 'CONF-01' '.env existe y no conserva valores de ejemplo' ((Test-Path .env) -and -not (Select-String -Path .env -Pattern 'CHANGE_ME_|REEMPLAZAR_CON_SECRETO' -Quiet))
docker compose config --quiet 2>$null
Resultado 'CONF-02' 'docker compose interpreta la configuración' ($LASTEXITCODE -eq 0)
$rastreado = git ls-files .env 2>$null
Resultado 'CONF-03' '.env no está versionado en Git' (-not $rastreado)
$sensibles = 'POSTGRES_PASSWORD', 'RUNTIME_POSTGRES_PASSWORD', 'AUDIT_POSTGRES_PASSWORD', 'AIRFLOW_ADMIN_PASSWORD', 'AIRFLOW_INGESTION_PASSWORD', 'AIRFLOW_WEBSERVER_SECRET_KEY', 'GROQ_API_KEY', 'SECURITY_BOOTSTRAP_PASSWORD'
$expuestos = Get-Content .env.example -Encoding UTF8 | Where-Object { $_ -notmatch '^\s*#' } | ForEach-Object {
  $par = $_ -split '=', 2
  if ($sensibles -contains $par[0] -and $par[1] -and $par[1] -notmatch '^CHANGE_ME_') { $par[0] }
}
Resultado 'CONF-04' '.env.example no contiene secretos reales' (-not $expuestos) ($expuestos -join ', ')

# Servicios y salud
$estados = @{}
docker compose --profile airflow ps --format '{{.Service}}|{{.Health}}' 2>$null | ForEach-Object { $p = $_ -split '\|'; $estados[$p[0]] = $p[1] }
foreach ($servicio in 'postgres', 'backend', 'frontend') {
  Resultado 'SERV-01' "$servicio en ejecución y sano" ($estados[$servicio] -eq 'healthy') $estados[$servicio]
}
Resultado 'SALUD-01' 'Frontend /health responde 200' ((Http 'http://localhost:3000/health') -eq 200)
Resultado 'SALUD-02' 'Backend /health responde 200' ((Http 'http://localhost:8000/health') -eq 200)
$listo = $null; try { $listo = Invoke-RestMethod http://localhost:8000/health/ready -TimeoutSec 20 } catch { }
Resultado 'SALUD-03' 'Readiness: PostgreSQL alcanzable y pgvector con vectores de 1,024 dimensiones' ($listo -and $listo.database.healthy -and $listo.database.vector_1024_accepted)

# Base de datos y cuentas
$esperada = (Get-ChildItem backend\migrations\versions -Filter '*.py' | Sort-Object Name | Select-Object -Last 1).BaseName
$usuario, $base = (Valor 'POSTGRES_USER'), (Valor 'RUNTIME_POSTGRES_DB')
if (-not $base) { $base = Valor 'POSTGRES_DB' }
$revision = docker compose exec -T postgres psql -U $usuario -d $base -Atc 'select version_num from alembic_version' 2>$null
Resultado 'BD-01' "Esquema en la última revisión ($esperada)" ("$revision".Trim() -eq $esperada) "$revision"
docker compose run --rm --no-deps backend python -m app.security.runtime_check *> $null
Resultado 'BD-02' 'El backend usa el usuario limitado con los privilegios esperados (runtime_check)' ($LASTEXITCODE -eq 0)
$ti = docker compose exec -T postgres psql -U $usuario -d $base -Atc "select count(*) from app.user_account a join app.user_role r on r.user_id = a.id where a.state = 'ACTIVE' and r.active and r.role_id = 'TI'" 2>$null
Resultado 'BD-03' 'Existe al menos una cuenta TI activa' ([int]"0$("$ti".Trim())" -ge 1) "$ti"

# Airflow (opcional)
if ($estados.ContainsKey('airflow-scheduler')) {
  foreach ($servicio in 'airflow-scheduler', 'airflow-webserver') { Resultado 'AIR-01' "$servicio sano" ($estados[$servicio] -eq 'healthy') $estados[$servicio] }
  Resultado 'AIR-02' 'Airflow /health responde 200' ((Http 'http://localhost:8080/health') -eq 200)
  $dag = docker compose --profile airflow exec -T airflow-scheduler airflow dags list -o plain 2>$null | Select-String 'controlled_ingestion'
  Resultado 'AIR-03' 'El DAG controlled_ingestion está registrado' ([bool]$dag)
  $proceso = Valor 'AIRFLOW_INGESTION_USERNAME'
  $cuenta = docker compose exec -T postgres psql -U $usuario -d $base -Atc "select count(*) from app.user_account where username = '$proceso' and state = 'ACTIVE'" 2>$null
  Resultado 'AIR-04' "La cuenta de proceso $proceso existe y está activa" ("$cuenta".Trim() -eq '1') "$cuenta"
} else {
  Write-Host '[INFO] Airflow no está en ejecución: se omiten sus comprobaciones.'
}

Write-Host ''
if ($fallos) { Write-Host "VEREDICTO: $fallos comprobaciones fallaron" -ForegroundColor Red; exit 1 }
Write-Host 'VEREDICTO: instalación correcta' -ForegroundColor Green
exit 0

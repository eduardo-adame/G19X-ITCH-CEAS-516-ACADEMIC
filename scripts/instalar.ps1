<#
.SYNOPSIS
  Instalación rápida del sistema con Docker Compose (README, sección 2.0).

.DESCRIPTION
  1. Crea .env desde .env.example con secretos aleatorios si todavía no existe (un .env existente se conserva).
  2. Construye las imágenes, inicia PostgreSQL y ejecuta backend/scripts/primera_instalacion.py: migraciones, usuarios de
     base, primera cuenta TI, cuenta de proceso de Airflow y alcance documental.
  3. Inicia backend y frontend y comprueba su salud.
  4. Con -ConAirflow inicia Airflow; con -ConDemo carga los datos ficticios de demo/.
  Al final muestra una sola vez la contraseña de la cuenta TI si la generó el propio script.

.EXAMPLE
  .\scripts\instalar.ps1 -ConAirflow -ConDemo
#>
param(
  [switch] $ConAirflow,
  [switch] $ConDemo,
  [string] $UsuarioTI = 'ti-inicial',
  [string] $ContrasenaTI
)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

function Paso($texto) { Write-Host "`n=== $texto" -ForegroundColor Cyan }
function Comprobar($descripcion) { if ($LASTEXITCODE -ne 0) { throw "$descripcion no terminó correctamente (código $LASTEXITCODE)." } }
function Secreto([int] $bytes = 32) {
  $buffer = New-Object byte[] $bytes
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($buffer)
  [Convert]::ToBase64String($buffer).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}
function Contrasena { 'Ll' + (Secreto 18) }  # 26 caracteres: cumple el mínimo de 12 de las cuentas de la aplicación.

Paso '1/5 Configuración local (.env)'
$generadaTI = $false
if (-not $ContrasenaTI) { $ContrasenaTI = Contrasena; $generadaTI = $true }
if (Test-Path .env) {
  Write-Host '.env ya existe: se conserva sin cambios.'
} else {
  $valores = @{
    POSTGRES_PASSWORD = Contrasena; RUNTIME_POSTGRES_PASSWORD = Contrasena; AUDIT_POSTGRES_USER = 'riesgo_legal_audit_app'
    AUDIT_POSTGRES_PASSWORD = Contrasena; AIRFLOW_ADMIN_PASSWORD = Contrasena; AIRFLOW_INGESTION_PASSWORD = Contrasena
    AIRFLOW_FERNET_KEY = (Secreto) + '='; AIRFLOW_WEBSERVER_SECRET_KEY = Secreto; SCHEDULED_PROCESS_ACCOUNTS = 'airflow-ingestion'
    SECURITY_JWT_KEYRING_JSON = "'{""local"":""$(Secreto)""}'"
  }
  $lineas = Get-Content .env.example -Encoding UTF8 | ForEach-Object {
    $nombre = ($_ -split '=', 2)[0]
    if ($_ -notmatch '^\s*#' -and $valores.ContainsKey($nombre)) { "$nombre=$($valores[$nombre])" } else { $_ }
  }
  [IO.File]::WriteAllLines((Join-Path (Get-Location) '.env'), [string[]]$lineas, (New-Object Text.UTF8Encoding $false))
  Write-Host '.env creado con secretos aleatorios (no se muestran; quedan solo en .env, excluido de Git).'
}
if (Select-String -Path .env -Pattern 'CHANGE_ME_|REEMPLAZAR_CON_SECRETO' -Quiet) { throw '.env conserva valores de ejemplo: reemplázalos antes de continuar.' }
docker compose config --quiet; Comprobar 'La validación de docker-compose.yml'

Paso '2/5 Imágenes y PostgreSQL'
docker compose build backend frontend; Comprobar 'La construcción de las imágenes'
docker compose up -d --wait postgres; Comprobar 'El arranque de PostgreSQL'

Paso '3/5 Primera instalación (base, cuentas y alcance documental)'
docker compose run --rm --no-deps -T --volume './backend:/administracion:ro' --volume './.env:/configuracion/.env:ro' --workdir /administracion `
  -e "SECURITY_BOOTSTRAP_USERNAME=$UsuarioTI" -e "SECURITY_BOOTSTRAP_PASSWORD=$ContrasenaTI" backend python scripts/primera_instalacion.py
Comprobar 'La primera instalación'

Paso '4/5 Backend y frontend'
docker compose run --rm --no-deps backend python -m app.security.runtime_check; Comprobar 'La verificación de identidad y privilegios del backend'
docker compose up -d --wait backend frontend; Comprobar 'El arranque de backend y frontend'
foreach ($url in 'http://localhost:3000/health', 'http://localhost:8000/health/ready') {
  $estado = (Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 30).StatusCode
  Write-Host "$url -> $estado"
}

Paso '5/5 Opcionales'
if ($ConAirflow) {
  docker compose --profile airflow up -d --wait; Comprobar 'El arranque de Airflow'
  Write-Host 'Airflow: http://localhost:8080 (AIRFLOW_ADMIN_USER y AIRFLOW_ADMIN_PASSWORD de .env). El DAG controlled_ingestion queda en pausa.'
}
if ($ConDemo) {
  docker compose run --rm --no-deps -T --volume './demo:/demo:ro' --volume './.env:/configuracion/.env:ro' `
    -e "DEMO_TI_USUARIO=$UsuarioTI" -e "DEMO_TI_CONTRASENA=$ContrasenaTI" backend python /demo/cargar_demo.py
  Comprobar 'La carga de los datos de demostración'
}

Write-Host "`nSistema disponible en http://localhost:3000" -ForegroundColor Green
if ($generadaTI) {
  Write-Host "Cuenta TI: $UsuarioTI  Contraseña: $ContrasenaTI" -ForegroundColor Yellow
  Write-Host 'Guárdala ahora: no se vuelve a mostrar. Si la cuenta ya existía, se conserva su contraseña anterior.'
}

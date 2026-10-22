# Legaltech — Dashboard de Indicadores de Riesgo Legal

**Legaltech** es el nombre con el que se presenta la aplicación web (`frontend/src/shared/brand.js`). Aplicación web para consolidar, procesar y visualizar información de riesgo contractual, litigios, cumplimiento normativo, eficiencia operativa y calidad documental.

Este repositorio contiene el sistema desarrollado como MVP del proyecto de residencia profesional.

## 1. Descripción del sistema

El sistema integra las siguientes capacidades:

- **Ingesta de información:** recepción de archivos CSV, XLSX, PDF y DOCX, mediante carga manual o ubicaciones controladas.
- **Validación y cuarentena:** comprobación de estructura y datos, consulta de incidencias, corrección para reinyección y descarte justificado.
- **Procesamiento documental:** extracción de texto, OCR con Tesseract para PDF escaneado y preparación del corpus documental.
- **Indicadores y análisis:** cálculo de KPI y análisis proactivo mediante reglas deterministas.
- **Consulta documental y RAG:** búsqueda híbrida sobre documentos autorizados y generación de respuestas sustentadas con referencias.
- **Visor documental:** catálogo y consulta de documentos autorizados, con acceso independiente de las consultas RAG: navegación por página, zoom, búsqueda en el texto procesado e impresión registrada en auditoría.
- **Administración y auditoría:** lista de cuentas con búsqueda, gestión de cuentas y roles, consulta y cambio de las autorizaciones documentales vigentes, y registro de operaciones.

El sistema apoya la consulta y el análisis de información. No realiza decisiones jurídicas autónomas ni sustituye la revisión profesional.

### Tecnologías

| Componente | Tecnología |
|---|---|
| Backend | Python 3.12 y FastAPI |
| Frontend | React, Recharts y Vite; servido con nginx en Docker |
| Base de datos | PostgreSQL 16 con pgvector |
| Migraciones | Alembic |
| Orquestación | Apache Airflow |
| OCR | Tesseract y Poppler |
| Embeddings | BGE-M3 local, vectores de 1.024 dimensiones |
| Generación de respuestas | Groq, modelo `openai/gpt-oss-120b` |
| Autenticación | JWT propio |
| Entorno | Docker Compose |

BGE-M3 se ejecuta dentro del backend y utiliza una caché persistente. La recuperación combina búsqueda vectorial y BM25, con fusión RRF, deduplicación por fragmento y un máximo de cinco fragmentos finales.

### Servicios y direcciones locales

| Servicio | Dirección predeterminada | Función |
|---|---|---|
| Frontend | http://localhost:3000 | Aplicación web |
| Backend | http://localhost:8000 | API |
| PostgreSQL | `localhost:5432` | Base de datos |
| Airflow | http://localhost:8080 | Administración de procesos programados |

Airflow se habilita con el perfil `airflow`. Se materializa en tres contenedores: inicialización, scheduler y webserver. Sus metadatos se almacenan en SQLite, en un volumen independiente de PostgreSQL.

## 2. Cómo levantar el entorno

### Instalación rápida (Windows)

Con los requisitos de la sección 2.1, desde la raíz del repositorio:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\instalar.ps1 -ConAirflow -ConDemo
```

El script hace en orden lo que describen las secciones 2.2 a 2.9:

1. Crea `.env` con secretos aleatorios si todavía no existe; un `.env` existente se conserva.
2. Construye las imágenes, prepara la base de datos y crea la primera cuenta TI `ti-inicial`, la cuenta de proceso de Airflow y el alcance documental.
3. Inicia la aplicación y, con `-ConAirflow`, Airflow.
4. Con `-ConDemo` carga los datos ficticios de [`demo/`](demo/README.md).

Al terminar muestra **una sola vez** la contraseña de `ti-inicial` y la de las cuentas de demostración. Abre http://localhost:3000 e inicia sesión. Para comprobar la instalación:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\verificar_instalacion.ps1
```

Si quieres entender o adaptar cada paso, o usas Linux o macOS, sigue el procedimiento manual de las secciones siguientes. La arquitectura y el recorrido de la información se describen en [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md).

### 2.1. Requisitos

Para ejecutar el sistema con Docker:

- Docker en funcionamiento, con soporte para contenedores Linux.
- Docker Compose v2 o posterior.
- Acceso a Internet para descargar imágenes, dependencias y, en su primer uso, el modelo BGE-M3.
- Los puertos locales configurados disponibles.

El entorno de referencia del proyecto contempla **16 GB de RAM y al menos 50 GB libres en SSD NVMe**. Los límites de memoria de Compose son techos configurables, no reservas.

Los comandos siguientes están escritos para **PowerShell** y se ejecutan desde la raíz de este repositorio: el directorio que contiene `docker-compose.yml`.

Python y Node en el equipo anfitrión solo son necesarios para las pruebas o el desarrollo fuera de los contenedores.

> La primera instalación requiere preparar la base y crear la primera cuenta TI. El arranque de Compose no ejecuta automáticamente las migraciones ni crea usuarios de la aplicación.

### 2.2. Crear la configuración local

Copia la plantilla únicamente si todavía no existe un archivo `.env`:

```powershell
Copy-Item .env.example .env
```

Si ya tienes un entorno configurado, conserva su `.env`.

Edita el archivo y reemplaza los valores de ejemplo. Para la instalación completa deben quedar configuradas estas identidades:

| Identidad | Variables | Uso |
|---|---|---|
| Administrador de PostgreSQL | `POSTGRES_USER`, `POSTGRES_PASSWORD` | Inicialización, migraciones y aprovisionamiento |
| Usuario limitado del backend | `RUNTIME_POSTGRES_USER`, `RUNTIME_POSTGRES_PASSWORD` | Operación normal de la aplicación |
| Lector de auditoría | `AUDIT_POSTGRES_USER`, `AUDIT_POSTGRES_PASSWORD` | Lectura independiente de la bitácora |
| Administrador web de Airflow | `AIRFLOW_ADMIN_USER`, `AIRFLOW_ADMIN_PASSWORD` | Acceso a la interfaz de Airflow |
| Cuenta de proceso de la aplicación | `AIRFLOW_INGESTION_USERNAME`, `AIRFLOW_INGESTION_PASSWORD` | Autenticación del DAG contra el backend |

Conserva los valores predeterminados de usuario y base de datos para seguir esta instalación:

```dotenv
POSTGRES_USER=app
POSTGRES_DB=riesgo_legal
RUNTIME_POSTGRES_DB=
RUNTIME_POSTGRES_USER=riesgo_legal_app
AUDIT_POSTGRES_USER=riesgo_legal_audit_app

AIRFLOW_ADMIN_USER=admin
AIRFLOW_INGESTION_USERNAME=airflow-ingestion
SCHEDULED_PROCESS_ACCOUNTS=airflow-ingestion
```

Asigna contraseñas propias y diferentes. No dejes valores `CHANGE_ME_...`.

> **Importante:** las contraseñas de las cinco identidades son obligatorias para **cualquier** comando de Compose, incluso si no vas a usar Airflow. Compose valida el archivo completo y, si falta alguna, se detiene con un mensaje como `required variable AIRFLOW_INGESTION_PASSWORD is missing a value`.

La contraseña de cualquier cuenta de la aplicación (la primera cuenta TI, la cuenta de proceso de Airflow y las que se creen después) debe tener **entre 12 y 128 caracteres**; el backend rechaza las demás. Por eso `AIRFLOW_INGESTION_PASSWORD` también debe cumplir esa longitud.

Configura también:

```dotenv
SECURITY_JWT_KEYRING_JSON='{"local":"<CLAVE_BASE64URL_GENERADA>"}'
SECURITY_JWT_ACTIVE_KID=local
SECURITY_REFRESH_COOKIE_SECURE=False
SECURITY_BOOTSTRAP_ENABLED=False
```

Sustituye `<CLAVE_BASE64URL_GENERADA>` por una clave aleatoria real. Puedes generar un valor de 32 bytes mediante un contenedor temporal:

```powershell
docker run --rm python:3.12-slim python -c "import base64,secrets; print(base64.urlsafe_b64encode(secrets.token_bytes(32)).decode())"
```

Ejecuta de nuevo el comando para generar valores independientes para `AIRFLOW_FERNET_KEY` y `AIRFLOW_WEBSERVER_SECRET_KEY`.

Guarda los secretos únicamente en la configuración local protegida. `.env` está excluido de Git.

Para habilitar la generación de respuestas, completa `GROQ_API_KEY`. Puede permanecer vacía para iniciar los demás módulos; la generación mediante Groq requiere una clave válida.

Comprueba que Compose puede interpretar la configuración:

```powershell
docker compose config --quiet
```

Si aparece un error, corrige la variable indicada antes de continuar. Este comando comprueba la configuración; no valida las contraseñas contra los servicios.

### 2.3. Construir las imágenes e iniciar PostgreSQL

```powershell
docker compose build backend frontend
docker compose up -d --wait postgres
```

La construcción inicial instala las dependencias del backend, incluidas las de embeddings, y compila el frontend.

### 2.4. Preparar la base de datos, la primera cuenta TI y los permisos

El script versionado `backend/scripts/primera_instalacion.py` hace en un solo paso:

1. Aplica las migraciones con la identidad administradora.
2. Aprovisiona el usuario limitado del backend y verifica el lector independiente de auditoría.
3. Crea la primera cuenta TI.
4. Crea la cuenta de proceso de Airflow (`AIRFLOW_INGESTION_USERNAME`, rol Analista) si `AIRFLOW_INGESTION_PASSWORD` está definida.
5. Concede el alcance documental de Jurídico, Analista y TI sobre las cuatro familias (sección 2.7).

Las credenciales de base se leen desde `.env`, montado en modo de solo lectura. La contraseña de la cuenta TI se pasa al contenedor y no se escribe en `.env`; debe tener entre 12 y 128 caracteres.

```powershell
docker compose run --rm --no-deps -T --volume "./backend:/administracion:ro" --volume "./.env:/configuracion/.env:ro" `
  --workdir /administracion -e SECURITY_BOOTSTRAP_USERNAME=ti-inicial -e "SECURITY_BOOTSTRAP_PASSWORD=<CONTRASEÑA_PROPIA>" `
  backend python scripts/primera_instalacion.py
```

El resultado esperado termina con `PRIMERA_INSTALACION_COMPLETADA`, después de `BASE_PREPARADA`, `CUENTA_TI_CREADA`, `CUENTA_PROCESO_CREADA` y `ALCANCE_DOCUMENTAL_CONCEDIDO`.

Opciones:

- `--sin-alcance`: conserva la denegación documental por defecto. El alcance se concede después desde la interfaz (sección 2.7).
- `--roles` y `--familias`: limitan los roles y familias a los que se concede el alcance.

El script puede repetirse sin duplicar nada:

- el esquema ya migrado se conserva;
- una cuenta TI activa se mantiene (`CUENTA_TI_EXISTENTE`);
- solo se conceden los alcances que todavía no están activos.

La revisión de esquema esperada por el backend es:

```text
0019_rag_provider_telemetry
```

Las migraciones y los scripts administrativos se montan porque la imagen de runtime del backend incorpora el código de la aplicación, pero no esos archivos de administración.

`RUNTIME_POSTGRES_DB`, si se utiliza, debe señalar una base que ya exista. Esta variable no crea ni copia bases de datos.

### 2.5. Primera cuenta TI sin el script (alternativa)

La sección 2.4 ya crea la cuenta. Si preparaste la base por otro medio, el comando de bootstrap crea solo la primera cuenta TI.

Edita temporalmente `.env`:

```dotenv
SECURITY_BOOTSTRAP_ENABLED=True
SECURITY_BOOTSTRAP_USERNAME=ti-inicial
SECURITY_BOOTSTRAP_PASSWORD=<CONTRASEÑA_PROPIA>
```

Ejecuta:

```powershell
docker compose run --rm --no-deps backend python -m app.security.bootstrap
```

El resultado esperado en una instalación nueva es `BOOTSTRAP_COMPLETED`. Si ya existe una cuenta TI activa, devuelve `BOOTSTRAP_ALREADY_COMPLETED` y conserva la cuenta existente.

Después vuelve a dejar `SECURITY_BOOTSTRAP_ENABLED=False` y vacía `SECURITY_BOOTSTRAP_USERNAME` y `SECURITY_BOOTSTRAP_PASSWORD`. Conserva las credenciales de la cuenta en un lugar seguro.

### 2.6. Iniciar la aplicación y comprobar su disponibilidad

Verifica primero la identidad y los privilegios del backend:

```powershell
docker compose run --rm --no-deps backend python -m app.security.runtime_check
```

El comando termina sin error cuando el contrato de base de datos es correcto.

Inicia la aplicación:

```powershell
docker compose up -d --wait backend frontend
docker compose ps
```

Comprueba la salud:

```powershell
Invoke-RestMethod http://localhost:3000/health
Invoke-RestMethod http://localhost:8000/health
Invoke-RestMethod http://localhost:8000/health/ready
```

Resultados esperados:

- Frontend y backend responden con `status: ok`.
- Readiness responde HTTP 200 y confirma que PostgreSQL y pgvector están disponibles.

Abre http://localhost:3000 e inicia sesión con la primera cuenta TI.

Una instalación nueva no incorpora automáticamente documentos ni información de negocio. Los indicadores y las consultas dependerán de los datos cargados y de las autorizaciones configuradas.

### 2.7. Conceder acceso a los documentos

La autorización documental es independiente de los roles y **deniega por defecto**: en una instalación nueva ninguna cuenta, ni siquiera la TI, puede ver documentos. Sin este paso el **Visor documental** aparece vacío y la **Consulta documental** responde «Sin autorización».

El script de la sección 2.4 concede por defecto el alcance de Jurídico, Analista y TI sobre las cuatro familias. Para revisarlo o cambiarlo, o si usaste `--sin-alcance`, entra con la cuenta TI:

1. Abre **Administración → Permisos concedidos**.
2. En **Alcance por familia**, pulsa **Dar** en cada combinación de rol y familia documental que deba consultar documentos (por ejemplo, Jurídico y TI en Contratos y documentos y en Litigios) y confirma en el diálogo.
3. Para casos puntuales, **Nueva excepción** autoriza o deniega un documento concreto a una cuenta o a un rol.

Los cambios se aplican de inmediato y no requieren reiniciar servicios. Para aplicar la nueva autorización, el sistema **cierra las sesiones** de las cuentas afectadas: si das acceso a un rol que tu propia cuenta tiene (por ejemplo, TI), tendrás que iniciar sesión de nuevo.

### 2.8. Cargar información para probar

**Datos de demostración:** la carpeta [`demo/`](demo/README.md) tiene datos ficticios de las cuatro familias, cuatro documentos y registros inválidos a propósito para ver la cuarentena. Para cargarlos con el backend iniciado:

```powershell
docker compose run --rm --no-deps -T --volume "./demo:/demo:ro" --volume "./.env:/configuracion/.env:ro" `
  -e DEMO_TI_USUARIO=ti-inicial -e "DEMO_TI_CONTRASENA=<CONTRASEÑA_TI>" backend python /demo/cargar_demo.py
```

Para tus propios archivos CSV, XLSX, PDF o DOCX (máximo 50 MiB cada uno) usa una de estas opciones:

**Opción A — carga manual (recomendada para empezar):**

1. Abre **Operaciones de ingesta** con una cuenta Analista o TI.
2. Elige la **Ubicación controlada** que corresponde a la familia de los datos. El desplegable **Formato esperado** muestra las columnas obligatorias y opcionales de cada familia (por ejemplo, Litigios: `ID_Litigio`, `Fecha_Apertura`, `Estado`, `Nivel_Severidad`).
3. Arrastra el archivo o pulsa **Elegir archivo**.
4. Para PDF o DOCX puedes indicar la **Fecha del documento**; el campo se habilita al elegir el documento y, si se omite, se procesa sin fecha.
5. Pulsa **Recibir y procesar**.

El sistema valida cada registro: los válidos se incorporan y recalculan los indicadores; los que no cumplen quedan en **Zona de cuarentena** para corregirlos o descartarlos. Los documentos PDF y DOCX se procesan (con OCR si están escaneados) y se indexan para la consulta.

**Opción B — ubicaciones controladas:** copia los archivos al volumen del backend y procésalos desde la interfaz o con el DAG de Airflow:

```powershell
# Crear la carpeta de la ubicación (una sola vez por ubicación)
docker compose exec backend mkdir -p /data/controlled/litigation

# Copiar un archivo
docker compose cp .\litigios.csv backend:/data/controlled/litigation/
```

Las carpetas válidas son `contracts-documents`, `litigation`, `compliance` e `internal-audit` (ver la tabla de la sección 2.9). Después pulsa **Procesar pendientes de la ubicación** en **Operaciones de ingesta**, o espera la ejecución del DAG.

> Los indicadores se recalculan al procesar los datos. Las **alertas** del análisis proactivo se generan con el DAG de Airflow (sección 2.9); sin Airflow, el tablero muestra los indicadores pero no alertas nuevas.

### 2.9. Configurar e iniciar Airflow

La cuenta que utiliza Airflow contra la aplicación debe existir antes de ejecutar el DAG. El script de la sección 2.4 la crea cuando `AIRFLOW_INGESTION_PASSWORD` está definida. Para crearla a mano, abre con una cuenta TI **Administración → Cuentas** y pulsa **Nueva cuenta**:

1. **Usuario:** el valor de `AIRFLOW_INGESTION_USERNAME` (por defecto `airflow-ingestion`).
2. **Nombre visible:** cualquier nombre descriptivo, por ejemplo `Proceso de ingesta Airflow`.
3. **Contraseña nueva:** exactamente el valor de `AIRFLOW_INGESTION_PASSWORD` (entre 12 y 128 caracteres).
4. **Roles activos:** **Analista**, que dispone de los permisos de ingesta utilizados por el DAG.
5. Pulsa **Crear cuenta**; la cuenta aparece en **Cuentas registradas**.

Comprueba también que ese usuario figure en `SCHEDULED_PROCESS_ACCOUNTS` (con el valor de la sección 2.2 ya figura).

La cuenta de proceso es independiente del administrador web de Airflow.

Inicia la orquestación:

```powershell
docker compose --profile airflow up -d
docker compose --profile airflow ps
```

Abre http://localhost:8080 e inicia sesión con `AIRFLOW_ADMIN_USER` y `AIRFLOW_ADMIN_PASSWORD`.

Habilita el DAG `controlled_ingestion` desde la interfaz o mediante:

```powershell
docker compose --profile airflow exec airflow-scheduler airflow dags unpause controlled_ingestion
```

Para ejecutarlo de inmediato, sin esperar la programación diaria:

```powershell
docker compose --profile airflow exec airflow-scheduler airflow dags trigger controlled_ingestion
```

El DAG se programa diariamente a la medianoche de la Ciudad de México (`America/Mexico_City`) y ejecuta, en orden:

1. Ingesta desde las ubicaciones controladas y despacho de los archivos aceptados.
2. Recálculo programado de indicadores.
3. Análisis proactivo programado.

Las ubicaciones se encuentran dentro de `/data/controlled` del backend:

| Directorio | Familia |
|---|---|
| `contracts-documents` | Contratos y documentos |
| `litigation` | Litigios |
| `compliance` | Cumplimiento |
| `internal-audit` | Auditoría interna |

El volumen es persistente y Airflow lo monta en modo de solo lectura. El DAG invoca la API del backend para realizar el procesamiento.

### 2.10. Disponibilidad de BGE-M3 y Groq

BGE-M3 se carga de forma diferida y se conserva en memoria una vez cargado por el proceso. La primera operación que lo necesita puede requerir la descarga del modelo.

Consulta su estado sin forzar la carga:

```powershell
Invoke-RestMethod http://localhost:8000/health/embeddings
```

La sonda `POST /health/embeddings/probe` fuerza la carga y verifica la salida de 1.024 dimensiones. Requiere un token Bearer de una cuenta con `technical_config.manage`, permiso disponible para TI.

Para obtener respuestas RAG sustentadas se necesitan:

- Modelo BGE-M3 disponible.
- Documentos procesados e indexados.
- Autorización documental vigente para la cuenta consultante.
- Evidencia suficiente para la consulta.
- Configuración y disponibilidad del proveedor Groq.

### 2.11. Arranques posteriores, parada y persistencia

Después de completar la primera instalación:

```powershell
# Aplicacion sin Airflow
docker compose up -d

# Entorno completo
docker compose --profile airflow up -d

# Estado del entorno completo
docker compose --profile airflow ps

# Detener conservando los datos
docker compose --profile airflow down
```

Los datos se conservan en volúmenes separados:

| Volumen | Contenido |
|---|---|
| `riesgo-legal-pgdata` | PostgreSQL |
| `riesgo-legal-bge-cache` | Caché de BGE-M3 |
| `riesgo-legal-airflow-db` | Metadatos de Airflow |
| `riesgo-legal-airflow-logs` | Logs de Airflow |
| `riesgo-legal-ingestion-storage` | Staging y objetos de ingesta |
| `riesgo-legal-ingestion-controlled` | Ubicaciones controladas |

La opción `down -v` elimina los volúmenes del entorno y sus datos. No forma parte del procedimiento normal de parada.

### 2.12. Problemas frecuentes

| Síntoma | Comprobación |
|---|---|
| Compose indica que falta una variable | Completar `.env`, especialmente las credenciales runtime y de Airflow. |
| El backend se reinicia antes de servir HTTP | Consultar `docker compose logs --tail 100 backend`; revisar migraciones, usuario runtime y privilegios. |
| Readiness devuelve HTTP 503 | Revisar conectividad con PostgreSQL y disponibilidad de pgvector. |
| PostgreSQL rechaza una contraseña tras editar `.env` | El volumen conserva la contraseña establecida al inicializarlo; editar `.env` no cambia la contraseña almacenada. |
| El login no funciona | Comprobar bootstrap, cuenta activa y clave JWT válida. |
| El DAG recibe HTTP 401 | Revisar que la cuenta de proceso exista y que sus credenciales coincidan con `.env`. |
| Las operaciones programadas reciben HTTP 403 | Revisar permisos y pertenencia a `SCHEDULED_PROCESS_ACCOUNTS`. |
| El Visor documental aparece vacío o la Consulta responde «Sin autorización» | Conceder el alcance por familia en **Administración → Permisos concedidos** (sección 2.7); el rol funcional no concede acceso documental por sí solo. Revisar además que los documentos se hayan procesado. |
| Crear una cuenta devuelve un error de datos | Revisar que la contraseña tenga entre 12 y 128 caracteres y que el usuario no exista ya. |
| El tablero muestra indicadores pero no alertas | Las alertas las genera el análisis proactivo del DAG de Airflow (sección 2.9). |
| Falla la generación RAG | Revisar clave Groq, disponibilidad del modelo, evidencia y límites del proveedor. |
| La consulta muestra «El servicio no está disponible temporalmente» pero sí lista fuentes | Falta `GROQ_API_KEY` en `.env` o no es válida: la recuperación funciona y solo la generación falla. Completar la clave y ejecutar `docker compose up -d backend`. |
| «El servicio de generación alcanzó su límite de uso» | El presupuesto local por minuto (`GROQ_RPM_LIMIT`, `GROQ_TPM_LIMIT`) se agotó; esperar unos segundos y usar **Intentar de nuevo**. |
| La construcción o la descarga del modelo fallan por espacio | Comprobar el espacio libre del disco de Docker (la imagen del backend ocupa unos 2.7 GB y la caché de BGE-M3 unos 4.6 GB) y liberar imágenes o caché de construcción que ya no se usen. |

Al modificar variables que se transmiten al contenedor, vuelve a ejecutar `docker compose up -d` con el perfil correspondiente para aplicar la configuración.

## 3. Variables de entorno

`.env.example` es la plantilla versionada. `.env` contiene la configuración local y los secretos.

### Base de datos

| Variable | Valor de referencia | Descripción |
|---|---|---|
| `POSTGRES_USER` | `app` | Administrador utilizado para inicialización y administración. |
| `POSTGRES_PASSWORD` | Sin valor utilizable de ejemplo | Contraseña administradora; debe definirse. |
| `POSTGRES_DB` | `riesgo_legal` | Base creada al inicializar PostgreSQL. |
| `POSTGRES_PORT` | `5432` | Puerto publicado en el equipo. |
| `RUNTIME_POSTGRES_USER` | `riesgo_legal_app` | Usuario limitado utilizado por el backend. |
| `RUNTIME_POSTGRES_PASSWORD` | Vacío | Debe definirse y coincidir con el usuario aprovisionado. |
| `RUNTIME_POSTGRES_DB` | Vacío | Base existente alternativa; vacío utiliza `POSTGRES_DB`. |
| `AUDIT_POSTGRES_USER` | Vacío en la plantilla | Usuario lector independiente; la instalación utiliza `riesgo_legal_audit_app`. |
| `AUDIT_POSTGRES_PASSWORD` | Vacío | Contraseña del lector; necesaria para consultar auditoría. |

Compose conecta el backend con PostgreSQL mediante `postgres:5432`. `POSTGRES_PORT` configura el acceso desde el equipo, no el puerto interno.

### Aplicación y seguridad

| Variable | Valor predeterminado | Descripción |
|---|---|---|
| `APP_NAME` | `backend-riesgo-legal` | Identificación del servicio. |
| `ENVIRONMENT` | `development` | Entorno de ejecución. |
| `BACKEND_PORT` | `8000` | Puerto publicado del backend. |
| `FRONTEND_PORT` | `3000` | Puerto publicado del frontend. |
| `BACKEND_CORS_ORIGINS` | `http://localhost:3000` | Orígenes permitidos, separados por comas. |
| `API_DOCS_ENABLED` | `false` | Habilita Swagger, ReDoc y OpenAPI. |
| `SECURITY_JWT_ISSUER` | `riesgo-legal-backend` | Emisor esperado del JWT. |
| `SECURITY_JWT_AUDIENCE` | `riesgo-legal-web` | Audiencia esperada del JWT. |
| `SECURITY_JWT_KEYRING_JSON` | Placeholder | Objeto JSON de claves HS256; requiere claves reales. |
| `SECURITY_JWT_ACTIVE_KID` | `local` en la plantilla | Identificador de la clave activa. |
| `SECURITY_REFRESH_COOKIE_NAME` | `riesgo_legal_refresh` | Nombre de la cookie de refresh. |
| `SECURITY_REFRESH_COOKIE_SECURE` | `False` | Permite HTTP local de desarrollo; fuera de desarrollo debe ser `True`. |
| `SECURITY_BOOTSTRAP_ENABLED` | `False` | Habilita deliberadamente el comando inicial TI. |
| `SECURITY_BOOTSTRAP_USERNAME` | Vacío | Usuario de la primera cuenta TI. |
| `SECURITY_BOOTSTRAP_PASSWORD` | Vacío | Contraseña de bootstrap. |
| `SCHEDULED_PROCESS_ACCOUNTS` | Cuenta de ingesta de Airflow en Compose | Nombres autorizados para operaciones programadas. |

El frontend consume `/api` en su mismo origen. nginx reenvía estas peticiones al backend.

`VITE_BACKEND_HEALTH_URL` permanece en la plantilla, pero no cambia el proxy de la API definido por nginx.

### Embeddings y generación

| Variable | Valor de referencia | Descripción |
|---|---|---|
| `BGE_M3_MODEL_ID` | `BAAI/bge-m3` | Modelo local de embeddings. |
| `GROQ_API_KEY` | Vacío | Credencial requerida para generación mediante Groq. |
| `GROQ_TIMEOUT_SECONDS` | `30` | Timeout del transporte hacia Groq. |
| `GROQ_MAX_REQUEST_BYTES` | `60000` | Límite del cuerpo enviado al proveedor. |
| `GROQ_MAX_CONCURRENCY` | `1` | Solicitudes concurrentes al proveedor. |
| `GROQ_MAX_QUEUE` | `8` | Capacidad de la cola local. |
| `GROQ_RPM_LIMIT` | `27` | Presupuesto local de solicitudes por minuto. |
| `GROQ_TPM_LIMIT` | `6400` | Presupuesto local estimado de tokens por minuto. |
| `GROQ_MAX_IN_FLIGHT_PER_USER` | `1` | Operaciones simultáneas por usuario. |
| `GROQ_MAX_RETRIES` | `2` | Máximo de reintentos adicionales ante HTTP 429. |
| `GROQ_BACKOFF_BASE_SECONDS` | `1` | Base del backoff. |
| `GROQ_BACKOFF_MAX_SECONDS` | `8` | Tope del backoff. |
| `GROQ_RETRY_AFTER_MAX_SECONDS` | `60` | Límite admitido de espera por `Retry-After`. |
| `GROQ_OPERATION_DEADLINE_SECONDS` | `45` | Presupuesto temporal de la operación del proveedor. |
| `GROQ_PROMPT_BYTES_PER_TOKEN` | `3` | Factor utilizado para estimar tokens. |
| `GROQ_COMPLETION_TOKEN_RESERVE` | `512` | Reserva de tokens para la respuesta. |

Estos valores son controles locales de la aplicación; no garantizan la cuota disponible en una cuenta Groq.

El modelo generativo y su origen HTTPS están fijados por la implementación del MVP. El backend se ejecuta con un único worker porque el gestor de capacidad se comparte en la memoria del proceso.

### Airflow y recursos

| Variables | Uso |
|---|---|
| `AIRFLOW_PORT` | Puerto web; predeterminado `8080`. |
| `AIRFLOW_ADMIN_USER`, `AIRFLOW_ADMIN_PASSWORD`, `AIRFLOW_ADMIN_EMAIL` | Administrador web de Airflow. |
| `AIRFLOW_INGESTION_USERNAME`, `AIRFLOW_INGESTION_PASSWORD` | Cuenta de la aplicación utilizada por el DAG. |
| `AIRFLOW_FERNET_KEY` | Clave Fernet de Airflow. |
| `AIRFLOW_WEBSERVER_SECRET_KEY` | Secreto del webserver de Airflow. |
| `POSTGRES_SHARED_BUFFERS`, `POSTGRES_MAX_CONNECTIONS` | Ajustes de PostgreSQL. |
| `POSTGRES_MEM_LIMIT`, `BACKEND_MEM_LIMIT`, `FRONTEND_MEM_LIMIT` | Techos de memoria de esos servicios. |
| `AIRFLOW_SCHEDULER_MEM_LIMIT`, `AIRFLOW_WEBSERVER_MEM_LIMIT` | Techos de memoria de Airflow. |

### Valores fijados por el Compose actual

Algunas entradas de la plantilla corresponden a la configuración del backend, pero Compose no transmite todas ellas como ajustes libres:

- Dimensionalidad: `1024`.
- Caché del modelo: `/home/appuser/.cache/bge-m3`.
- Carga obligatoria del modelo al arrancar: desactivada.
- Almacenamiento de ingesta: `/data/ingestion`.
- Ubicaciones controladas: `/data/controlled`.
- `BACKEND_WORKERS` y `WEB_CONCURRENCY`: `1`.

Los límites `INGESTION_*` de la plantilla no se trasladan actualmente al servicio mediante Compose; el backend utiliza sus valores predeterminados, incluido un máximo de archivo de **52.428.800 bytes (50 MiB)**. Editar esas entradas en `.env` por sí solo no modifica el límite del contenedor.

## 4. Endpoints

La URL base del backend es http://localhost:8000 con la configuración predeterminada.

Las rutas funcionales requieren autenticación y los permisos correspondientes. Login y refresh utilizan sus propios mecanismos de autenticación.

### Salud

| Método | Ruta | Propósito |
|---|---|---|
| `GET` | `/health` | Comprueba que el backend sirve peticiones. |
| `GET` | `/health/ready` | Comprueba PostgreSQL y pgvector; devuelve 503 si no están disponibles. |
| `GET` | `/health/embeddings` | Consulta el estado del modelo sin cargarlo. |
| `POST` | `/health/embeddings/probe` | Carga y verifica BGE-M3; requiere `technical_config.manage`. |

El frontend dispone de su propio `GET /health`, accesible en http://localhost:3000/health.

### Autenticación

| Método | Ruta | Propósito |
|---|---|---|
| `POST` | `/api/auth/login` | Inicia sesión; devuelve el token de acceso y establece la cookie de refresh. |
| `POST` | `/api/auth/refresh` | Renueva el acceso utilizando la cookie de refresh. |
| `POST` | `/api/auth/logout` | Cierra la sesión autenticada. |
| `GET` | `/api/auth/me` | Devuelve la identidad de la sesión: `id`, `username`, `display_name` (nombre asignado, solo para presentación; si falta se usa `username`) y `roles`. |

Login recibe un cuerpo JSON con `username` y `password`. Las solicitudes protegidas presentan el acceso mediante `Authorization: Bearer <token>`.

### Ingesta, cuarentena y coordinación

| Método | Ruta | Propósito |
|---|---|---|
| `POST` | `/api/ingestion/uploads` | Carga manual mediante multipart; requiere `Idempotency-Key`. |
| `POST` | `/api/ingestion/runs` | Procesa una ubicación controlada. |
| `GET` | `/api/validation/quarantine` | Consulta elementos de cuarentena. |
| `PATCH` | `/api/validation/quarantine/{item_id}/reinject` | Corrige y reinyecta un elemento. |
| `POST` | `/api/validation/quarantine/{item_id}/discard` | Descarta un elemento con justificación. |
| `POST` | `/api/coordination/dispatch` | Despacha el procesamiento de un archivo. |
| `POST` | `/api/coordination/kpi-recalculations/scheduled` | Solicita recálculo programado. |
| `POST` | `/api/coordination/proactive-analysis/scheduled` | Solicita análisis proactivo programado. |

La carga manual recibe `file`, `controlled_location` y, opcionalmente, `document_date` en formato `YYYY-MM-DD`.

Las dos operaciones programadas requieren permiso funcional y una identidad incluida en `SCHEDULED_PROCESS_ACCOUNTS`.

### Indicadores, documentos y RAG

| Método | Ruta | Propósito |
|---|---|---|
| `GET` | `/api/dashboard/kpis` | Consulta indicadores para los filtros solicitados. |
| `GET` | `/api/dashboard/analysis` | Consulta resultados de análisis proactivo. |
| `GET` | `/api/technical/kpis/KPI-CD-03` | Consulta el indicador técnico OCR. |
| `GET` | `/api/documents/ocr` | Consulta resultados y estado OCR. |
| `POST` | `/api/documents/{document_id}/ocr/reprocess` | Solicita reprocesamiento OCR. |
| `GET` | `/api/documents/viewer` | Consulta el catálogo documental autorizado. |
| `GET` | `/api/documents/viewer/{document_id}` | Obtiene contenido documental autorizado. |
| `GET` | `/api/documents/viewer/{document_id}/original` | Obtiene el PDF original autorizado; requiere `version_id`. |
| `POST` | `/api/documents/viewer/{document_id}/print` | Registra en auditoría la impresión solicitada de la versión vigente; requiere `version_id`. Devuelve solo `operation_id` y `correlation_id`. |
| `POST` | `/api/rag/query` | Ejecuta una consulta RAG. |

La consulta RAG recibe `query` y admite `context_reference_id` y `retry_of_operation_id` opcionales. También admite una cabecera `Idempotency-Key` con UUID.

### Administración y auditoría

| Método | Ruta | Propósito |
|---|---|---|
| `GET` | `/api/security/users` | Lista cuentas en solo lectura (usuario, nombre asignado, estado y roles activos); filtros `q`, `state`, `role`, paginación por `cursor`. Requiere un permiso de administración de cuentas; se audita (`ACCOUNT_LIST`) sin el texto buscado. |
| `GET` | `/api/security/document-scopes` | Lista los alcances documentales por rol y familia. Requiere `document_acl.manage`; se audita (`DOCUMENT_SCOPE_LIST`). |
| `GET` | `/api/security/document-exceptions` | Lista las excepciones documentales vigentes (por cuenta o rol, con el identificador del documento); filtros `subject`, `account_id`, `role_id`, `document_id`, paginación por `cursor`. Requiere `document_acl.manage`; se audita (`DOCUMENT_EXCEPTION_LIST`). |
| `POST` | `/api/security/users` | Crea una cuenta. |
| `PATCH` | `/api/security/users/{account_id}` | Actualiza su nombre visible. |
| `POST` | `/api/security/users/{account_id}/activate` | Activa la cuenta. |
| `POST` | `/api/security/users/{account_id}/disable` | Deshabilita la cuenta. |
| `POST` | `/api/security/users/{account_id}/reset-access` | Restablece su contraseña. |
| `PUT` | `/api/security/users/{account_id}/roles` | Sustituye sus roles. |
| `PUT` | `/api/security/document-scopes/{role_id}/{source_family}` | Administra acceso documental por familia. |
| `PUT` | `/api/security/document-exceptions/user/{account_id}/{document_id}` | Administra excepciones por cuenta y documento. |
| `PUT` | `/api/security/document-exceptions/role/{role_id}/{document_id}` | Administra excepciones por rol y documento. |
| `GET` | `/api/audit/events` | Consulta los eventos permitidos para la cuenta. |

### Documentación interactiva

Está desactivada por defecto. Para habilitarla deliberadamente en desarrollo:

```dotenv
API_DOCS_ENABLED=true
```

Recrea el backend para aplicar el cambio:

```powershell
docker compose up -d backend
```

Quedarán disponibles:

- Swagger: http://localhost:8000/docs
- ReDoc: http://localhost:8000/redoc
- OpenAPI: http://localhost:8000/openapi.json

El esquema OpenAPI permite consultar los cuerpos, filtros y respuestas de cada operación.

## 5. Seguridad

### Cuentas y sesiones

- Contraseñas protegidas con Argon2id.
- JWT de acceso HS256 con vigencia de 30 minutos.
- Sesión con duración máxima absoluta de ocho horas.
- Refresh opaco, almacenado mediante hash y rotado después de su uso.
- Cookie de refresh `HttpOnly`, `SameSite=Strict` y limitada a `/api/auth`.
- Token de acceso conservado en memoria por el frontend.
- Verificación del estado vigente de cuenta, sesión y autorización.

Los cambios de cuenta, roles o autorizaciones invalidan las sesiones afectadas conforme a las reglas implementadas.

Las cuentas se deshabilitan; no se eliminan físicamente. Un TI no puede modificar sus propios roles ni deshabilitar al último TI activo.

La lista de cuentas y la consulta de permisos documentales vigentes son de solo lectura, exclusivas de TI, no exponen contraseñas, hashes ni sesiones y se registran en auditoría sin el texto buscado.

### Permisos y documentos

Los roles funcionales son **Jurídico**, **Analista** y **TI**. Una cuenta puede tener varios roles activos.

La autorización documental es independiente de los permisos funcionales, con esta precedencia:

```text
Denegación explícita por documento
→ Autorización explícita por documento
→ Autorización por rol y familia
→ Denegación por defecto
```

El alcance documental autorizado se aplica antes de recuperar contenido y antes de enviarlo a Groq. Cada apertura de un documento en el visor y cada impresión quedan registradas en auditoría; si la impresión no puede registrarse, no se imprime. Las referencias de contexto del análisis proactivo no conceden permisos ni constituyen evidencia por sí mismas.

### Auditoría y operación

La auditoría es append-only. El usuario runtime puede insertar eventos, pero no leer, actualizar ni eliminar la bitácora; la consulta utiliza una identidad lectora independiente.

El backend se ejecuta como usuario sin privilegios de root y verifica su identidad de base de datos, revisión de esquema y privilegios antes de servir la API mediante Compose.

CORS utiliza orígenes explícitos. nginx aplica cabeceras de endurecimiento y desactiva la caché y el registro de acceso en las rutas de API.

El Compose descrito sirve HTTP para desarrollo local. Un despliegue fuera de ese entorno requiere TLS/HTTPS y cookies `Secure`; el Compose actual no configura la terminación TLS.

Los secretos, tokens y documentos sensibles no deben incorporarse a Git ni copiarse a registros o reportes de prueba.

## 6. Pruebas y verificación

Las pruebas del backend se encuentran en `backend/tests`, las del frontend en `frontend/tests` y las del DAG en `airflow/tests`.

Los comandos de esta sección son independientes del arranque normal del sistema.

### 6.1. Comprobaciones del entorno

Con los servicios iniciados:

```powershell
docker compose --profile airflow ps
Invoke-RestMethod http://localhost:3000/health
Invoke-RestMethod http://localhost:8000/health
Invoke-RestMethod http://localhost:8000/health/ready
Invoke-RestMethod http://localhost:8080/health
```

Estas comprobaciones informan de la disponibilidad de los servicios; no sustituyen las pruebas funcionales. El script de la sección 6.5 las reúne junto con la revisión del esquema y las cuentas.

### 6.2. Backend

Para trabajar fuera del contenedor utiliza Python 3.12 y un entorno virtual.

Desde la raíz del repositorio:

```powershell
Push-Location backend

python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt

# Ejemplo acotado: JWT, contraseñas y transporte Groq simulado
.\.venv\Scripts\python.exe -m pytest tests/security/test_tokens_and_passwords.py tests/rag/test_provider.py -v

Pop-Location
```

Este ejemplo utiliza pruebas existentes y no requiere llamar al servicio real de Groq.

> En Windows, si el repositorio está en una carpeta con una ruta muy larga, `pip install` puede fallar con `OSError: [Errno 2] No such file or directory` al crear `backend\.venv`, por el límite de 260 caracteres. Habilita la compatibilidad con rutas largas de Windows o crea el entorno virtual en una ruta corta, por ejemplo `python -m venv C:\venv-riesgo-legal`, y usa ese intérprete en los comandos anteriores.

La imagen del backend no incorpora las pruebas ni las dependencias de desarrollo.

### 6.3. Integración con PostgreSQL y modelo real

Las suites PostgreSQL necesitan un **clúster temporal dedicado**, separado del servidor habitual. Varias pruebas ejecutan migraciones descendentes y modifican roles de alcance global del clúster.

No basta con crear otra base dentro del mismo servidor para aislar esas operaciones.

El entorno de integración debe utilizar:

- Imagen `pgvector/pgvector:pg16`.
- Inicialización `--encoding=UTF8 --locale=C`.
- Bases de prueba y credenciales propias.
- Migraciones y usuarios runtime/lector según los requisitos de cada fixture.
- Conexiones protegidas mediante variables como `DATA_TEST_DATABASE_URL`, `RUNTIME_TEST_DATABASE_URL`, `AUDIT_TEST_*` y `VIEWER_TEST_*`.

Algunas suites esperan URL SQLAlchemy y otras cadenas libpq. Debe respetarse el formato solicitado por cada fixture; los marcadores de pytest no identifican por sí solos todas las pruebas que necesitan base de datos.

Con el entorno aislado preparado, la suite del backend se ejecuta desde `backend` mediante:

```powershell
.\.venv\Scripts\python.exe -m pytest -v
```

Las pruebas que utilizan BGE-M3 real requieren además las dependencias de `requirements-ml.txt`, la caché del modelo y recursos suficientes. La imagen Docker del backend ya instala esas dependencias.

Un caso omitido se reporta como `SKIP`; no demuestra que la funcionalidad haya sido verificada. Las pruebas del proveedor con respuestas simuladas tampoco certifican la disponibilidad de Groq.

### 6.4. Frontend

Para ejecutar las pruebas localmente utiliza Node.js 22.

Desde la raíz del repositorio:

```powershell
Push-Location frontend

npm ci
npm test
npm run build

Pop-Location
```

`npm test` ejecuta las pruebas estáticas y unitarias. `npm run build` comprueba la compilación del frontend.

Para las pruebas de navegador:

```powershell
Push-Location frontend

npx playwright install chromium
# Aísla las pruebas de cualquier backend que esté corriendo en el puerto 8000
$env:FRONTEND_API_TARGET = 'http://127.0.0.1:9'
npm run test:e2e
Remove-Item Env:FRONTEND_API_TARGET

Pop-Location
```

Playwright inicia su servidor de prueba en `http://127.0.0.1:5173` y verifica tres tamaños de pantalla. `FRONTEND_API_TARGET` apunta el proxy de la API a un puerto sin servicio, de modo que ninguna petición no simulada llegue a un backend real.

Estas pruebas utilizan fixtures HTTP sintéticos. Verifican la interfaz y sus contratos; no equivalen a una prueba completa contra PostgreSQL, OCR y Groq reales.

### 6.5. Scripts de verificación

Con la instalación en ejecución:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\verificar_instalacion.ps1
```

Comprueba:

- que `.env` no conserva valores de ejemplo y no está versionado;
- que `.env.example` no contiene secretos reales;
- que Compose interpreta la configuración;
- la salud de PostgreSQL, el backend y el frontend, y la readiness con pgvector;
- la revisión del esquema;
- la identidad y los privilegios del backend (`runtime_check`);
- que existe una cuenta TI activa;
- si Airflow está en ejecución, su salud, el DAG y la cuenta de proceso.

Informa cada comprobación como `PASS` o `FAIL` y termina con código 0 solo si todas pasan. No modifica datos ni muestra secretos.

Las pruebas del cargador de demostración se ejecutan sin dependencias:

```powershell
python -m unittest demo/test_cargar_demo.py
```

También existe:

```powershell
python scripts/check_fresh_volumes.py --image riesgo-legal-backend:bootstrap
```

Este script comprueba escritura funcional con el usuario de la imagen en volúmenes temporales nuevos. Crea y elimina sus propios volúmenes de prueba.

## 7. Desarrollo

Durante el desarrollo se utilizaron asistentes de programación basados en inteligencia artificial como apoyo para redactar código, pruebas y documentación. Todo cambio fue revisado, probado y aprobado por el autor antes de incorporarse al repositorio, y los requisitos se rigen por la especificación del proyecto, no por las herramientas utilizadas.

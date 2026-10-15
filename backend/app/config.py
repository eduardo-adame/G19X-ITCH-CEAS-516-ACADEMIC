"""Configuración del backend leída desde variables de entorno.

Todos los valores tienen un valor por defecto apto para desarrollo y no contienen
secretos: las credenciales reales viven en el archivo `.env`, excluido de Git.
"""
from __future__ import annotations

import json
import os
from functools import lru_cache

from pydantic import SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Configuración de entorno del backend."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- Identidad del servicio -------------------------------------------
    app_name: str = "backend-riesgo-legal"
    environment: str = "development"
    # La documentación interactiva (Swagger, ReDoc y el esquema OpenAPI) solo se publica con
    # habilitación explícita; no se deriva de `environment`, que el runtime local usa como desarrollo.
    api_docs_enabled: bool = False

    # --- Persistencia (PostgreSQL + pgvector) ------------------------------
    # Se usa para comprobar conectividad y disponibilidad de la extensión
    # vectorial. El arranque de la API no ejecuta migraciones automáticamente;
    # el esquema se administra de forma explícita mediante Alembic.
    postgres_host: str = "postgres"
    postgres_port: int = 5432
    postgres_user: str = "app"
    postgres_password: str = ""
    postgres_db: str = "riesgo_legal"

    # La identidad lectora no sustituye el runtime ni recibe credenciales de migración.
    audit_postgres_user: str = ""
    audit_postgres_password: SecretStr | None = None

    # --- Embeddings BGE-M3 --------------------------------------------------
    bge_m3_model_id: str = "BAAI/bge-m3"
    # Ruta dentro del contenedor; debe coincidir con el punto de montaje del
    # volumen de caché definido en docker-compose.yml.
    bge_m3_cache_dir: str = "/home/appuser/.cache/bge-m3"
    # Dimensionalidad de salida del modelo. Es una propiedad del modelo, no un
    # parámetro libre: la aplicación rechaza cualquier vector de otra longitud.
    embedding_dimensions: int = 1024
    # Si es False, el servicio arranca aunque el modelo no esté disponible.
    bge_m3_required_at_startup: bool = False

    # --- Inferencia RAG mediante Groq ------------------------------------
    # La clave real proviene únicamente del entorno protegido y no es obligatoria
    # para arrancar rutas que no realizan generación.
    groq_api_key: SecretStr | None = None
    groq_model: str = "openai/gpt-oss-120b"
    groq_base_url: str = "https://api.groq.com/openai/v1"
    groq_timeout_seconds: float = 30.0
    groq_max_request_bytes: int = 60_000

    @field_validator("groq_model")
    @classmethod
    def validate_groq_model(cls, value: str) -> str:
        if value != "openai/gpt-oss-120b":
            raise ValueError("Modelo Groq no aprobado")
        return value

    @field_validator("groq_base_url")
    @classmethod
    def validate_groq_base_url(cls, value: str) -> str:
        if value != "https://api.groq.com/openai/v1":
            raise ValueError("Origen Groq no aprobado")
        return value

    @field_validator("groq_timeout_seconds")
    @classmethod
    def validate_groq_timeout(cls, value: float) -> float:
        if value <= 0:
            raise ValueError("Timeout Groq no válido")
        return value

    @field_validator("groq_max_request_bytes")
    @classmethod
    def validate_groq_request_limit(cls, value: int) -> int:
        if value <= 0 or value > 60_000:
            raise ValueError("Límite de solicitud Groq no válido")
        return value

    # --- Capacidad del proveedor (F-14) -----------------------------------
    # Presupuesto local compartido por todas las operaciones del proceso. Los
    # valores por defecto parten de las referencias de §5.1 para gpt-oss-120b
    # (30 RPM, 8,000 TPM) con margen: ~90 % de RPM y ~80 % de TPM, porque la
    # estimación de tokens antes del envío no es exacta. Son configurables por
    # cuenta y modelo; una configuración inválida impide el arranque.
    groq_max_concurrency: int = 1
    groq_max_queue: int = 8
    groq_rpm_limit: int = 27
    groq_tpm_limit: int = 6_400
    groq_max_in_flight_per_user: int = 1
    groq_max_retries: int = 2
    groq_backoff_base_seconds: float = 1.0
    groq_backoff_max_seconds: float = 8.0
    groq_retry_after_max_seconds: float = 60.0
    groq_operation_deadline_seconds: float = 45.0
    groq_prompt_bytes_per_token: float = 3.0
    groq_completion_token_reserve: int = 512
    # El limitador vive en memoria del proceso: solo es correcto con un único
    # worker. Cualquier otro valor se rechaza al arrancar.
    backend_workers: int = 1

    @field_validator("groq_max_concurrency", "groq_max_in_flight_per_user")
    @classmethod
    def validate_groq_concurrency(cls, value: int) -> int:
        if not 1 <= value <= 8:
            raise ValueError("Concurrencia Groq no válida")
        return value

    @field_validator("groq_max_queue")
    @classmethod
    def validate_groq_queue(cls, value: int) -> int:
        if not 0 <= value <= 64:
            raise ValueError("Cola Groq no válida")
        return value

    @field_validator("groq_rpm_limit")
    @classmethod
    def validate_groq_rpm(cls, value: int) -> int:
        if not 1 <= value <= 10_000:
            raise ValueError("Límite RPM de Groq no válido")
        return value

    @field_validator("groq_tpm_limit")
    @classmethod
    def validate_groq_tpm(cls, value: int) -> int:
        if not 500 <= value <= 10_000_000:
            raise ValueError("Límite TPM de Groq no válido")
        return value

    @field_validator("groq_max_retries")
    @classmethod
    def validate_groq_retries(cls, value: int) -> int:
        # RF-059: como máximo dos reintentos adicionales ante HTTP 429.
        if not 0 <= value <= 2:
            raise ValueError("Reintentos Groq no válidos")
        return value

    @field_validator("groq_backoff_base_seconds")
    @classmethod
    def validate_groq_backoff_base(cls, value: float) -> float:
        if not 0.1 <= value <= 10:
            raise ValueError("Backoff base de Groq no válido")
        return value

    @field_validator("groq_retry_after_max_seconds")
    @classmethod
    def validate_groq_retry_after(cls, value: float) -> float:
        if not 1 <= value <= 300:
            raise ValueError("Retry-After máximo de Groq no válido")
        return value

    @field_validator("groq_operation_deadline_seconds")
    @classmethod
    def validate_groq_deadline(cls, value: float) -> float:
        if not 5 <= value <= 120:
            raise ValueError("Plazo de operación Groq no válido")
        return value

    @field_validator("groq_prompt_bytes_per_token")
    @classmethod
    def validate_groq_bytes_per_token(cls, value: float) -> float:
        if not 1.5 <= value <= 6.0:
            raise ValueError("Estimación de tokens de Groq no válida")
        return value

    @field_validator("groq_completion_token_reserve")
    @classmethod
    def validate_groq_completion_reserve(cls, value: int) -> int:
        if not 64 <= value <= 4096:
            raise ValueError("Reserva de salida de Groq no válida")
        return value

    @field_validator("backend_workers")
    @classmethod
    def validate_backend_workers(cls, value: int) -> int:
        if value != 1:
            raise ValueError("El backend debe ejecutarse con un único worker (limitador local al proceso)")
        return value

    @model_validator(mode="after")
    def validate_provider_capacity(self) -> "Settings":
        if not self.groq_backoff_base_seconds <= self.groq_backoff_max_seconds <= 60:
            raise ValueError("Backoff máximo de Groq no válido")
        if self.groq_completion_token_reserve >= self.groq_tpm_limit:
            raise ValueError("La reserva de salida de Groq debe ser menor que el límite TPM")
        # uvicorn toma WEB_CONCURRENCY como número de workers: con el limitador local solo se admite uno.
        workers = os.environ.get("WEB_CONCURRENCY", "").strip()
        if workers not in ("", "1"):
            raise ValueError("WEB_CONCURRENCY debe ser 1 mientras el limitador del proveedor sea local al proceso")
        return self

    # --- CORS ---------------------------------------------------------------
    # Orígenes permitidos explícitos. No se usa "*" por defecto: permitir
    # cualquier origen en un servicio que pronto manejará datos protegidos es un
    # riesgo innecesario.
    backend_cors_origins: str = "http://localhost:3000"

    # --- Autenticación y sesiones -----------------------------------------
    # El keyring se recibe como objeto JSON ``{\"kid\": \"secreto-base64url\"}``.
    # No hay una clave de reserva en código: un entorno que atienda usuarios
    # debe aportar su material criptográfico mediante configuración protegida.
    security_jwt_issuer: str = "riesgo-legal-backend"
    security_jwt_audience: str = "riesgo-legal-web"
    security_jwt_keyring_json: str = "{}"
    security_jwt_active_kid: str = ""
    security_refresh_cookie_name: str = "riesgo_legal_refresh"
    security_refresh_cookie_secure: bool | None = None
    security_bootstrap_enabled: bool = False
    security_bootstrap_username: str | None = None
    security_bootstrap_password: str | None = None

    # --- Ingesta de archivos ---------------------------------------------
    ingestion_storage_root: str = ".data/ingestion"
    ingestion_controlled_root: str = ".data/controlled"
    ingestion_max_file_bytes: int = 52_428_800
    ingestion_max_archive_entries: int = 2_000
    ingestion_max_archive_uncompressed_bytes: int = 268_435_456
    ingestion_max_archive_entry_bytes: int = 67_108_864
    ingestion_max_compression_ratio: float = 100.0
    ingestion_csv_sample_bytes: int = 65_536
    ingestion_stream_chunk_bytes: int = 1_048_576
    ingestion_max_tabular_rows: int = 250_000
    ingestion_max_tabular_columns: int = 256
    ingestion_max_tabular_cells: int = 5_000_000

    @field_validator(
        "ingestion_max_file_bytes",
        "ingestion_max_archive_entries",
        "ingestion_max_archive_uncompressed_bytes",
        "ingestion_max_archive_entry_bytes",
        "ingestion_csv_sample_bytes",
        "ingestion_stream_chunk_bytes",
        "ingestion_max_tabular_rows",
        "ingestion_max_tabular_columns",
        "ingestion_max_tabular_cells",
    )
    @classmethod
    def validate_positive_ingestion_limit(cls, value: int) -> int:
        if value <= 0:
            raise ValueError("Los límites de ingesta deben ser positivos")
        return value

    @field_validator("ingestion_max_compression_ratio")
    @classmethod
    def validate_compression_ratio(cls, value: float) -> float:
        if value <= 1:
            raise ValueError("La relación máxima de compresión debe ser mayor que uno")
        return value

    # --- Procesamiento documental / OCR ------------------------------------
    # Valores por defecto de implementación para desarrollo; no son requisitos
    # del contrato funcional y pueden ajustarse por configuración.
    ocr_dpi: int = 300
    ocr_min_dpi: int = 150
    ocr_max_dpi: int = 600
    ocr_max_pages_per_document: int = 1000
    ocr_timeout_seconds: int = 300
    # Límite de dimensiones de la imagen rasterizada (píxeles decodificados).
    ocr_max_image_pixels: int = 100_000_000

    # --- Fragmentación de corpus -------------------------------------------
    # Segmentación estructural por defecto: 512 tokens con 50 de solapamiento.
    chunk_max_tokens: int = 512
    chunk_overlap_tokens: int = 50

    # --- Coordinación de despacho ------------------------------------------
    # Umbral de recuperación de despachos en curso sin latido reciente.
    coordination_stale_threshold_seconds: int = 3600
    # Tiempo máximo del cliente de coordinación; mayor que el timeout de OCR.
    coordination_timeout_seconds: int = 360
    # Cuentas de proceso autorizadas para operaciones programadas (recálculo de
    # KPI y análisis proactivo), separadas por comas. Vacío = ninguna cuenta:
    # las operaciones programadas exigen el permiso aplicable y además pertenecer
    # a esta lista.
    scheduled_process_accounts: str = ""

    @field_validator("ocr_dpi", "ocr_min_dpi", "ocr_max_dpi", "ocr_max_pages_per_document", "ocr_timeout_seconds", "ocr_max_image_pixels", "chunk_max_tokens")
    @classmethod
    def validate_positive_document_limit(cls, value: int) -> int:
        if value <= 0:
            raise ValueError("Los límites documentales deben ser positivos")
        return value

    @field_validator("chunk_overlap_tokens")
    @classmethod
    def validate_overlap(cls, value: int) -> int:
        if value < 0:
            raise ValueError("El solapamiento de fragmentos no puede ser negativo")
        return value

    @field_validator("security_jwt_keyring_json")
    @classmethod
    def validate_keyring_json(cls, value: str) -> str:
        """Comprueba que el formato de configuración no sea ambiguo."""
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError as exc:
            raise ValueError("SECURITY_JWT_KEYRING_JSON debe ser JSON válido") from exc
        if not isinstance(parsed, dict) or not all(
            isinstance(kid, str) and isinstance(secret, str)
            for kid, secret in parsed.items()
        ):
            raise ValueError("SECURITY_JWT_KEYRING_JSON debe ser un objeto de claves de texto")
        return value

    @property
    def scheduled_process_account_set(self) -> frozenset[str]:
        """Identidades de proceso configuradas; conjunto vacío significa denegar a todas."""
        return frozenset(name.strip() for name in self.scheduled_process_accounts.split(",") if name.strip())

    @property
    def cors_origin_list(self) -> list[str]:
        """Lista de orígenes CORS a partir de la cadena separada por comas."""
        return [origin.strip() for origin in self.backend_cors_origins.split(",") if origin.strip()]

    @property
    def jwt_keyring(self) -> dict[str, str]:
        """Devuelve únicamente claves configuradas localmente."""
        return dict(json.loads(self.security_jwt_keyring_json))

    @property
    def refresh_cookie_secure(self) -> bool:
        """Exige la marca Secure fuera del entorno de desarrollo."""
        if self.security_refresh_cookie_secure is not None:
            return self.security_refresh_cookie_secure
        return self.environment.lower() != "development"

    @property
    def sqlalchemy_style_dsn(self) -> str:
        """DSN legible para logs. Nunca incluye la contraseña."""
        return (
            f"postgresql://{self.postgres_user}:***"
            f"@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"
        )

    @property
    def psycopg_conninfo(self) -> str:
        """Conninfo para psycopg. La contraseña no se registra en logs."""
        return (
            f"host={self.postgres_host} port={self.postgres_port} "
            f"user={self.postgres_user} password={self.postgres_password} "
            f"dbname={self.postgres_db} connect_timeout=5"
        )

    @property
    def audit_psycopg_conninfo(self) -> str | None:
        """No existe identidad de reserva cuando falta la configuración protegida."""
        if not self.audit_postgres_user or not self.audit_postgres_password:
            return None
        from psycopg.conninfo import make_conninfo
        return make_conninfo(host=self.postgres_host, port=self.postgres_port, dbname=self.postgres_db,
                             user=self.audit_postgres_user,
                             password=self.audit_postgres_password.get_secret_value(), connect_timeout=5)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Devuelve una única instancia de configuración por proceso."""
    return Settings()

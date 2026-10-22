# Verificación del sistema

Este documento resume lo que se ejecutó para comprobar que el sistema se instala, funciona con datos y se comporta como
indica la especificación. Todo se ejecutó en el equipo del autor: Windows 11, Docker Desktop y PowerShell 5.1. Las
cifras corresponden a `main` en `a3df262` y a las certificaciones de los días previos sobre el mismo código de la
aplicación.

## 1. Instalación desde cero con datos de demostración (2026-10-21)

Se clonó el repositorio en una carpeta vacía, sin `.env`, y se ejecutó un único comando:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\instalar.ps1 -ConAirflow -ConDemo
```

| Comprobación | Resultado |
| --- | --- |
| Instalación completa | Código 0 en 5.5 minutos |
| Primera instalación | `BASE_PREPARADA`, `CUENTA_TI_CREADA`, `CUENTA_PROCESO_CREADA`, `ALCANCE_DOCUMENTAL_CONCEDIDO: 12 nuevos`, `PRIMERA_INSTALACION_COMPLETADA` |
| Datos de demostración | 10 cargas `201 COMPLETADO`; recálculo y análisis `COMPLETED`; **2 alertas** y **7 elementos en cuarentena** |
| `scripts/verificar_instalacion.ps1` | Todas las comprobaciones en `PASS`: «instalación correcta» |
| Repetir la instalación | Sin cambios en archivos (10), documentos (4), cuarentena (7), cuentas (4) ni análisis (1) |
| Recorrido de las vistas | Resumen, Litigios, Tendencias, Cuarentena, Visor, Ingesta, Auditoría y Administración con datos y sin errores de JavaScript |

| Resumen ejecutivo | Tendencias y riesgos |
| --- | --- |
| ![Resumen ejecutivo con indicadores y dos alertas](capturas/resumen-ejecutivo.png) | ![Tendencias y riesgos con alertas y tabla de evaluaciones](capturas/tendencias-y-riesgos.png) |

| Zona de cuarentena | Consulta documental con cita |
| --- | --- |
| ![Zona de cuarentena con un elemento por regla](capturas/zona-de-cuarentena.png) | ![Respuesta con evidencia suficiente y fuente citada](capturas/consulta-documental.png) |

La consulta documental de la captura se hizo con `GROQ_API_KEY` configurada. Sin clave, la misma consulta muestra las
fuentes recuperadas y el aviso de que no se pudo generar la respuesta (sección 4).

## 2. Instalación manual siguiendo el README (2026-10-19)

Se ejecutaron literalmente las secciones 2.2 a 2.11 del README en un clon nuevo desde GitHub:

- configuración, migraciones (revisión `0019_rag_provider_telemetry`), cuenta TI y salud;
- alcance documental desde **Administración**, que antes de concederse deniega por defecto;
- carga manual de CSV y PDF, ubicación controlada, DAG de Airflow con sus tres tareas en `success`;
- carga de BGE-M3 y persistencia tras `down` y `up`;
- pruebas de ejemplo de las secciones 6.2 (40 correctas) y 6.4 (frontend: 12 estáticas y 905 unitarias, más el build).

## 3. Análisis proactivo y alertas (2026-10-18)

Se certificó el módulo **Tendencias y riesgos** en un entorno aislado con PostgreSQL y BGE-M3 reales. Los resultados se
compararon con un oráculo independiente escrito a partir de la especificación:

| Bloque | Resultado |
| --- | --- |
| Reglas: variación, tendencia, recurrencia, valores no disponibles y huecos | 88 / 88 |
| Flujo real de seis meses: ingesta → KPI → análisis diario → DAG → concurrencia | 44 / 44 |
| Referencia de contexto de una alerta en la consulta documental | 15 / 15 |
| Interfaz con inicio de sesión real, incluida la caída de la base de datos | 51 / 51 |
| Suites automáticas del backend (análisis, coordinación y seguridad) | 215 unitarias y 120 contra PostgreSQL correctas; 12 casos que requieren el modelo en el contenedor de pruebas o un arnés de roles propio fallan igual en la versión anterior |
| Frontend completo | 905 unitarias y 650 de 651 de navegador (la restante pasó al repetirla) |

## 4. Dependencias de la consulta documental

| Dependencia | Qué pasa si falta | Cómo se detecta |
| --- | --- | --- |
| **BGE-M3** (modelo local de embeddings) | La primera indexación o consulta lo descarga (unos 4.6 GB, requiere Internet). Con `-ConDemo` esto ocurre durante la instalación, al indexar los documentos. | `verificar_instalacion.ps1` avisa si no está en caché (`RAG-02`) |
| **Groq** (`GROQ_API_KEY`) | La consulta recupera las fuentes autorizadas y las muestra; no genera la respuesta ni inventa una. La restricción de alcance y «Sin evidencia» funcionan sin Groq. | `verificar_instalacion.ps1` avisa si la clave está vacía (`RAG-01`); `instalar.ps1 -GroqApiKey <clave>` la configura |
| **Límite por minuto de Groq** | «El servicio de generación alcanzó su límite de uso»; se reintenta tras unos segundos. | README, sección 2.12 |

## 5. Cómo reproducirlo

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\instalar.ps1 -ConAirflow -ConDemo -GroqApiKey <clave-opcional>
powershell -ExecutionPolicy Bypass -File .\scripts\verificar_instalacion.ps1
```

Después abre http://localhost:3000 con `ti-inicial` y la contraseña que muestra el instalador. Lo que debe verse en cada
pantalla está en [`demo/README.md`](../demo/README.md).

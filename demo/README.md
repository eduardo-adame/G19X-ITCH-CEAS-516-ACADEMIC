# Datos de demostración

Todo el contenido de esta carpeta es **ficticio**: empresas, personas, contratos, montos y expedientes inventados para
mostrar el funcionamiento del sistema. Ningún dato proviene de clientes reales.

## Cómo cargarlos

Con la instalación hecha (README, sección 2) y el backend iniciado, desde la raíz del repositorio:

```powershell
docker compose run --rm --no-deps -T --volume "./demo:/demo:ro" --volume "./.env:/configuracion/.env:ro" `
  -e DEMO_TI_USUARIO=ti-inicial -e "DEMO_TI_CONTRASENA=<CONTRASEÑA_TI>" backend python /demo/cargar_demo.py
```

La instalación rápida lo hace automáticamente con `.\scripts\instalar.ps1 -ConDemo`.

El cargador hace lo mismo que haría un analista desde **Operaciones de ingesta**, por la API real:

1. Crea las cuentas `ana.martinez` (Jurídico) y `luis.hernandez` (Analista) si no existen, y muestra una vez sus
   contraseñas. También crea la cuenta de proceso de Airflow si falta.
2. Desplaza las fechas de los archivos para que el último mes de datos sea el **mes en curso**, de modo que el tablero
   siempre tenga un periodo actual. Las fechas de evento nunca quedan en el futuro.
3. Recibe y procesa cada archivo. Los registros válidos se incorporan y los inválidos quedan en la **Zona de cuarentena**.
4. Ejecuta el recálculo programado y el análisis proactivo con la cuenta de proceso, lo mismo que hace el DAG cada
   noche, para que las alertas aparezcan sin esperar.

Puede volver a ejecutarse: si la demostración ya está cargada, lo indica (`DEMO_YA_CARGADA`) y no vuelve a cargar nada.

## Contenido

| Carpeta (ubicación controlada) | Archivo | Contenido |
| --- | --- | --- |
| `contracts-documents` | `contratos.csv` | 29 registros de contratos de seis meses (uno inválido), con firmas, vencimientos y estados de revisión |
| `contracts-documents` | `contratos-actualizacion.csv` | El primer contrato con otro estado: conflicto de identidad |
| `contracts-documents` | `contrato-arrendamiento-oficinas.pdf` | Arrendamiento: renta, depósito, ajuste por INPC, terminación anticipada |
| `contracts-documents` | `contrato-servicios-mantenimiento.pdf` | Mantenimiento: niveles de servicio, penas convencionales, garantía |
| `contracts-documents` | `acuerdo-confidencialidad-proveedor.docx` | Confidencialidad: plazo de reserva, excepciones, pena convencional |
| `litigation` | `litigios.csv` | 25 registros de litigios (dos inválidos) con severidad, monto reclamado y estimación interna |
| `litigation` | `demanda-laboral-expediente-1458.pdf` | Demanda laboral: prestaciones, hechos, pruebas y audiencia |
| `compliance` | `obligaciones.csv` | 10 obligaciones regulatorias (una inválida), vencidas y por vencer, con y sin evidencia |
| `internal-audit` | `incidentes.csv` | 63 incidentes de incumplimiento (uno inválido) en seis áreas |
| `internal-audit` | `asuntos-juridicos.csv` | 37 asuntos jurídicos (uno inválido) por tipo y estado |

### Registros inválidos a propósito

| Archivo | Registro | Regla que incumple |
| --- | --- | --- |
| `contratos.csv` | `CTO-DEMO-999` | Fecha de firma anterior a la de solicitud |
| `contratos-actualizacion.csv` | primer contrato | Conflicto de identidad (mismo identificador, datos distintos): solo puede descartarse |
| `litigios.csv` | `LIT-DEMO-998` | Nivel de severidad fuera de catálogo (`crítico`) |
| `litigios.csv` | `LIT-DEMO-999` | Monto reclamado negativo |
| `obligaciones.csv` | `OBL-DEMO-99` | Falta la fecha límite |
| `incidentes.csv` | `INC-DEMO-999` | Fecha inexistente (31 de septiembre) |
| `asuntos-juridicos.csv` | `ASU-DEMO-999` | Tipo de asunto fuera de catálogo (`Otro`) |

## Qué se ve después de cargarlos

- **Resumen ejecutivo y vistas de dominio:** los indicadores del mes en curso, la composición por severidad y los
  incidentes por área.
- **Evolución:** los indicadores que se calculan por la fecha de negocio de cada registro (nuevos litigios, incidentes
  por área, tiempo de ciclo de los contratos y volumen de asuntos) tienen seis meses de historia.
- **Alertas (Tendencias y riesgos):** por ejemplo, el aumento de nuevos litigios y de incidentes de Operaciones durante
  tres meses consecutivos, con su patrón recurrente.
- **Zona de cuarentena:** siete elementos pendientes, uno por cada regla, para corregir y reinyectar o descartar en vivo.
- **Visor y Consulta documental:** los cuatro documentos. Preguntas de ejemplo con respuesta citada (requieren
  `GROQ_API_KEY`):
  - ¿Cuánto es el depósito en garantía del arrendamiento de oficinas?
  - ¿En cuánto tiempo debe el prestador atender las fallas críticas?
  - ¿Durante cuánto tiempo subsiste la obligación de confidencialidad?
  - ¿Qué reclama la parte actora en la demanda laboral?
  - Para ver la restricción de alcance: ¿Debo demandar al proveedor por incumplimiento?

### Por qué algunos indicadores solo muestran el mes en curso

La exposición por litigios activos, los contratos próximos a vencimiento sin revisión y las obligaciones vencidas son
**fotografías a una fecha de corte**: cuentan lo que el sistema tenía incorporado ese día. Como todos los datos se
incorporan el día de la carga, esos indicadores empiezan con el mes en curso y acumulan historia conforme pasan los
meses. El cargador no altera fechas de incorporación: hacerlo falsearía la trazabilidad.

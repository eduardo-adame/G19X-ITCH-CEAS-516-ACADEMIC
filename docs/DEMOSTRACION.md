# Guion de demostración (6 minutos)

Guion para presentar Legaltech a una persona del área jurídica que nunca ha visto el sistema. Usa los datos ficticios de
[`demo/`](../demo/README.md), cargados con la instalación rápida (`-ConDemo` / `--con-demo`). Cada paso se ensayó completo
sobre una instalación limpia el 2026-10-24: el sistema responde en menos de 10 segundos en todos ellos.

## Antes de presentar (5 minutos)

1. Ejecuta `.\scripts\verificar_instalacion.ps1` (o `./scripts/verificar_instalacion.sh` en Linux o macOS). Debe terminar en
   «instalación correcta» **sin** el aviso `RAG-01`: la consulta documental necesita `GROQ_API_KEY`.
2. Abre dos ventanas del navegador en http://localhost:3000, una normal y una privada:
   - **Ana Martínez** (`ana.martinez`, Jurídico): es la protagonista de la demostración.
   - **Luis Hernández** (`luis.hernandez`, Analista): solo para corregir el registro en la cuarentena.

   Sus contraseñas las muestra una vez el instalador. Si no las guardaste, restablécelas como TI en **Administración →
   Cuentas → Restablecer acceso**.
3. Haz una consulta de prueba cualquiera con Ana y espera un minuto: así se carga el modelo de búsqueda y no se agota el
   límite por minuto del proveedor durante la presentación.

## Guion

| Tiempo | Pantalla y cuenta | Qué hacer | Qué decir |
| --- | --- | --- | --- |
| 0:00 – 1:00 | **Resumen ejecutivo** · Ana | Señala las cinco tarjetas y el bloque «Requiere atención · 2 alertas». | «Aquí se ve el riesgo legal del mes: contratos por vencer sin revisión, exposición por litigios, nuevos litigios, obligaciones vencidas e incidentes. Ana es abogada: ve indicadores y documentos, no las operaciones técnicas.» |
| 1:00 – 2:30 | **Alerta de nuevos litigios** → **Tendencias y riesgos** · Ana | Lee la tarjeta «Los nuevos litigios aumentaron durante tres meses consecutivos»: actual, referencia del análisis y variación. Luego abre Tendencias y ubica la fila «Nuevos litigios por periodo», con tendencia «Creciente». | «El sistema compara cada indicador con los meses anteriores con reglas explícitas. Aquí subió tres meses seguidos, por eso avisa. No es una predicción ni una recomendación: es lo que dicen los datos, y se puede reconstruir paso a paso.» |
| 2:30 – 4:00 | **Zona de cuarentena** · Luis | En la fila «Valor fuera del catálogo» de **Litigios** pulsa **Corregir**, cambia `Nivel_Severidad` de `crítico` a `alto` y pulsa **Validar y reinyectar**. Aparece «Reinyección confirmada». Vuelve a la ventana de Ana y actualiza el Resumen: los nuevos litigios suben en uno. | «Lo que llega mal no se pierde ni se acepta a ciegas: queda en cuarentena con su causa. Se corrige, se valida de nuevo y entra al cálculo. Este otro, el conflicto de identidad, es el mismo contrato con datos distintos: solo se puede descartar con justificación, para no sobrescribir información en silencio.» |
| 4:00 – 5:30 | **Consulta documental** · Ana | Pregunta «¿Cuánto es el depósito en garantía del arrendamiento de oficinas?»: responde «$370,000.00 M.N.» con **Evidencia suficiente** y la cita del contrato. Pulsa **Abrir en el visor**. Después pregunta «¿Debo demandar al proveedor por incumplimiento?»: responde **Fuera del alcance del asistente**. | «Busca solo en los documentos que Ana tiene autorizados y cita la fuente exacta. Cuando se le pide una decisión jurídica, no la toma: ofrece la evidencia para que la persona decida.» |
| 5:30 – 6:00 | **Cierre** | Si da tiempo, muestra **Auditoría** con la cuenta TI: aparecen la reinyección de Luis y las consultas de Ana. | «Todo queda registrado: quién cargó, quién corrigió y quién consultó qué documento. El sistema apoya el análisis; la decisión sigue siendo del profesional.» |

## Si algo falla

| Situación | Qué hacer |
| --- | --- |
| La consulta dice «El servicio no está disponible temporalmente» pero lista fuentes | Falta o falla la clave de Groq. Muestra las **fuentes relacionadas**: la búsqueda y la autorización funcionaron, solo no se redactó la respuesta. |
| «El servicio de generación alcanzó su límite de uso» | Espera un minuto y pulsa **Intentar de nuevo**. Mientras, muestra el Visor documental. |
| «Evidencia insuficiente» | Es el sistema absteniéndose: la pregunta combina varias cosas o no está sustentada. Usa la pregunta exacta del guion. |
| Ya no aparece el registro «crítico» en la cuarentena | Ya se corrigió en un ensayo. Usa otro pendiente: «Importe negativo» (cambia el monto a un valor positivo) o «Fecha no válida» (corrige la fecha a una existente). |
| Una pantalla tarda en cargar | La primera carga tras arrancar puede tardar unos segundos; usa **Actualizar** de la propia página. |

Preguntas alternativas con respuesta citada: «¿En cuánto tiempo debe el prestador atender las fallas críticas?», «¿Durante
cuánto tiempo subsiste la obligación de confidencialidad?», «¿Qué reclama la parte actora en la demanda laboral?».

## Aclaraciones sobre el comportamiento del sistema

- **La contraseña TI se muestra una vez en pantalla.** El instalador la genera y la muestra una sola vez porque es una
  instalación local de un solo administrador: no se guarda en archivos ni en `.env`. En un despliegue real se cambiaría
  al primer inicio de sesión desde **Administración**.
- **Requisitos.** El entorno de referencia pide 16 GB de RAM. El modelo de búsqueda BGE-M3 (unos 4.6 GB) se descarga la
  primera vez; con la demostración, eso ocurre durante la instalación. La generación de respuestas depende de Groq:
  sin clave o sin servicio, el sistema sigue mostrando las fuentes y nunca inventa respuestas.
- **Indicadores con un solo mes en la demostración.** Exposición, contratos por vencer y obligaciones vencidas son
  fotografías a una fecha de corte: en una instalación nueva solo existe el mes en curso. Simular meses anteriores
  exigiría alterar fechas de incorporación, y eso falsearía la trazabilidad.
- **Filtro por entidad «No aplicable».** Los datos de origen no traen una entidad y el sistema no la infiere: el filtro
  solo se activa cuando el dato existe.

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

## Preguntas técnicas

Respuestas breves sobre el funcionamiento interno, con el archivo donde se puede comprobar cada una.

**¿Cómo se combinan la búsqueda vectorial y la léxica?** Cada búsqueda devuelve sus 10 mejores fragmentos: la vectorial
compara el embedding BGE-M3 de la consulta con pgvector y la léxica usa BM25. `fuse_candidates`
(`backend/app/rag/evidence.py`) los une por `fragment_id`, sin duplicados, y da a cada uno la puntuación RRF
Σ 1/(60 + posición) sobre las listas en las que aparece. Un fragmento en la posición 1 de la vectorial y en la 3 de BM25
suma 1/61 + 1/63 ≈ 0.0323; uno que solo está en la posición 1 de una lista suma 1/61 ≈ 0.0164. Así, coincidir en las dos
búsquedas pesa más que encabezar solo una, y k = 60 suaviza la diferencia entre los primeros puestos. Los empates se
resuelven por la mejor posición y al final por `fragment_id`, de modo que el resultado siempre es el mismo. Se conservan
5 fragmentos; no hay reordenamiento ni segunda búsqueda.

**¿Cuándo hay «Evidencia suficiente»?** `classify_evidence` (mismo archivo) da «Sin evidencia» si ninguna búsqueda
devuelve nada. La consulta es candidata a «Evidencia suficiente» si algún fragmento final tiene la cita completa y
estaba entre los 3 primeros de alguna lista, y si supera los filtros de relevancia de `backend/app/rag/gates.py`; si no,
es «Evidencia insuficiente». El estado final se confirma después:
la respuesta de Groq debe citar los fragmentos recibidos, y si el proveedor indica que no la sustentan, el sistema se
abstiene.

**¿En qué momento se aplican los permisos documentales?** Antes de buscar. Las dos búsquedas consultan
`authorized_corpus`, que se construye con el alcance vigente de la cuenta (`backend/app/rag/retrieval_repository.py`),
de modo que un fragmento no autorizado nunca entra en la clasificación. Justo antes de llamar a Groq se vuelve a
comprobar el permiso de los fragmentos finales con una conexión nueva (`before_send` en `backend/app/rag/service.py`).
Si se revocó mientras tanto, el resultado es «Sin autorización» y no se envía nada.

**¿Qué se envía a Groq?** Solo la pregunta y, como máximo, los 5 fragmentos finales con cita completa, nunca documentos
completos. Es una sola llamada. `build_messages` (`backend/app/rag/grounded_generation.py`) arma el mensaje: las
instrucciones del sistema, la consulta y cada fragmento con su cita (documento, tipo, fecha, página, sección y cláusula),
un identificador y su texto delimitado como no confiable. Los fragmentos sin cita completa se separan antes
(`split_citable_evidence`) y no se envían; si alguno llegara a `build_messages`, la solicitud se rechaza.
`response_format` (mismo archivo) exige una salida JSON estricta con el estado, la respuesta y los identificadores de los
fragmentos que la sustentan, que solo pueden ser los enviados. `parse_grounded_output` valida esa salida: si no cumple el
contrato, cuenta como falla técnica y nunca como «Evidencia suficiente».

**¿Cómo detecta una pregunta «Fuera del alcance del asistente»?** Con un primer filtro que se aplica antes de buscar
documentos (`is_decision_request` en `backend/app/rag/gates.py`). Combina patrones de decisión dirigida al sistema con
un clasificador logístico congelado sobre el embedding de la consulta, con un umbral conservador. Su configuración está
versionada en `backend/app/rag/gates_data/` y no se reentrena en operación. Si la pregunta pide una decisión jurídica,
no se consulta el corpus ni Groq.

**¿Qué hace `conceder_alcance`?** Está en `backend/scripts/primera_instalacion.py`. Concede a los roles Jurídico, Analista
y TI el acceso a las cuatro familias documentales (contratos, litigios, cumplimiento y auditoría interna): 12
combinaciones. Lee los alcances activos y solo concede los que faltan, por eso la primera vez informa
`ALCANCE_DOCUMENTAL_CONCEDIDO: 12 nuevos` y al repetirse no duplica nada. Cada concesión pasa por el servicio normal
`set_scope_grant`: exige el permiso `document_acl.manage`, queda en la auditoría y cierra las sesiones vigentes de ese rol
para que el cambio aplique de inmediato. Por eso inicia una sesión nueva en cada concesión, ya que al conceder al rol TI
se cierra la suya. Hace falta porque el acceso documental se niega por defecto y el rol funcional no lo otorga: sin este
paso, el Visor aparece vacío y la consulta responde «Sin autorización». Con `--sin-alcance` se conserva la negación por
defecto.

**¿Por qué la cuenta del backend no puede leer la auditoría?** La base de datos usa tres identidades. El propietario
de las migraciones solo se usa para crear el esquema. El backend opera con un usuario limitado que sobre `audit.event`
y `audit.event_resource` solo tiene `INSERT`, sin `SELECT`, `UPDATE` ni `DELETE` (migraciones `0005` y `0006`). La
vista de Auditoría usa un tercer usuario que solo tiene `SELECT`, en transacciones de solo lectura con un tiempo
límite de 5 segundos (`backend/app/audit/repository.py`), y únicamente después de comprobar el permiso funcional. Así,
la condición de que la auditoría solo admita inserciones la impone PostgreSQL y no solo el código: aunque el backend
tuviera un error, no podría modificar, borrar ni leer el historial fuera de esa vista. `runtime_check` verifica este
contrato de privilegios antes de iniciar el backend, y si no coincide, el backend no arranca (comprobación `BD-02` del
verificador).

**¿Por qué un indicador muestra «No disponible» y no 0?** Porque la ausencia de datos no equivale a cero. Si no hay una
observación válida para el periodo, o la fuente no tenía cobertura en la fecha de corte, el indicador queda como
`NO_DISPONIBLE` sin valor (`backend/app/analytics/service.py`). Mostrar 0 daría una falsa tranquilidad. Los conteos
solo devuelven 0 cuando la especificación lo indica.

**¿Por qué el conflicto de identidad solo se puede descartar?** Porque llega un registro con un identificador que ya
existe, pero con datos distintos. Corregirlo y reinyectarlo sobrescribiría en silencio la información existente, así
que el servicio lo rechaza y solo admite el descarte con justificación, que queda auditado
(`backend/app/validation/service.py`).

**¿El análisis proactivo usa inteligencia artificial?** No. Son reglas deterministas en
`backend/app/analytics/proactive_rules.py`: la aparición o el aumento de contratos próximos a vencer sin revisión y de
obligaciones regulatorias vencidas sin atender, y el aumento estricto durante tres meses consecutivos de la exposición por litigios, los nuevos
litigios y los incidentes. Cada alerta conserva los valores y la regla que la produjeron, por lo que se puede
reconstruir paso a paso.

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

# PRD — Dashboard de Indicadores de Riesgo Legal

> **Documento:** Product Requirements Document (PRD)  
> **Producto:** Dashboard de Indicadores de Riesgo Legal  
> **Estado:** Propuesta de producto  
> **Propósito:** Definir la visión, alcance, usuarios, capacidades, límites y evolución esperada del producto.

---

## 1. Resumen ejecutivo

El **Dashboard de Indicadores de Riesgo Legal** es una plataforma web orientada a áreas jurídicas que busca concentrar información relevante de contratos, litigios, cumplimiento normativo, auditoría y operación legal en un mismo entorno analítico.

El producto nace de un problema común: la información jurídica suele encontrarse distribuida entre archivos, documentos, expedientes y registros operativos que no siempre pueden consultarse de forma integrada. Esto dificulta identificar riesgos oportunamente, seguir tendencias, revisar evidencia documental y obtener una visión ejecutiva del estado legal de una organización.

La propuesta consiste en construir una plataforma capaz de:

- incorporar información jurídica desde fuentes controladas;
- validar su calidad antes de utilizarla;
- procesar documentos jurídicos;
- calcular indicadores;
- detectar señales y tendencias;
- permitir consultas sobre documentos mediante lenguaje natural;
- presentar respuestas sustentadas en evidencia;
- restringir el acceso según permisos;
- conservar trazabilidad sobre operaciones relevantes.

El producto tendrá un carácter **analítico y de apoyo**. No pretende sustituir el criterio profesional de abogados, responsables de cumplimiento o directivos.

---

## 2. Problema que se busca resolver

Las áreas jurídicas pueden enfrentar varios problemas simultáneos:

- información contractual dispersa;
- expedientes de litigio almacenados en distintas fuentes;
- obligaciones regulatorias sin una vista consolidada;
- dificultad para identificar vencimientos o riesgos próximos;
- ausencia de indicadores comparables entre periodos;
- revisión manual de documentos para responder preguntas frecuentes;
- baja trazabilidad sobre quién consultó o modificó información;
- documentos escaneados cuyo contenido no puede buscarse directamente;
- dificultad para diferenciar entre información válida, incompleta o errónea;
- poca visibilidad ejecutiva de riesgos emergentes.

El producto busca reducir esa fragmentación y transformar información jurídica heterogénea en una base útil para análisis, consulta y seguimiento.

---

## 3. Visión del producto

Construir una plataforma analítica jurídica que permita convertir datos y documentos dispersos en:

- indicadores comprensibles;
- señales de riesgo;
- tendencias;
- evidencia documental consultable;
- información ejecutiva;
- trazabilidad operativa.

La visión de largo plazo es que el producto pueda adaptarse a distintas organizaciones sin depender de la estructura particular de una sola empresa.

---

## 4. Propuesta de valor

### 4.1 Visibilidad

Concentrar en una sola interfaz la información más relevante sobre riesgo contractual, litigios, cumplimiento y operación jurídica.

### 4.2 Detección temprana

Permitir identificar cambios, recurrencias y señales de riesgo antes de que pasen desapercibidos.

### 4.3 Consulta documental

Reducir el tiempo necesario para localizar información dentro de documentos jurídicos mediante búsqueda semántica y consultas en lenguaje natural.

### 4.4 Respuestas sustentadas

Evitar respuestas sin respaldo. Cuando el sistema genere una respuesta, esta deberá poder relacionarse con evidencia documental concreta.

### 4.5 Calidad de datos

Impedir que información incompleta, inválida o incompatible contamine silenciosamente los análisis.

### 4.6 Seguridad

Restringir la información según el perfil del usuario y los documentos que tenga autorizados.

### 4.7 Trazabilidad

Registrar acciones relevantes para facilitar revisión, soporte, seguimiento y auditoría.

---

## 5. Usuarios objetivo

### 5.1 Personal jurídico

Incluye abogados, responsables jurídicos y perfiles ejecutivos que requieren información consolidada.

**Necesidades:**

- consultar indicadores;
- identificar riesgos;
- revisar tendencias;
- buscar información dentro de documentos;
- revisar evidencia;
- obtener una visión ejecutiva sin conocer detalles técnicos.

### 5.2 Analistas y personal de cumplimiento

Usuarios responsables de cargar, validar y mantener información.

**Necesidades:**

- incorporar archivos;
- revisar errores;
- gestionar registros rechazados;
- supervisar procesamiento documental;
- mantener la calidad de las fuentes.

### 5.3 Personal de TI

Usuarios responsables de administración técnica.

**Necesidades:**

- administrar cuentas y permisos;
- revisar eventos de auditoría;
- monitorear procesamiento;
- diagnosticar errores;
- mantener la configuración técnica del sistema.

---

## 6. Principios de producto

### 6.1 El sistema apoya, no decide

El producto puede detectar riesgos y presentar evidencia, pero no debe emitir decisiones jurídicas vinculantes.

### 6.2 La evidencia tiene prioridad sobre la fluidez

Es preferible informar que no existe evidencia suficiente antes que generar una respuesta convincente pero no sustentada.

### 6.3 La autorización tiene prioridad sobre la relevancia

Un documento no debe utilizarse como evidencia si el usuario no tiene autorización para acceder a él.

### 6.4 Un dato faltante no equivale a cero

El sistema debe diferenciar entre ausencia de información y un resultado numérico igual a cero.

### 6.5 La interfaz debe hablar el lenguaje del usuario

Los conceptos técnicos internos no deben dominar la experiencia de uso.

### 6.6 La trazabilidad forma parte del producto

La seguridad, los accesos y las operaciones relevantes deben quedar registradas.

---

## 7. Alcance general del producto

El producto contempla las siguientes grandes capacidades.

### 7.1 Ingesta de información

Recepción de archivos estructurados y documentales mediante mecanismos controlados.

Formatos inicialmente considerados:

- CSV;
- XLSX;
- PDF;
- DOCX.

### 7.2 Validación de datos

Antes de utilizar la información, el producto debe poder validar:

- estructura;
- campos obligatorios;
- tipos de datos;
- reglas de dominio;
- consistencia básica.

### 7.3 Cuarentena

La información que no supere validaciones debe aislarse para evitar que afecte el análisis.

El usuario autorizado debe poder:

- consultar el error;
- revisar el contenido;
- corregir;
- reinyectar;
- descartar justificadamente.

### 7.4 Procesamiento documental

Los documentos deben poder transformarse en texto utilizable para búsqueda y análisis.

### 7.5 OCR

Los PDF escaneados deben poder procesarse mediante reconocimiento óptico de caracteres cuando no contengan texto digital utilizable.

### 7.6 Indicadores jurídicos

El sistema debe calcular indicadores agrupados en dominios como:

- riesgo contractual;
- litigios;
- cumplimiento normativo;
- eficiencia operativa jurídica;
- calidad documental.

### 7.7 Análisis de tendencias y riesgos emergentes

El sistema debe poder detectar:

- cambios relevantes;
- incrementos;
- recurrencia;
- tendencias;
- señales derivadas de indicadores.

### 7.8 Consulta documental asistida

Los usuarios deben poder formular preguntas en lenguaje natural sobre los documentos a los que tengan acceso.

### 7.9 Respuestas con evidencia

Cuando exista soporte suficiente, el sistema podrá generar una respuesta sustentada en documentos y fragmentos concretos.

### 7.10 Visor documental

Los usuarios autorizados deben poder consultar documentos y revisar el contexto de las evidencias.

### 7.11 Dashboard ejecutivo

La interfaz debe presentar de forma clara:

- indicadores;
- tendencias;
- alertas;
- exposición;
- resultados de análisis;
- información documental relevante.

### 7.12 Seguridad

El producto debe contemplar:

- autenticación;
- permisos;
- roles;
- autorización documental;
- mínimo privilegio.

### 7.13 Auditoría

Las acciones sensibles deben dejar registro suficiente para trazabilidad.

---

## 8. Familias de información previstas

El producto se diseñará inicialmente alrededor de cuatro familias.

### Contratos

Información asociada con:

- fechas;
- estados;
- vencimientos;
- revisiones;
- documentos contractuales;
- cláusulas;
- datos operativos.

### Litigios

Información como:

- expedientes;
- estado;
- monto reclamado;
- exposición estimada;
- severidad;
- fechas de apertura y cierre.

### Cumplimiento normativo

Información como:

- obligaciones;
- fechas límite;
- evidencias;
- estados;
- incidentes;
- severidad.

### Auditoría interna

Información relacionada con:

- hallazgos;
- revisiones;
- informes;
- observaciones;
- riesgos detectados.

---

## 9. Indicadores considerados para el producto

El producto podrá crecer alrededor de un catálogo amplio de indicadores.

### 9.1 Riesgo contractual

Posibles indicadores:

- tiempo de ciclo del contrato;
- contratos próximos a vencimiento sin revisión;
- tasa de desviación de cláusulas estándar;
- concentración contractual;
- volumen de contratos gestionados.

### 9.2 Litigios

Posibles indicadores:

- exposición total por litigios activos;
- nuevos litigios por periodo;
- tasa de resolución favorable;
- tiempo promedio de resolución;
- costo promedio por litigio.

### 9.3 Cumplimiento normativo

Posibles indicadores:

- obligaciones vencidas sin atender;
- incidentes de incumplimiento por periodo;
- tasa de cumplimiento de obligaciones;
- cobertura de auditorías internas.

### 9.4 Eficiencia operativa jurídica

Posibles indicadores:

- volumen de asuntos gestionados;
- tiempo promedio de respuesta;
- proporción entre asuntos reactivos y preventivos.

### 9.5 Calidad documental y de datos

Posibles indicadores:

- tasa de éxito OCR;
- tasa de rechazo durante validación;
- documentos pendientes de digitalización.

No todos estos indicadores deben formar parte de la primera versión.

---

## 10. Experiencia esperada

### 10.1 Resumen ejecutivo

Debe responder rápidamente:

- ¿qué requiere atención?;
- ¿qué riesgos son más importantes?;
- ¿qué cambió?;
- ¿dónde se concentra el riesgo?;
- ¿qué información no está disponible?

### 10.2 Riesgo contractual

Debe ayudar a identificar:

- vencimientos próximos;
- contratos sin revisión;
- cambios en tiempos de ciclo;
- concentraciones o desviaciones cuando existan datos suficientes.

### 10.3 Litigios

Debe permitir entender:

- exposición económica;
- severidad;
- evolución;
- nuevos asuntos;
- concentración.

### 10.4 Cumplimiento

Debe permitir observar:

- obligaciones vencidas;
- incidentes;
- áreas afectadas;
- severidad;
- comportamiento a lo largo del tiempo.

### 10.5 Consulta documental

Debe sentirse como una herramienta especializada de búsqueda documental asistida, no como un chatbot de propósito general.

### 10.6 Ingesta y cuarentena

Debe ser evidente para el usuario si un archivo:

- fue recibido;
- está siendo procesado;
- fue aceptado;
- contiene errores;
- requiere corrección;
- fue descartado.

---

## 11. Qué NO hará el producto

El producto no debe presentarse como algo que no es.

No pretende:

- sustituir abogados;
- emitir asesoría jurídica autónoma;
- decidir si una organización debe demandar, negociar, sancionar o aceptar un riesgo;
- predecir automáticamente resultados judiciales;
- garantizar cumplimiento normativo;
- certificar cumplimiento legal;
- actuar como autoridad jurídica;
- inventar evidencia inexistente;
- responder sobre documentos no autorizados;
- tomar decisiones vinculantes;
- modificar sistemas externos sin control;
- convertirse en un sistema ERP;
- convertirse en un gestor integral de expedientes;
- convertirse en una suite documental empresarial completa;
- convertirse en una plataforma corporativa de identidad;
- ofrecer capacidades móviles nativas en la primera etapa;
- admitir cualquier formato de archivo sin definición previa;
- procesar manuscritos como capacidad inicial;
- entrenar un modelo de lenguaje propio;
- depender de fine-tuning para incorporar documentos nuevos;
- garantizar alta disponibilidad empresarial en su primera etapa.

---

## 12. Límites de producto

### Datos

La calidad de los resultados depende de la calidad de las fuentes.

### Metadatos

Una respuesta puede quedar limitada si los documentos carecen de información necesaria para citar correctamente.

### Modelos generativos

La generación de lenguaje puede verse afectada por disponibilidad, límites y comportamiento del proveedor.

### OCR

El OCR inicial se orientará a texto impreso, no manuscrito.

### Escalabilidad

La primera versión debe demostrar viabilidad, no operación empresarial a escala ilimitada.

### Seguridad

La primera etapa debe resolver autenticación, permisos y acceso documental, pero no necesariamente todas las capacidades de una plataforma IAM empresarial.

---

## 13. Restricciones iniciales

El proyecto parte de restricciones importantes:

- tiempo limitado de desarrollo;
- preferencia por tecnologías de código abierto;
- uso controlado de servicios externos;
- operación en infraestructura moderada;
- necesidad de preservar privacidad;
- necesidad de minimizar el contenido enviado a servicios externos;
- necesidad de conservar trazabilidad;
- necesidad de soportar información estructurada y documental.

---

## 14. Riesgos de producto

### 14.1 Datos insuficientes

El valor de indicadores y análisis puede disminuir si las fuentes no tienen cobertura suficiente.

### 14.2 Datos inconsistentes

Una mala calidad de origen puede producir resultados incorrectos si no se valida adecuadamente.

### 14.3 Exceso de automatización

El usuario podría interpretar una señal como una recomendación jurídica si la interfaz no diferencia ambos conceptos.

### 14.4 Respuestas no sustentadas

Un componente generativo podría producir una respuesta plausible sin evidencia si no se controla correctamente.

### 14.5 Exposición de información

Una autorización documental incorrecta puede revelar información sensible.

### 14.6 Dependencia externa

El proveedor generativo puede presentar indisponibilidad o límites.

### 14.7 Crecimiento descontrolado del alcance

Añadir continuamente indicadores, conectores y funciones administrativas puede desviar el producto de su objetivo principal.

---

## 15. Producto mínimo viable previsto

La primera versión viable deberá demostrar la cadena completa:

**ingesta → validación → procesamiento → indicadores → señales → consulta documental → evidencia → seguridad → auditoría**

El detalle de esa primera versión se define en `MVP.md`.

---

## 16. Funcionalidades futuras posibles

Las siguientes capacidades se consideran posibilidades de evolución y no compromisos de la primera versión.

### Integraciones

- conectores con sistemas de gestión contractual;
- conectores con sistemas de litigios;
- conectores con herramientas de cumplimiento;
- conexión directa con bases de datos;
- integración con almacenamiento empresarial;
- APIs de intercambio bidireccional.

### Seguridad empresarial

- SSO;
- MFA;
- OAuth/OIDC;
- federación de identidades;
- Active Directory;
- integración con IAM corporativo;
- políticas avanzadas de sesión.

### Inteligencia documental

- clasificación automática de documentos;
- extracción estructurada de cláusulas;
- comparación entre versiones;
- detección de desviaciones respecto de plantillas;
- extracción de obligaciones;
- detección de entidades;
- mapas de relaciones documentales.

### Analítica avanzada

- nuevos indicadores;
- benchmarking interno;
- segmentación por unidad de negocio;
- análisis comparativo entre entidades;
- detección estadística de anomalías;
- modelos de forecasting;
- predicción de riesgo, siempre que exista una definición metodológica formal.

### Colaboración

- asignación de responsables;
- comentarios sobre hallazgos;
- flujos de revisión;
- estados de seguimiento;
- tareas derivadas de alertas.

### Notificaciones

- alertas por correo;
- alertas dentro de la aplicación;
- suscripciones a indicadores;
- notificaciones configurables por severidad.

### Reportes

- reportes ejecutivos programados;
- exportación controlada;
- reportes periódicos;
- paquetes de evidencia.

### Infraestructura

- alta disponibilidad;
- balanceo;
- recuperación ante desastres;
- réplica de base de datos;
- despliegue multinodo;
- escalamiento horizontal.

### Modelos e IA

- múltiples proveedores;
- fallback de proveedor;
- inferencia local;
- evaluación automática de calidad;
- herramientas de gobierno de prompts;
- fine-tuning, únicamente si existe una justificación futura clara.

### Experiencia

- aplicación móvil;
- experiencia multiorganización;
- personalización de dashboards;
- vistas por función;
- panel especializado de cumplimiento;
- panel de calidad de datos;
- flujos de onboarding.

### OCR y documentos

- OCR manuscrito;
- reconocimiento de tablas complejas;
- clasificación visual;
- documentos adicionales;
- extracción de firmas o sellos, si existe justificación y viabilidad.

---

## 17. Criterios de éxito de producto

El producto será considerado valioso si consigue demostrar que:

- un usuario jurídico puede identificar riesgos sin revisar manualmente todas las fuentes;
- un analista puede incorporar información y detectar problemas de calidad;
- un usuario puede realizar consultas documentales y revisar evidencia;
- el sistema puede abstenerse cuando no dispone de información suficiente;
- un usuario no puede acceder a documentos sin autorización;
- los indicadores representan correctamente los datos disponibles;
- el análisis proactivo aporta señales comprensibles;
- las acciones sensibles pueden auditarse;
- la solución puede adaptarse a más fuentes y capacidades en etapas posteriores.

---

## 18. Supuestos

Se asume que:

- las organizaciones pueden proporcionar información en formatos controlados;
- las fuentes contienen suficiente información para calcular al menos un conjunto inicial de indicadores;
- los responsables jurídicos validarán la utilidad de los indicadores;
- la organización definirá qué usuarios pueden acceder a cada tipo de información;
- los documentos pueden requerir OCR;
- el modelo generativo no será tratado como fuente de verdad;
- las respuestas deben depender de evidencia recuperada;
- futuras integraciones requerirán trabajo adicional;
- no toda funcionalidad deseable debe formar parte de la primera versión.

---

## 19. Roadmap conceptual

### Etapa 1 — MVP

Demostrar la cadena principal de valor.

### Etapa 2 — Consolidación

Mejorar usabilidad, cobertura de datos, calidad visual, reportes y operación.

### Etapa 3 — Integraciones

Conectar fuentes empresariales y automatizar intercambios.

### Etapa 4 — Inteligencia avanzada

Incorporar análisis documental, automatización adicional y nuevas métricas.

### Etapa 5 — Escala empresarial

Incorporar alta disponibilidad, IAM empresarial, multiorganización y gobierno avanzado.

---

## 20. Resumen

El Dashboard de Indicadores de Riesgo Legal busca convertir información jurídica dispersa en una experiencia unificada de análisis, búsqueda y trazabilidad.

Su propósito no es automatizar el juicio jurídico, sino mejorar la capacidad humana de:

- observar;
- encontrar;
- comparar;
- entender;
- priorizar;
- verificar.

La primera versión debe ser suficientemente pequeña para ser viable, pero suficientemente completa para demostrar valor real.

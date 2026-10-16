# MVP — Dashboard de Indicadores de Riesgo Legal

> **Documento:** Definición del Producto Mínimo Viable  
> **Producto:** Dashboard de Indicadores de Riesgo Legal  
> **Estado:** Propuesta de alcance inicial  
> **Objetivo:** Definir la versión mínima del producto que aporta valor real y permite validar su viabilidad.

---

## 1. Propósito

Este documento define la primera versión funcional del **Dashboard de Indicadores de Riesgo Legal**.

El objetivo no es construir desde el inicio todas las capacidades imaginables del producto, sino identificar el conjunto mínimo que permita demostrar que la propuesta aporta valor.

El MVP debe ser lo suficientemente pequeño para poder desarrollarse en un tiempo limitado, pero lo suficientemente completo para permitir una experiencia real de extremo a extremo.

---

## 2. Qué significa MVP para este producto

Para este proyecto, el MVP no será una maqueta, un prototipo visual ni una colección de módulos aislados.

Debe existir una cadena funcional completa:

> **incorporar información → validar → procesar → calcular indicadores → detectar señales → consultar documentos → revisar evidencia → aplicar seguridad → conservar trazabilidad**

Si solo existiera el dashboard, faltaría la capacidad de incorporar y validar información.

Si solo existiera la búsqueda documental, faltaría la visión analítica.

Si no existiera control de acceso, el producto no sería viable para información jurídica sensible.

Si no existiera evidencia, la generación de respuestas perdería confiabilidad.

El MVP, por tanto, debe demostrar la propuesta de valor completa en una escala acotada.

---

## 3. Hipótesis que se busca validar

La primera versión debe demostrar que una plataforma web puede ayudar a un área jurídica a:

1. consolidar información procedente de varias fuentes;
2. controlar la calidad de los datos;
3. procesar documentos jurídicos;
4. calcular indicadores útiles;
5. identificar señales de riesgo;
6. buscar información dentro de un corpus documental;
7. generar respuestas sustentadas en evidencia;
8. restringir información conforme a permisos;
9. conservar trazabilidad de operaciones.

---

## 4. Usuarios incluidos

### 4.1 Jurídico

Debe poder:

- iniciar sesión;
- consultar indicadores;
- revisar señales;
- navegar el dashboard;
- consultar documentos;
- formular preguntas;
- revisar citas y evidencia;
- abrir documentos autorizados.

### 4.2 Analista

Debe poder:

- realizar las acciones del perfil jurídico;
- cargar información;
- ejecutar procesos de ingesta;
- revisar errores;
- gestionar cuarentena;
- consultar procesamiento OCR;
- solicitar reprocesamiento cuando corresponda.

### 4.3 TI

Debe poder:

- realizar las funciones anteriores;
- consultar auditoría completa;
- administrar cuentas;
- administrar roles;
- administrar autorizaciones documentales;
- revisar configuración técnica permitida.

---

## 5. Fuentes incluidas

El MVP trabajará con cuatro familias principales.

### Contratos

Datos y documentos relacionados con contratos.

### Litigios

Registros estructurados de expedientes y exposición.

### Cumplimiento normativo

Obligaciones, fechas límite, evidencias e incidentes.

### Auditoría interna

Informes y datos relacionados con hallazgos internos.

---

## 6. Formatos incluidos

El MVP debe aceptar:

- CSV;
- XLSX;
- PDF;
- DOCX.

No se requiere soportar un catálogo abierto de formatos.

---

## 7. Flujo mínimo de ingesta

El sistema debe poder:

1. recibir un archivo;
2. identificar su formato;
3. asociarlo con una familia;
4. extraer su contenido;
5. validar su estructura;
6. validar campos y reglas;
7. almacenar los datos válidos;
8. separar los datos inválidos;
9. registrar el resultado.

---

## 8. Validación y cuarentena

La primera versión debe impedir que un registro inválido sea tratado como información confiable.

La cuarentena debe permitir:

- consultar elementos rechazados;
- entender la causa;
- corregir información;
- reinyectar;
- descartar;
- registrar quién realizó la acción.

---

## 9. Procesamiento documental

### 9.1 Documentos digitales

PDF y DOCX con texto utilizable deben poder extraerse y prepararse para búsqueda.

### 9.2 Documentos escaneados

Los PDF que no contengan texto digital deben poder procesarse mediante OCR.

### 9.3 Confianza

El resultado OCR debe conservar una medida de confianza.

### 9.4 Límite

No se requiere OCR manuscrito.

---

## 10. Indicadores mínimos

El MVP debe incluir un conjunto pequeño de indicadores que demuestre valor en varios dominios.

### 10.1 Riesgo contractual

#### Contratos próximos a vencimiento sin revisión

Debe permitir identificar contratos que:

- vencen dentro de un horizonte próximo;
- todavía no tienen revisión iniciada.

Este indicador representa un riesgo directamente accionable.

#### Tiempo de ciclo del contrato

Debe permitir observar cuánto tiempo transcurre, en promedio, desde la solicitud hasta la firma.

Se utilizará como indicador de contexto operativo.

---

## 11. Litigios

### Exposición total por litigios activos

Debe mostrar la exposición económica asociada con litigios activos y permitir distinguir niveles de severidad.

### Nuevos litigios por periodo

Debe permitir observar cuántos litigios se abren a lo largo del tiempo.

---

## 12. Cumplimiento normativo

### Obligaciones vencidas sin atender

Debe identificar obligaciones cuyo plazo terminó sin evidencia de cumplimiento.

### Incidentes de incumplimiento por periodo

Debe permitir observar incidentes:

- por periodo;
- por área;
- por severidad.

---

## 13. Eficiencia operativa

### Volumen de asuntos jurídicos gestionados

Debe proporcionar una referencia sobre la carga de trabajo del área jurídica.

Su finalidad es aportar contexto a los indicadores de riesgo.

---

## 14. Calidad documental

### Tasa de éxito OCR

Debe permitir a TI observar qué proporción de documentos procesados mediante OCR alcanza el nivel mínimo de confianza definido.

No será un indicador ejecutivo de riesgo.

---

## 15. Análisis proactivo

El MVP debe analizar periódicamente los indicadores disponibles.

Debe poder detectar:

- aparición de una señal;
- incremento;
- variación;
- tendencia;
- recurrencia.

El resultado debe presentarse como una señal de apoyo.

El análisis no debe:

- emitir asesoría jurídica;
- predecir resultados judiciales;
- recomendar automáticamente una acción jurídica;
- tomar decisiones.

---

## 16. Consulta documental

El usuario debe poder escribir una pregunta en lenguaje natural.

El sistema debe:

1. verificar la identidad;
2. determinar a qué documentos tiene acceso;
3. buscar información relevante;
4. recuperar fragmentos;
5. evaluar si existe evidencia suficiente;
6. generar una respuesta únicamente cuando exista soporte;
7. mostrar la evidencia utilizada.

---

## 17. Estados mínimos de consulta

### Evidencia suficiente

Existe soporte suficiente para responder.

El usuario debe recibir:

- respuesta;
- citas;
- fuentes.

### Evidencia insuficiente

Existe información relacionada, pero no alcanza para responder con suficiente fundamento.

El usuario debe recibir:

- una explicación;
- las referencias disponibles cuando tengan utilidad;
- ninguna afirmación no sustentada.

### Sin evidencia

No se encuentra material suficiente o relevante.

El usuario debe recibir una respuesta clara indicando esa situación.

### Sin autorización

Existe una restricción de acceso.

El sistema no debe revelar información sobre documentos no autorizados.

---

## 18. Evidencia mínima

Cuando una respuesta utilice evidencia, el usuario debe poder reconocer al menos:

- documento;
- tipo;
- fecha;
- ubicación o página cuando aplique;
- fragmento utilizado.

La evidencia debe ser verificable desde la interfaz.

---

## 19. Seguridad mínima

El MVP debe tener:

- autenticación;
- sesiones;
- roles;
- permisos;
- autorización documental;
- denegación por defecto.

La interfaz no será la única barrera de seguridad. El backend deberá validar cada operación protegida.

---

## 20. Roles mínimos

### Jurídico

Acceso a:

- dashboard;
- indicadores;
- búsqueda documental;
- documentos autorizados.

### Analista

Incluye Jurídico más:

- ingesta;
- cuarentena;
- OCR;
- acciones operativas autorizadas.

### TI

Incluye Analista más:

- administración;
- permisos;
- auditoría completa;
- configuración técnica.

---

## 21. Auditoría mínima

El MVP debe registrar las operaciones relevantes sobre información protegida.

Debe ser posible identificar:

- quién;
- qué hizo;
- sobre qué recurso;
- cuándo;
- con qué resultado.

No se deben utilizar los logs como almacenamiento de contenido sensible.

---

## 22. Dashboard mínimo

La interfaz ejecutiva debe presentar:

- indicadores principales;
- periodos;
- tendencias cuando exista historia suficiente;
- señales;
- estados de disponibilidad;
- filtros;
- acceso a detalles.

Debe distinguir claramente:

- cero;
- sin datos;
- no disponible;
- error.

---

## 23. Vistas mínimas

El MVP debe ofrecer, como mínimo, superficies para:

- Resumen ejecutivo;
- Riesgo contractual;
- Gestión de litigios;
- Tendencias y riesgos;
- Consulta documental;
- Visor documental;
- Ingesta;
- Cuarentena;
- Auditoría;
- Administración.

El acceso a cada vista dependerá del perfil.

---

## 24. Flujos que deben demostrarse

### Flujo A — Carga válida

**archivo → validación → almacenamiento → indicador**

### Flujo B — Registro inválido

**archivo → rechazo → cuarentena → corrección → reinyección**

### Flujo C — Documento escaneado

**PDF → OCR → texto → fragmentación → búsqueda**

### Flujo D — Indicador

**datos → cálculo → visualización**

### Flujo E — Señal

**histórico → análisis → hallazgo**

### Flujo F — Consulta con evidencia

**pregunta → búsqueda → respuesta → cita**

### Flujo G — Consulta sin evidencia

**pregunta → búsqueda → insuficiencia → respuesta conservadora**

### Flujo H — Acceso restringido

**usuario → solicitud → autorización → denegación segura**

### Flujo I — Auditoría

**acción → registro → consulta posterior**

---

## 25. Experiencia mínima esperada

### Resumen ejecutivo

Debe permitir entender rápidamente:

- qué indicadores son relevantes;
- qué requiere atención;
- cuál es el periodo;
- qué información falta.

### Contratos

Debe permitir identificar riesgo próximo de vencimiento y contexto operativo.

### Litigios

Debe permitir entender exposición y evolución.

### Cumplimiento

Debe permitir observar obligaciones e incidentes.

### Consulta documental

Debe permitir formular preguntas sin conocer sintaxis técnica.

### Cuarentena

Debe permitir entender qué salió mal y qué puede hacer el usuario.

---

## 26. Qué no se incluye en el MVP

Quedan fuera de esta primera versión:

- aplicación móvil nativa;
- integración directa con un número abierto de sistemas;
- conectores propietarios específicos;
- SSO;
- MFA;
- federación de identidades;
- Active Directory;
- IAM corporativo;
- alta disponibilidad multinodo;
- recuperación ante desastres empresarial;
- balanceo multinodo;
- proveedor alternativo obligatorio;
- inferencia local obligatoria;
- fine-tuning;
- entrenamiento de un modelo propio;
- OCR manuscrito;
- asesoría jurídica autónoma;
- decisiones jurídicas automáticas;
- predicción judicial;
- catálogo completo de indicadores futuros;
- gestión integral de expedientes;
- firma electrónica;
- colaboración avanzada;
- notificaciones configurables;
- reportes ejecutivos programados.

---

## 27. Funcionalidades futuras que no bloquean el MVP

Pueden evaluarse después:

### Indicadores adicionales

- desviación de cláusulas estándar;
- concentración contractual;
- contratos gestionados;
- tasa de resolución favorable;
- tiempo de resolución;
- costo por litigio;
- tasa de cumplimiento;
- cobertura de auditorías;
- tiempo de respuesta;
- reactivo vs preventivo;
- tasa de rechazo;
- pendientes de digitalización.

### Integraciones

- sistemas de contratos;
- sistemas de litigios;
- herramientas de compliance;
- ERP;
- almacenamiento documental;
- APIs empresariales.

### IA documental

- extracción de cláusulas;
- comparación de documentos;
- clasificación automática;
- detección de obligaciones;
- análisis de desviaciones.

### Experiencia

- notificaciones;
- reportes;
- dashboards configurables;
- colaboración;
- tareas;
- app móvil.

---

## 28. Criterios de viabilidad

El MVP será viable si demuestra que:

- puede incorporar datos;
- puede detectar errores;
- puede procesar documentos;
- puede calcular indicadores;
- puede identificar señales;
- puede buscar documentos;
- puede responder con evidencia;
- puede abstenerse si no hay suficiente información;
- puede restringir acceso;
- puede auditar operaciones;
- puede presentar todo ello mediante una interfaz utilizable.

---

## 29. Criterios de aceptación del MVP

La primera versión podrá considerarse completa cuando se demuestre que:

1. los formatos definidos pueden procesarse;
2. la información válida puede incorporarse;
3. la información inválida no contamina silenciosamente el análisis;
4. la cuarentena puede gestionarse;
5. el OCR puede procesar documentos escaneados dentro del alcance;
6. los indicadores mínimos producen resultados consistentes;
7. las señales pueden generarse a partir de información histórica;
8. las consultas documentales aplican autorización;
9. las respuestas sustentadas incluyen evidencia;
10. las consultas sin evidencia no producen afirmaciones inventadas;
11. los roles limitan funciones;
12. los documentos restringidos no se revelan;
13. las acciones críticas quedan auditadas;
14. la aplicación puede recorrerse de extremo a extremo.

---

## 30. Restricciones del MVP

### Tiempo

La primera versión debe poder desarrollarse dentro de un proyecto de alcance acotado.

### Recursos

La solución debe funcionar en infraestructura moderada y evitar dependencias innecesarias.

### Datos

Debe poder validarse con información:

- sintética;
- simulada;
- anonimizada;
- de ejemplo.

No debe requerir acceso a datos productivos reales para demostrar funcionamiento.

### Servicios externos

La generación asistida puede depender de un proveedor externo, por lo que deben contemplarse fallos y límites.

---

## 31. Qué pretende demostrar el MVP

El MVP pretende demostrar que la combinación de:

**datos + indicadores + análisis + documentos + evidencia + seguridad**

puede aportar valor real a un área jurídica.

---

## 32. Qué no pretende demostrar

No pretende demostrar:

- escalabilidad ilimitada;
- product-market fit definitivo;
- cumplimiento legal automático;
- sustitución del abogado;
- predicción legal;
- autonomía jurídica;
- integración con todo el ecosistema empresarial;
- operación corporativa de alta disponibilidad;
- precisión universal de modelos generativos.

---

## 33. Resultado esperado

Al terminar el MVP debe ser posible mostrar una historia completa:

1. se incorpora información;
2. el sistema valida;
3. los errores se aíslan;
4. los datos válidos alimentan indicadores;
5. se detectan señales;
6. el usuario consulta documentos;
7. el sistema recupera evidencia autorizada;
8. se genera una respuesta cuando es posible;
9. el usuario revisa la fuente;
10. la actividad queda auditada.

Ese flujo constituye el valor mínimo viable del producto.

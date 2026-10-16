// Rótulos de presentación para valores internos del contrato (DESIGN §16.3). Un valor no catalogado se
// devuelve tal como llegó: nunca se inventa una etiqueta.
const label = (map) => (value) => (value !== null && value !== undefined && Object.hasOwn(map, value) ? map[value] : value)

export const FAMILY_LABELS = Object.freeze({
  CONTRATOS_DOCUMENTOS: 'Contratos y documentos', LITIGIOS: 'Litigios',
  CUMPLIMIENTO: 'Cumplimiento', AUDITORIA_INTERNA: 'Auditoría interna',
})
export const familyLabel = label(FAMILY_LABELS)

export const ROLE_LABELS = Object.freeze({ JURIDICO: 'Jurídico', ANALISTA: 'Analista', TI: 'TI' })
export const roleLabel = label(ROLE_LABELS)

// Mismo texto que la descripción segura del servidor (validation/api.py), necesario para los filtros
// antes de recibir datos.
export const QUARANTINE_CAUSE_LABELS = Object.freeze({
  MISSING_REQUIRED_FIELD: 'Falta un campo obligatorio', INVALID_TYPE: 'Tipo de dato no válido',
  INVALID_DATE: 'Fecha no válida', OUT_OF_CATALOG: 'Valor fuera del catálogo', NEGATIVE_AMOUNT: 'Importe negativo',
  DATE_ORDER_VIOLATION: 'Orden de fechas no válido', STRUCTURAL_INCONSISTENCY: 'Estructura inconsistente',
  IDENTITY_CONFLICT: 'Conflicto de identidad', TECHNICAL_READ_FAILURE: 'Fallo técnico de lectura',
  OTHER_CAUSE: 'Otra causa de rechazo', FORMAT_MISMATCH: 'El formato detectado no coincide con la extensión declarada',
  ARCHIVE_LIMIT_EXCEEDED: 'El contenedor supera los límites de tamaño o entradas',
  ARCHIVE_COMPRESSION_RATIO_EXCEEDED: 'El contenedor supera el límite de compresión',
  CORRUPT_ARCHIVE: 'El contenedor está corrupto o no puede leerse', BINARY_CONTENT: 'El archivo tabular contiene datos binarios',
  UNSUPPORTED_ENCODING: 'La codificación del archivo no está admitida',
  UNDETERMINABLE_STRUCTURE: 'No puede determinarse una estructura tabular consistente',
  AMBIGUOUS_DELIMITER: 'El separador de campos es ambiguo', PROTECTED_PDF: 'El PDF está protegido y no puede leerse',
  CORRUPT_PDF: 'La estructura del PDF está corrupta', UNSUPPORTED_FORMAT: 'El contenido no corresponde a un formato admitido',
  TABULAR_LIMIT_EXCEEDED: 'El contenido tabular supera los límites de filas, columnas o celdas',
  PROTECTED_DOCUMENT: 'El documento está protegido y no puede extraerse', EMPTY_DOCUMENT: 'El documento no contiene contenido extraíble',
  TECHNICAL_FAILURE: 'Fallo técnico de procesamiento',
})
export const quarantineCauseLabel = label(QUARANTINE_CAUSE_LABELS)

export const PROCESSING_STATE_LABELS = Object.freeze({
  PENDIENTE: 'Pendiente', PROCESANDO: 'En procesamiento', LISTA: 'Listo', RECHAZADA: 'Rechazado', FALLIDA: 'Fallido',
})
export const processingStateLabel = label(PROCESSING_STATE_LABELS)

export const AUDIT_ACTION_LABELS = Object.freeze({
  AUTH_LOGIN: 'Inicio de sesión', AUTH_LOGOUT: 'Cierre de sesión', AUTH_REFRESH: 'Renovación de sesión',
  AUTH_TOKEN_VALIDATION: 'Validación de acceso', AUTH_SESSION_VALIDATION: 'Validación de sesión',
  SESSION_INVALIDATION: 'Invalidación de sesiones', AUTHORIZATION_DENIED: 'Acceso denegado',
  ACCOUNT_CREATE: 'Creación de cuenta', ACCOUNT_UPDATE: 'Edición de cuenta', ACCOUNT_ACTIVATE: 'Activación de cuenta',
  ACCOUNT_DISABLE: 'Deshabilitación de cuenta', ACCOUNT_RESET_ACCESS: 'Restablecimiento de acceso',
  ROLE_ASSIGNMENT: 'Asignación de roles', DOCUMENT_SCOPE_GRANT: 'Alcance documental por familia',
  DOCUMENT_EXCEPTION: 'Excepción documental', DOCUMENT_VIEW: 'Apertura de documento', DOCUMENT_PRINT: 'Impresión de documento', DOCUMENT_DENIED: 'Documento denegado',
  DOCUMENT_INVALIDATED: 'Invalidación de documento', DOCUMENT_VERSION_ACTIVATED: 'Activación de versión documental',
  INGESTION_COMPLETED: 'Recepción de archivo', INGESTION_DENIED: 'Recepción denegada',
  AUTOMATIC_INGESTION: 'Ingesta automática', AUTOMATIC_OCR: 'OCR automático',
  VALIDATION_FILE_REJECTED: 'Archivo rechazado en validación', VALIDATION_DENIED: 'Validación denegada',
  QUARANTINE_CREATED: 'Registro enviado a cuarentena', QUARANTINE_VIEW: 'Consulta de cuarentena',
  QUARANTINE_REINJECT: 'Reinyección de registro', QUARANTINE_DISCARD: 'Descarte de registro',
  KPI_RECALCULATION: 'Recálculo de indicadores', PROACTIVE_ANALYSIS: 'Análisis proactivo',
  COORDINATION_DENIED: 'Coordinación denegada', SECURITY_BOOTSTRAP: 'Inicialización de seguridad',
  RAG_QUERY: 'Consulta documental',
})
export const auditActionLabel = label(AUDIT_ACTION_LABELS)

export const ACTOR_TYPE_LABELS = Object.freeze({ HUMAN: 'Persona', PROCESS: 'Proceso del sistema', ANONYMOUS: 'Anónimo' })
export const actorTypeLabel = label(ACTOR_TYPE_LABELS)

// Estados con significado de sistema → rótulo y variante semántica de la insignia (DESIGN §1.1).
const STATUS = Object.freeze({
  quarantine: { Pendiente: ['Pendiente', 'warning'], Reinyectado: ['Reinyectado', 'success'], Descartado: ['Descartado', 'neutral'] },
  processing: { PENDIENTE: ['Pendiente', 'neutral'], PROCESANDO: ['En procesamiento', 'information'], LISTA: ['Listo', 'success'], RECHAZADA: ['Rechazado', 'critical'], FALLIDA: ['Fallido', 'critical'] },
  ocr: { Exitoso: ['Exitoso', 'success'], Pendiente: ['Pendiente', 'warning'], 'Rechazado por baja confianza': ['Rechazado por baja confianza', 'critical'], 'No aplica': ['No aplica', 'neutral'], 'Sin resultado OCR': ['Sin resultado OCR', 'neutral'] },
  audit: {
    SUCCESS: ['Éxito', 'success'], ACCEPTED: ['Aceptado', 'success'], INCORPORADO: ['Incorporado', 'success'], REINYECTADO: ['Reinyectado', 'success'],
    Exitoso: ['Exitoso', 'success'], IDEMPOTENTE: ['Ya registrado', 'neutral'], NO_RELEVANT_WORK: ['Sin trabajo aplicable', 'neutral'],
    RESTRICTED: ['Restringido', 'warning'], CONFLICTO: ['Conflicto', 'warning'], REJECTED: ['Rechazado', 'critical'],
    DENIED: ['Denegado', 'critical'], FAILURE: ['Fallo', 'critical'], FAILED: ['Fallo', 'critical'],
  },
})
export function statusPresentation(kind, value) {
  const entry = STATUS[kind]?.[value]
  return entry ? { label: entry[0], variant: entry[1] } : { label: value ?? '—', variant: 'neutral' }
}

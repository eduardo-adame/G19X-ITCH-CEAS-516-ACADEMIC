// Formato esperado de los archivos CSV/XLSX por ubicación controlada. Refleja el contrato de datos del SRS
// (§5.5.3–5.5.7) tal como lo valida el backend (app/validation/contracts.py); es orientativo y el servidor
// sigue siendo quien valida. Una prueba estática comprueba que coincide con el backend.
const SEVERITY = 'alto, medio o bajo'
export const DATA_FORMATS = Object.freeze({
  'contracts-documents': Object.freeze([Object.freeze({
    title: 'Contratos',
    required: ['ID_Contrato', 'Fecha_Solicitud', 'Fecha_Vencimiento', 'Estado_Revision'],
    optional: ['Fecha_Firma'],
    notes: ['Estado_Revision: No iniciado, En revisión, En renovación, Renovado o Cancelado.', 'Fecha_Firma, si se indica, no puede ser anterior a Fecha_Solicitud.'],
  })]),
  litigation: Object.freeze([Object.freeze({
    title: 'Litigios',
    required: ['ID_Litigio', 'Fecha_Apertura', 'Estado', 'Nivel_Severidad'],
    optional: ['Monto_Reclamado', 'Estimacion_Interna'],
    notes: [`Nivel_Severidad: ${SEVERITY}.`, 'Montos: números no negativos.'],
  })]),
  compliance: Object.freeze([Object.freeze({
    title: 'Obligaciones de cumplimiento',
    required: ['ID_Obligacion', 'Fecha_Limite'],
    optional: ['Evidencia_Cumplimiento'],
    notes: ['Evidencia_Cumplimiento vacía significa que no hay evidencia registrada.'],
  })]),
  'internal-audit': Object.freeze([
    Object.freeze({ title: 'Incidentes', required: ['ID_Incidente', 'Fecha_Evento', 'Area', 'Nivel_Severidad'], optional: [], notes: [`Nivel_Severidad: ${SEVERITY}.`] }),
    Object.freeze({ title: 'Asuntos jurídicos', required: ['ID_Asunto', 'Tipo_Asunto', 'Estado', 'Fecha'], optional: [], notes: ['Tipo_Asunto: Contrato, Litigio, Cumplimiento o Auditoría.'] }),
  ]),
})
export const GENERAL_FORMAT_NOTES = Object.freeze(['Fechas en formato AAAA-MM-DD.', 'Una celda vacía significa «sin valor»; no uses 0, N/A ni textos equivalentes.', 'Los documentos PDF y DOCX no necesitan columnas.'])

const EXTENSIONS = Object.freeze(['.csv', '.xlsx', '.pdf', '.docx'])
// Comprobación inmediata del formato al elegir o soltar un archivo (el selector filtra, pero al arrastrar no);
// el tamaño se comprueba aparte y el servidor vuelve a validar todo.
export function formatProblem(file) {
  if (!file) return null
  const name = String(file.name || '').toLowerCase()
  return EXTENSIONS.some((extension) => name.endsWith(extension)) ? null : 'Formato no admitido. Usa un archivo CSV, XLSX, PDF o DOCX.'
}

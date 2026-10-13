import { ApiError } from '../../api/errors.js'
import { validDate } from '../../shared/formatters.js'
import { isUuid } from '../rag/adapters.js'

export const families = Object.freeze([
  { value: 'CONTRATOS_DOCUMENTOS', label: 'Contratos y documentos' },
  { value: 'LITIGIOS', label: 'Litigios' },
  { value: 'CUMPLIMIENTO', label: 'Cumplimiento' },
  { value: 'AUDITORIA_INTERNA', label: 'Auditoría interna' },
])
export const validDocumentId = (id) => typeof id === 'string' && id.trim().length > 0 && Array.from(id).length <= 256 && !/[\u0000-\u001f\u007f/\\]/u.test(id) && !['.', '..'].includes(id)
const fail = () => { throw new ApiError(503) }
function metadata(dto) {
  if (!dto || !validDocumentId(dto.document_id) || !isUuid(dto.document_version_id) || !Number.isInteger(dto.version_number) || dto.version_number < 1 || typeof dto.document_name !== 'string' || !['PDF', 'DOCX'].includes(dto.document_type) || !families.some((family) => family.value === dto.source_family) || !(dto.document_date === null || validDate(dto.document_date)) || !['PDF_ORIGINAL', 'CONSOLIDATED_TEXT'].includes(dto.representation) || typeof dto.text_available !== 'boolean' || dto.document_type === 'DOCX' && dto.representation !== 'CONSOLIDATED_TEXT') fail()
  return Object.freeze({ documentId: dto.document_id, versionId: dto.document_version_id, versionNumber: dto.version_number, name: dto.document_name, type: dto.document_type, family: dto.source_family, date: dto.document_date, representation: dto.representation, textAvailable: dto.text_available })
}
export function adaptCatalog(dto) {
  if (!dto || !Array.isArray(dto.items) || dto.items.length > 100 || !(dto.next_cursor === null || typeof dto.next_cursor === 'string' && dto.next_cursor.length > 0 && dto.next_cursor.length <= 2048)) fail()
  const items = dto.items.map(metadata)
  if (new Set(items.map((item) => item.documentId)).size !== items.length) fail()
  return Object.freeze({ items: Object.freeze(items), nextCursor: dto.next_cursor })
}
export function adaptDocument(dto) {
  const item = metadata(dto)
  // La disponibilidad coincide con btrim(text) del contrato; el texto original no se recorta.
  const available = typeof dto.text === 'string' && dto.text.replace(/^ +| +$/g, '').length > 0
  if (!(dto.text === null || typeof dto.text === 'string') || dto.text_available !== available || !isUuid(dto.operation_id) || !isUuid(dto.correlation_id)) fail()
  return Object.freeze({ ...item, text: dto.text, operationId: dto.operation_id, correlationId: dto.correlation_id })
}

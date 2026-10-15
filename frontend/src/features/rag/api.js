import { ApiError } from '../../api/errors.js'
import { adaptRagResponse, isUuid } from './adapters.js'

export function validateRagQuery(query) {
  // El contrato limita puntos de código Unicode, no unidades UTF-16 del navegador.
  if (typeof query !== 'string' || /^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/u.test(query) || Array.from(query).length > 4096) throw new ApiError(422)
}
export function createRagSubmission(query, contextReferenceId = null, key = globalThis.crypto.randomUUID(), retryOfOperationId = null) {
  validateRagQuery(query)
  if (!isUuid(key) || contextReferenceId !== null && !isUuid(contextReferenceId) || retryOfOperationId !== null && !isUuid(retryOfOperationId)) throw new ApiError(422)
  return Object.freeze({ key, payload: Object.freeze({ query, ...(contextReferenceId ? { context_reference_id: contextReferenceId } : {}), ...(retryOfOperationId ? { retry_of_operation_id: retryOfOperationId } : {}) }) })
}
export async function requestRag(client, submission, signal) {
  if (!isUuid(submission?.key)) throw new ApiError(422)
  const valid = createRagSubmission(submission.payload?.query, submission.payload?.context_reference_id ?? null, submission.key, submission.payload?.retry_of_operation_id ?? null)
  // Un 503 puede conservar evidencia autorizada; no equivale a ausencia de evidencia.
  return adaptRagResponse(await client.request('/rag/query', { method: 'POST', body: valid.payload, headers: { 'Idempotency-Key': valid.key }, acceptStatuses: [503], signal }))
}

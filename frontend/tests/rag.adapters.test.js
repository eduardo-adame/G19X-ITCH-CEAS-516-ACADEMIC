import { describe, expect, it } from 'vitest'
import { adaptRagResponse, citationLocation, RAG_STATES } from '../src/features/rag/adapters.js'

export const fragmentDto = { fragment_id: '33333333-3333-4333-8333-333333333333', fragment_text: 'Texto sintético autorizado.', usage: 'EVIDENCE', document_id: 'DOC-SINTETICO', document_name: 'Documento sintético', document_type: 'PDF', document_date: null, page_start: null, page_end: null, section: null, clause: null }
export function dtoFixture(state = 'EVIDENCIA_SUFICIENTE') {
  const { fragment_text, usage, ...metadata } = fragmentDto
  const enough = state === 'EVIDENCIA_SUFICIENTE'
  return { operation_id: '11111111-1111-4111-8111-111111111111', correlation_id: '22222222-2222-4222-8222-222222222222', state, operation_status: 'COMPLETED', generation_status: enough ? 'SUCCEEDED' : 'NOT_REQUESTED', generated_response: enough ? 'Respuesta sintética [E1].' : null, safe_result_message: enough ? null : 'Mensaje seguro sintético.', context_reference_id: null, fragments: enough ? [fragmentDto] : state === 'EVIDENCIA_INSUFICIENTE' ? [{ ...fragmentDto, usage: 'REFERENCE' }] : [], citations: enough ? [{ handle: 'E1', ...metadata }] : [] }
}

export function restrictionFixture() {
  return { operation_id: '11111111-1111-4111-8111-111111111111', correlation_id: '22222222-2222-4222-8222-222222222222', state: null, policy_result: 'RESTRICCION_ALCANCE', operation_status: 'COMPLETED', generation_status: 'NOT_REQUESTED', generated_response: null, safe_result_message: 'El sistema puede aportar evidencia documental, pero no toma decisiones jurídicas por usted.', context_reference_id: null, fragments: [], citations: [] }
}

describe('SRS_REQUIRED: restricción de alcance de Gate 1 (F-04)', () => {
  it('adapta la restricción sin estado de evidencia, fragmentos ni respuesta', () => {
    const result = adaptRagResponse(restrictionFixture())
    expect(result).toMatchObject({ state: null, policyResult: 'RESTRICCION_ALCANCE', stateLabel: null, response: null, technicalFailure: false })
    expect(result.fragments).toEqual([]); expect(result.citations).toEqual([])
  })
  it.each([
    ['estado de evidencia', (d) => { d.state = 'SIN_AUTORIZACION' }], ['respuesta generada', (d) => { d.generated_response = 'x' }],
    ['fragmentos', (d) => { d.fragments = [{}] }], ['generación solicitada', (d) => { d.generation_status = 'SUCCEEDED' }],
    ['valor desconocido', (d) => { d.policy_result = 'OTRO' }], ['mensaje vacío', (d) => { d.safe_result_message = ' ' }],
  ])('rechaza una restricción inconsistente: %s', (_name, mutate) => { const dto = restrictionFixture(); mutate(dto); expect(() => adaptRagResponse(dto)).toThrow() })
  it('las respuestas de evidencia informan policyResult nulo', () => { expect(adaptRagResponse(dtoFixture()).policyResult).toBeNull() })
})

describe('SRS_REQUIRED: adaptadores RAG', () => {
  it.each(Object.keys(RAG_STATES))('preserva el estado funcional %s', (state) => { const result = adaptRagResponse(dtoFixture(state)); expect(result.state).toBe(state); expect(result.stateLabel).toBe(RAG_STATES[state]) })
  it('conserva metadatos nulos sin crear fechas ni páginas', () => { const fragment = adaptRagResponse(dtoFixture()).fragments[0]; expect(fragment.documentDate).toBeNull(); expect(fragment.pageStart).toBeNull(); expect(citationLocation(fragment)).toBe('') })
  it('preserva fragmentos de contexto no utilizados como cita en estado suficiente', () => { const dto = dtoFixture(); dto.fragments.push({ ...fragmentDto, fragment_id: '44444444-4444-4444-8444-444444444444', usage: 'CONTEXT' }); expect(adaptRagResponse(dto).fragments[1].usage).toBe('CONTEXT') })
  it('mantiene evidencia recuperada ante fallo de generación sin inventar respuesta', () => { const dto = dtoFixture(); dto.operation_status = 'FAILED'; dto.generation_status = 'FAILED'; dto.generated_response = null; dto.fragments[0] = { ...fragmentDto, usage: 'CONTEXT' }; dto.citations = []; const result = adaptRagResponse(dto); expect(result.technicalFailure).toBe(true); expect(result.state).toBe('EVIDENCIA_SUFICIENTE'); expect(result.response).toBeNull(); expect(result.fragments).toHaveLength(1) })
  it('no transforma fallo técnico de recuperación con estado null en Sin evidencia', () => { const dto = dtoFixture('SIN_EVIDENCIA'); dto.state = null; dto.operation_status = 'FAILED'; const result = adaptRagResponse(dto); expect(result.state).toBeNull(); expect(result.technicalFailure).toBe(true) })
  it('elimina toda información documental de un DTO de denegación', () => { const dto = dtoFixture(); dto.state = 'SIN_AUTORIZACION'; dto.safe_result_message = 'Metadato no autorizado'; const result = adaptRagResponse(dto); expect(result.fragments).toEqual([]); expect(result.citations).toEqual([]); expect(result.response).toBeNull(); expect(JSON.stringify(result)).not.toContain('DOC-SINTETICO'); expect(result.message).toBe('Acceso no autorizado.') })
  it('rechaza síntesis para evidencia insuficiente', () => { const dto = dtoFixture('EVIDENCIA_INSUFICIENTE'); dto.generated_response = 'Síntesis improcedente'; expect(() => adaptRagResponse(dto)).toThrow() })
  it('rechaza citas huérfanas y procedencia divergente', () => { const dto = dtoFixture(); dto.citations[0].document_id = 'OTRO'; expect(() => adaptRagResponse(dto)).toThrow() })
  it('conserva referencia contextual solo como identificador, no evidencia', () => { const dto = dtoFixture('SIN_EVIDENCIA'); dto.context_reference_id = '44444444-4444-4444-8444-444444444444'; const result = adaptRagResponse(dto); expect(result.contextReferenceId).toBe(dto.context_reference_id); expect(result.fragments).toEqual([]) })
})
describe('ROBUSTNESS: validación del contrato físico', () => {
  it.each(['state', 'operation_status', 'generation_status'])('rechaza enum desconocido %s', (field) => { const dto = dtoFixture(); dto[field] = 'DESCONOCIDO'; expect(() => adaptRagResponse(dto)).toThrow() })
  it('rechaza fragmentos duplicados y más de cinco resultados', () => { const dto = dtoFixture(); dto.fragments = Array(6).fill(fragmentDto); expect(() => adaptRagResponse(dto)).toThrow() })
  it('rechaza fecha imposible y rango de páginas invertido', () => { for (const mutation of [{ document_date: '2030-02-30' }, { page_start: 4, page_end: 2 }]) { const dto = dtoFixture(); dto.fragments = [{ ...fragmentDto, ...mutation }]; expect(() => adaptRagResponse(dto)).toThrow() } })
  it('rechaza respuesta truncada sin arrays', () => { expect(() => adaptRagResponse({ state: 'SIN_EVIDENCIA' })).toThrow() })
})

describe('generación sustentada (F-04)', () => {
  it('acepta la abstención del proveedor como Estado 2 con fragmentos de referencia', () => {
    const dto = dtoFixture('EVIDENCIA_INSUFICIENTE'); dto.generation_status = 'ABSTAINED'
    const result = adaptRagResponse(dto)
    expect(result.state).toBe('EVIDENCIA_INSUFICIENTE'); expect(result.response).toBeNull(); expect(result.technicalFailure).toBe(false); expect(result.fragments[0].usage).toBe('REFERENCE')
  })
  it('rechaza la abstención fuera de un Estado 2 completado', () => {
    for (const mutate of [(d) => { d.state = 'EVIDENCIA_SUFICIENTE' }, (d) => { d.operation_status = 'FAILED' }, (d) => { d.state = 'SIN_EVIDENCIA'; d.fragments = [] }]) {
      const dto = dtoFixture('EVIDENCIA_INSUFICIENTE'); dto.generation_status = 'ABSTAINED'; mutate(dto); expect(() => adaptRagResponse(dto)).toThrow()
    }
  })
  it('presenta el fallo de generación sin estado de evidencia y conserva los fragmentos de referencia', () => {
    const dto = dtoFixture('EVIDENCIA_INSUFICIENTE'); dto.state = null; dto.operation_status = 'FAILED'; dto.generation_status = 'FAILED'; dto.safe_result_message = 'La generación no pudo completarse.'
    const result = adaptRagResponse(dto)
    expect(result.state).toBeNull(); expect(result.stateLabel).toBeNull(); expect(result.technicalFailure).toBe(true); expect(result.response).toBeNull(); expect(result.fragments).toHaveLength(1)
  })
  it('un fallo sin estado nunca muestra fragmentos como evidencia ni respuesta', () => {
    const dto = dtoFixture('EVIDENCIA_INSUFICIENTE'); dto.state = null; dto.operation_status = 'FAILED'; dto.generation_status = 'FAILED'; dto.fragments = [{ ...fragmentDto }]
    expect(() => adaptRagResponse(dto)).toThrow()
    const withText = dtoFixture('EVIDENCIA_INSUFICIENTE'); withText.state = null; withText.operation_status = 'FAILED'; withText.generation_status = 'FAILED'; withText.generated_response = 'Texto'
    expect(() => adaptRagResponse(withText)).toThrow()
  })
})

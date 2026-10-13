import { describe, expect, it } from 'vitest'
import { adaptCatalog, adaptDocument, validDocumentId } from '../src/features/documents/adapters.js'

import { fullDocument, metadata } from './fixtures/documents.js'

describe('SRS_REQUIRED: contrato del visor independiente', () => {
  it('preserva identidad de negocio, versión, fecha null y texto completo', () => {
    expect(adaptCatalog({ items: [metadata], next_cursor: null }).items[0]).toMatchObject({ documentId: metadata.document_id, date: null, versionNumber: 1 })
    expect(adaptDocument(fullDocument).text).toBe(fullDocument.text)
  })
  it('catálogo vacío no inventa totales ni documentos', () => { expect(adaptCatalog({ items: [], next_cursor: null })).toEqual({ items: [], nextCursor: null }) })
  it('PDF sin texto permite la modalidad original sin fingir texto completo', () => { expect(adaptDocument({ ...fullDocument, document_type: 'PDF', representation: 'PDF_ORIGINAL', text_available: false, text: null }).text).toBeNull() })
  it('texto sólo espacios conserva su valor pero declara no disponible', () => { expect(adaptDocument({ ...fullDocument, text: '   ', text_available: false })).toMatchObject({ text: '   ', textAvailable: false }) })
  it.each([{ document_date: 'inventada' }, { document_version_id: 'no-uuid' }, { version_number: 0 }, { source_family: 'NUEVA' }, { document_type: 'HTML' }, { representation: 'PDF_ORIGINAL' }, { text_available: false }])('rechaza metadata o contenido incompatible %j', (change) => { expect(() => adaptDocument({ ...fullDocument, ...change })).toThrow() })
})
describe('ROBUSTNESS: identidades y datos defectuosos', () => {
  it.each(['', '   ', '..', 'a/b', 'a\\b', '\u0000', 'x'.repeat(257)])('rechaza ID técnico inseguro %s', (id) => { expect(validDocumentId(id)).toBe(false) })
  it('longitud de ID usa puntos Unicode como backend, no unidades UTF16', () => { expect(validDocumentId('😀'.repeat(256))).toBe(true); expect(validDocumentId('😀'.repeat(257))).toBe(false) })
  it('acepta identidad TEXT no UUID y no ejecuta HTML', () => { expect(validDocumentId('DOC-ÁREA#1')).toBe(true); expect(adaptDocument({ ...fullDocument, text: '<script>contenido sintético</script>' }).text).toContain('<script>') })
  it('rechaza duplicados y cursor defectuoso', () => { expect(() => adaptCatalog({ items: [metadata, metadata], next_cursor: null })).toThrow(); expect(() => adaptCatalog({ items: [], next_cursor: 123 })).toThrow() })
})

import { describe, expect, it, vi } from 'vitest'
import { catalogPath, documentPath, readCatalog, readDocument, readOriginal } from '../src/features/documents/api.js'
import { fullDocument, metadata } from './fixtures/documents.js'

describe('SRS_REQUIRED: lecturas documentales sin RAG', () => {
  it('codifica filtros de API y mantiene versión esperada en selección', async () => {
    expect(catalogPath({ q: 'nombre %_', source_family: 'LITIGIOS', document_type: 'PDF', cursor: 'sintetico' })).toBe('/documents/viewer?limit=25&q=nombre+%25_&source_family=LITIGIOS&document_type=PDF&cursor=sintetico')
    expect(documentPath('DOC-ÁREA#1', metadata.document_version_id)).toContain('DOC-%C3%81REA%231?version_id=')
    const client = { request: vi.fn().mockResolvedValueOnce({ items: [metadata], next_cursor: null }).mockResolvedValueOnce(fullDocument) }
    await readCatalog(client, {}); await readDocument(client, metadata.document_id, metadata.document_version_id)
    expect(client.request.mock.calls.every(([path, options]) => path.startsWith('/documents/viewer') && !options.method)).toBe(true)
  })
  it('obtiene PDF por cliente protegido con Blob, no URL pública', async () => {
    const blob = new Blob(['%PDF-sintetico'], { type: 'application/pdf' }); const client = { request: vi.fn(async () => blob) }
    expect(await readOriginal(client, metadata.document_id, metadata.document_version_id)).toBe(blob)
    expect(client.request).toHaveBeenCalledWith(expect.stringContaining('/original?version_id='), expect.objectContaining({ responseType: 'blob' }))
  })
  it.each(['text/html', 'application/octet-stream', ''])('rechaza MIME no PDF %s', async (type) => { await expect(readOriginal({ request: async () => new Blob(['sintetico'], { type }) }, metadata.document_id, metadata.document_version_id)).rejects.toMatchObject({ status: 503 }) })
  it('no acepta documento/versión distinto del solicitado', async () => { await expect(readDocument({ request: async () => ({ ...fullDocument, document_id: 'OTRO' }) }, metadata.document_id, metadata.document_version_id)).rejects.toMatchObject({ status: 503 }) })
  it('original exige versión y filtros sólo familias/tipos aprobados', () => { expect(() => documentPath(metadata.document_id, null, true)).toThrow(); expect(() => catalogPath({ q: '😀'.repeat(201) })).toThrow(); expect(() => catalogPath({ source_family: 'PRIVADA' })).toThrow(); expect(() => catalogPath({ document_type: 'HTML' })).toThrow() })
  it('rechaza controles en búsqueda como backend, no cambia texto válido', () => { expect(() => catalogPath({ q: 'nombre\ncontrol' })).toThrow(); expect(catalogPath({ q: '😀'.repeat(200) })).toContain('q=') })
})

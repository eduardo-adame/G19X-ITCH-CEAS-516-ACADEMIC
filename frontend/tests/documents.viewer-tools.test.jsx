import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SessionProvider } from '../src/auth/SessionProvider.jsx'
import { findMatches, MAX_MATCHES, segments } from '../src/features/documents/textSearch.js'
import { SearchableText, ViewerHelp } from '../src/features/documents/viewerTools.jsx'
import { PrintControl, printFooter } from '../src/features/documents/printing.jsx'
import { recallFilters, rememberFilters } from '../src/features/documents/DocumentCatalog.jsx'
import { registerPrint } from '../src/features/documents/api.js'

const pdf = vi.hoisted(() => {
  const renderTask = vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }))
  const getPage = vi.fn(async () => ({ getViewport: ({ scale }) => ({ width: 612 * scale, height: 792 * scale }), render: renderTask }))
  const getDocument = vi.fn(() => ({ promise: Promise.resolve({ numPages: 12, getPage }), destroy: vi.fn(async () => {}) }))
  return { renderTask, getPage, getDocument }
})
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ AnnotationMode: { DISABLE: 0 }, GlobalWorkerOptions: {}, getDocument: pdf.getDocument }))
vi.mock('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url', () => ({ default: '/assets/pdf.worker.min.mjs' }))
import { nextZoom, parsePage, PdfOriginal } from '../src/features/documents/PdfOriginal.jsx'

const versionId = '22222222-2222-4222-8222-222222222222'
const item = Object.freeze({ documentId: 'DOC-1', versionId, name: 'Contrato sintético', versionNumber: 3 })
const principal = Object.freeze({ id: '11111111-1111-4111-8111-111111111111', username: 'ana.m', displayName: 'Ana Martínez', roles: ['JURIDICO'] })
const receipt = { operation_id: '33333333-3333-4333-8333-333333333333', correlation_id: '44444444-4444-4444-8444-444444444444' }
function withSession(ui, request = vi.fn(async () => receipt)) {
  const snapshot = { status: 'authenticated', principal, generation: 1 }
  const manager = { client: { request }, getSnapshot: () => snapshot, subscribe: () => () => {}, restore: vi.fn(), revalidate: vi.fn(async () => true) }
  render(<SessionProvider manager={manager}>{ui}</SessionProvider>)
  return request
}
function pdfBlob() {
  Object.defineProperty(Blob.prototype, 'arrayBuffer', { configurable: true, value: vi.fn(async () => new TextEncoder().encode('%PDF-sintetico').buffer) })
  return new Blob(['%PDF-sintetico'], { type: 'application/pdf' })
}
beforeEach(() => { pdf.getPage.mockClear(); pdf.renderTask.mockClear(); vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({}) })
afterEach(() => vi.restoreAllMocks())

describe('ROBUSTNESS: búsqueda en el texto procesado', () => {
  it('no distingue acentos ni mayúsculas y conserva las posiciones del texto original', () => {
    const text = 'La CLÁUSULA penal y la clausula de rescisión.'
    const matches = findMatches(text, 'clausula')
    expect(matches.map(([start, end]) => text.slice(start, end))).toEqual(['CLÁUSULA', 'clausula'])
    expect(findMatches(text, 'RESCISION').map(([s, e]) => text.slice(s, e))).toEqual(['rescisión'])
    expect(segments(text, matches).map((part) => part.match ?? '-')).toEqual(['-', 0, '-', 1, '-'])
  })
  it('exige al menos 2 caracteres y limita las coincidencias', () => {
    expect(findMatches('aaa', 'a')).toEqual([])
    expect(findMatches('ab '.repeat(MAX_MATCHES + 50), 'ab')).toHaveLength(MAX_MATCHES)
  })
  it('resalta, cuenta y recorre las coincidencias con Enter', async () => {
    render(<SearchableText text={'Primera cláusula.\nSegunda CLAUSULA.\nFin.'} />)
    const box = screen.getByRole('searchbox', { name: 'Buscar en el texto' })
    await userEvent.type(box, 'clausula{Enter}')
    expect(screen.getByRole('status')).toHaveTextContent('1 de 2')
    expect(document.querySelectorAll('mark.search-hit')).toHaveLength(2)
    expect(document.querySelector('mark[data-current="true"]')).toHaveTextContent('cláusula')
    await userEvent.keyboard('{Enter}')
    expect(screen.getByRole('status')).toHaveTextContent('2 de 2')
    expect(document.querySelector('mark[data-current="true"]')).toHaveTextContent('CLAUSULA')
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}')
    expect(screen.getByRole('status')).toHaveTextContent('1 de 2')
    await userEvent.clear(box); await userEvent.type(box, 'inexistente{Enter}')
    expect(screen.getByRole('status')).toHaveTextContent('Sin coincidencias')
    expect(screen.getByRole('region', { name: 'Texto completo procesado' })).toHaveTextContent('Primera cláusula.')
  })
})

describe('ROBUSTNESS: navegación y zoom del PDF', () => {
  it('valida la página escrita y los pasos de zoom', () => {
    expect(parsePage('7', 12)).toBe(7)
    expect([parsePage('0', 12), parsePage('13', 12), parsePage('2.5', 12), parsePage('abc', 12), parsePage('', 12)]).toEqual([null, null, null, null, null])
    expect(nextZoom(1, 1)).toBe(1.25)
    expect(nextZoom(1, -1)).toBe(0.75)
    expect(nextZoom(0.87, 1)).toBe(1)
    expect(nextZoom(2, 1)).toBe(2)
    expect(nextZoom(0.5, -1)).toBe(0.5)
  })
  it('va a la página escrita, rechaza un número fuera del documento y usa las flechas con el foco en el documento', async () => {
    const onPage = vi.fn()
    render(<PdfOriginal blob={pdfBlob()} onPage={onPage} />)
    const field = await screen.findByRole('textbox', { name: 'Página' })
    expect(screen.getByText('de 12')).toBeVisible()
    await userEvent.clear(field); await userEvent.type(field, '9{Enter}')
    await screen.findByRole('img', { name: 'Página 9 de 12 del PDF original' })
    expect(onPage).toHaveBeenLastCalledWith(9)
    await userEvent.clear(field); await userEvent.type(field, '40{Enter}')
    expect(screen.getByRole('alert')).toHaveTextContent('Escribe un número de página entre 1 y 12.')
    const region = screen.getByRole('region', { name: /Página 9 de 12/ })
    fireEvent.keyDown(region, { key: 'ArrowRight' })
    await screen.findByRole('img', { name: 'Página 10 de 12 del PDF original' })
    fireEvent.keyDown(region, { key: 'ArrowLeft' }); fireEvent.keyDown(region, { key: 'ArrowLeft' })
    await screen.findByRole('img', { name: 'Página 8 de 12 del PDF original' })
  })
  it('acerca, aleja y vuelve a ajustar al ancho', async () => {
    render(<PdfOriginal blob={pdfBlob()} />)
    const fit = await screen.findByRole('button', { name: 'Ajustar al ancho' })
    await waitFor(() => expect(fit).toBeEnabled())
    expect(fit).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(screen.getByRole('button', { name: 'Acercar' }))
    expect(fit).toHaveAttribute('aria-pressed', 'false')
    const percent = () => screen.getByRole('group', { name: 'Zoom' }).textContent
    expect(percent()).toMatch(/\d+ %/)
    fireEvent.keyDown(screen.getByRole('region', { name: /del PDF original/ }), { key: '-' })
    await userEvent.click(fit)
    expect(fit).toHaveAttribute('aria-pressed', 'true')
  })
  it('entrega el número de páginas y el dibujo para imprimir al terminar de cargar', async () => {
    const onReady = vi.fn()
    render(<PdfOriginal blob={pdfBlob()} onReady={onReady} />)
    await waitFor(() => expect(onReady).toHaveBeenCalledWith({ pages: 12, renderPage: expect.any(Function) }))
  })
})

describe('ROBUSTNESS: ayuda del visor y filtros recordados', () => {
  it('la ayuda se despliega con su botón y explica el registro', async () => {
    render(<ViewerHelp />)
    const button = screen.getByRole('button', { name: 'Ayuda del visor' })
    expect(button).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(document.getElementById(button.getAttribute('aria-controls'))).toHaveTextContent('cada apertura y cada impresión quedan registradas en la auditoría')
  })
  it('los filtros se recuerdan solo para la misma sesión', () => {
    rememberFilters('cuenta:1', { q: 'arrendamiento', source_family: 'LITIGIOS', document_type: 'PDF' })
    expect(recallFilters('cuenta:1')).toEqual({ q: 'arrendamiento', source_family: 'LITIGIOS', document_type: 'PDF' })
    expect(recallFilters('cuenta:2')).toEqual({ q: '', source_family: '', document_type: '' })
    expect(recallFilters('cuenta:1')).toEqual({ q: '', source_family: '', document_type: '' })
  })
})

describe('SRS_REQUIRED: impresión auditada (RF-077, SRS 0.25)', () => {
  it('el pie identifica a la persona, la fecha, el documento y la versión', () => {
    const footer = printFooter({ principal, item, printedAt: new Date(2026, 9, 16, 10, 42), page: 2, pages: 12 })
    expect(footer).toBe('Impreso por Ana Martínez (ana.m) · 16 oct 2026, 10:42 · Contrato sintético, versión 3 · Página 2 de 12')
  })
  it('registra la impresión antes de imprimir el texto y lo imprime con su pie', async () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => {})
    const request = withSession(<PrintControl item={item} mode="text" text="Texto completo sintético." />)
    await userEvent.click(screen.getByRole('button', { name: 'Imprimir' }))
    const dialog = screen.getByRole('dialog', { name: 'Imprimir documento' })
    expect(dialog).toHaveTextContent('La impresión quedará registrada en la auditoría')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Imprimir' }))
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1))
    expect(request).toHaveBeenCalledWith(`/documents/viewer/DOC-1/print?version_id=${versionId}`, expect.objectContaining({ method: 'POST' }))
    const sheets = document.querySelector('.print-root')
    expect(sheets).toHaveTextContent('Texto completo sintético.')
    expect(sheets).toHaveTextContent('Impreso por Ana Martínez (ana.m)')
    act(() => window.dispatchEvent(new Event('afterprint')))
    expect(document.querySelector('.print-root')).toBeNull()
  })
  it('si la auditoría no confirma el registro no se imprime', async () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => {})
    withSession(<PrintControl item={item} mode="text" text="Texto." />, vi.fn(async () => { throw Object.assign(new Error('x'), { status: 503 }) }))
    await userEvent.click(screen.getByRole('button', { name: 'Imprimir' }))
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Imprimir' }))
    expect(await screen.findByText('No se pudo registrar la impresión en la auditoría; por seguridad no se imprimió.')).toBeVisible()
    expect(print).not.toHaveBeenCalled()
    expect(document.querySelector('.print-root')).toBeNull()
  })
  it('PDF: prepara todas las páginas o solo la actual, y libera las imágenes al terminar', async () => {
    vi.spyOn(window, 'print').mockImplementation(() => {})
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const renderPage = vi.fn(async (page) => `blob:pagina-${page}`)
    withSession(<PrintControl item={item} mode="pdf" pages={3} currentPage={2} renderPage={renderPage} />)
    await userEvent.click(screen.getByRole('button', { name: 'Imprimir' }))
    await userEvent.click(screen.getByRole('radio', { name: 'Solo la página actual (página 2)' }))
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Imprimir' }))
    await waitFor(() => expect(window.print).toHaveBeenCalledTimes(1))
    expect(renderPage.mock.calls).toEqual([[2]])
    expect(document.querySelector('.print-root figcaption')).toHaveTextContent('Página 2 de 3')
    act(() => window.dispatchEvent(new Event('afterprint')))
    expect(revoke).toHaveBeenCalledWith('blob:pagina-2')
    await userEvent.click(screen.getByRole('button', { name: 'Imprimir' }))
    expect(screen.getByRole('radio', { name: 'Todo el documento (3 páginas)' })).toBeChecked()
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Imprimir' }))
    await waitFor(() => expect(window.print).toHaveBeenCalledTimes(2))
    expect(renderPage.mock.calls.slice(1)).toEqual([[1], [2], [3]])
    expect(document.querySelectorAll('.print-root figure')).toHaveLength(3)
    act(() => window.dispatchEvent(new Event('afterprint')))
    expect(document.querySelector('.print-root')).toBeNull()
  })
  it('el registro exige identificadores válidos y un recibo completo', async () => {
    await expect(registerPrint({ request: vi.fn() }, 'DOC-1', 'no-uuid')).rejects.toMatchObject({ status: 422 })
    await expect(registerPrint({ request: vi.fn(async () => ({ operation_id: 'x' })) }, 'DOC-1', versionId)).rejects.toMatchObject({ status: 503 })
    await expect(registerPrint({ request: vi.fn(async () => receipt) }, 'DOC-1', versionId)).resolves.toEqual(receipt)
  })
})

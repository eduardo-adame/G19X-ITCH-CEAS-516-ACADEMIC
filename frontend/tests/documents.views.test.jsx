import React, { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { SessionProvider } from '../src/auth/SessionProvider.jsx'
import { RagLayout } from '../src/features/rag/state.jsx'
import { RagDocumentPage } from '../src/features/rag/pages.jsx'
import { ApiError } from '../src/api/errors.js'
import { fullDocument, metadata } from './fixtures/documents.js'
import { recallFilters } from '../src/features/documents/DocumentCatalog.jsx'

vi.mock('../src/features/documents/PdfOriginal.jsx', () => ({
  PdfOriginal: ({ blob, initialPage }) => <canvas title="PDF original renderizado" data-size={blob.size} data-initial-page={initialPage} />,
}))

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done }); return { promise, resolve } }
function Location() { return <output aria-label="URL actual">{useLocation().search}</output> }
function mount({ path = '/documentos', request = vi.fn(async (url) => url.includes('?limit=') ? { items: [metadata], next_cursor: null } : fullDocument), revalidate = vi.fn(async () => true) } = {}) {
  let snapshot = { status: 'authenticated', principal: { id: 'cuenta-sintetica', roles: ['TI'] }, generation: 1 }
  const listeners = new Set()
  const manager = { client: { request }, getSnapshot: () => snapshot, subscribe(callback) { listeners.add(callback); return () => listeners.delete(callback) }, restore: vi.fn(), revalidate, update(change) { snapshot = { ...snapshot, ...change }; listeners.forEach((callback) => callback(snapshot)) } }
  const view = render(<StrictMode><SessionProvider manager={manager}><MemoryRouter initialEntries={[path]}><Location /><Routes><Route element={<RagLayout />}><Route path="/documentos" element={<RagDocumentPage />} /></Route></Routes></MemoryRouter></SessionProvider></StrictMode>)
  return { manager, request, view }
}
// Cada prueba empieza sin filtros recordados de la anterior (otra identidad vacía la memoria).
afterEach(() => { vi.restoreAllMocks(); recallFilters('sin-sesion') })

describe('SRS_REQUIRED: catálogo y documento completo autorizados', () => {
  it('abrir menú lista documentos y selección abre contenido completo sin POST', async () => {
    const { request } = mount(); await userEvent.click(await screen.findByRole('link', { name: 'Abrir Documento sintético' }))
    expect(await screen.findByRole('region', { name: 'Texto completo procesado' })).toHaveTextContent('Final del documento sintético.')
    expect(screen.getByText('Texto completo procesado; no reproduce la maquetación original.')).toBeVisible()
    expect(screen.getByLabelText('URL actual')).toHaveTextContent(`version_id=${metadata.document_version_id}`)
    expect(request.mock.calls.every(([path, options]) => path.startsWith('/documents/viewer') && !options.method)).toBe(true)
  })
  it('selección directa/F5 refetchea vigente y admite fecha null', async () => {
    const { request } = mount({ path: `/documentos?document_id=${metadata.document_id}&version_id=${metadata.document_version_id}` })
    await screen.findByRole('region', { name: 'Texto completo procesado' }); expect(screen.getByText('No disponible')).toBeVisible()
    expect(request).toHaveBeenCalledWith(expect.stringContaining('version_id='), expect.any(Object))
  })
  it('aplica búsqueda literal, filtros y reinicia paginación sin filtros en URL', async () => {
    const { request } = mount(); await screen.findByRole('link', { name: 'Abrir Documento sintético' })
    await userEvent.type(screen.getByLabelText('Buscar por nombre'), 'nombre sintético'); await userEvent.selectOptions(screen.getByLabelText('Tipo documental'), 'PDF'); await userEvent.selectOptions(screen.getByLabelText('Familia documental'), 'LITIGIOS')
    // Sin botón «Aplicar»: los selectores aplican al cambiar y la búsqueda tras una pausa al escribir.
    await waitFor(() => expect(request).toHaveBeenCalledWith(expect.stringContaining('q=nombre+sint%C3%A9tico&source_family=LITIGIOS&document_type=PDF'), expect.any(Object)))
    expect(screen.queryByRole('button', { name: 'Aplicar filtros' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('URL actual')).not.toHaveTextContent('nombre')
  })
  it('ROBUSTNESS: al volver de un documento se conservan los filtros del catálogo', async () => {
    const { request } = mount(); await screen.findByRole('link', { name: 'Abrir Documento sintético' })
    await userEvent.type(screen.getByLabelText('Buscar por nombre'), 'sintético'); await userEvent.selectOptions(screen.getByLabelText('Tipo documental'), 'DOCX')
    await waitFor(() => expect(request).toHaveBeenCalledWith(expect.stringContaining('document_type=DOCX'), expect.any(Object)))
    await userEvent.click(screen.getByRole('link', { name: 'Abrir Documento sintético' }))
    const panel = await screen.findByRole('region', { name: 'Documento completo' })
    expect(within(panel).getByRole('button', { name: 'Imprimir' })).toBeEnabled()
    expect(within(panel).getByRole('button', { name: 'Ayuda del visor' })).toBeVisible()
    expect(within(panel).getByRole('searchbox', { name: 'Buscar en el texto' })).toBeVisible()
    await userEvent.click(screen.getByRole('link', { name: 'Volver a documentos autorizados' }))
    expect(await screen.findByLabelText('Buscar por nombre')).toHaveValue('sintético')
    expect(screen.getByLabelText('Tipo documental')).toHaveValue('DOCX')
    expect(screen.getByRole('button', { name: /Quitar filtro Tipo: DOCX|Tipo: DOCX/ })).toBeVisible()
    expect(screen.getByLabelText('URL actual')).not.toHaveTextContent('sint')
  })
  it('catálogo vacío no revela existencia o cantidades excluidas', async () => { mount({ request: vi.fn(async () => ({ items: [], next_cursor: null })) }); expect(await screen.findByText('Sin documentos disponibles')).toBeVisible() })
  it.each([403, 404, 409, 503])('error%s no muestra metadata ni contenido anterior', async (status) => { mount({ path: `/documentos?document_id=${metadata.document_id}`, request: vi.fn(async () => { throw new ApiError(status) }) }); await screen.findByRole('alert'); expect(screen.queryByText(metadata.document_name)).not.toBeInTheDocument(); expect(screen.queryByRole('region', { name: 'Texto completo procesado' })).not.toBeInTheDocument() })
  it('texto jurídico potencialmente HTML se muestra escapado', async () => { mount({ path: `/documentos?document_id=${metadata.document_id}`, request: vi.fn(async () => ({ ...fullDocument, text: '<img src=x onerror=alert(1)> sintético' })) }); expect(await screen.findByText('<img src=x onerror=alert(1)> sintético')).toBeVisible(); expect(document.querySelector('img')).toBeNull() })
  it.each(['logout', 'identidad', 'revocacion'])('%s retira contenido e ignora respuesta tardía', async (change) => {
    const pending = deferred(); const next = deferred(); const { manager, request } = mount({ path: `/documentos?document_id=${metadata.document_id}`, request: vi.fn().mockImplementationOnce(() => pending.promise).mockImplementation(() => next.promise) })
    await waitFor(() => expect(request).toHaveBeenCalled()); act(() => manager.update(change === 'logout' ? { status: 'anonymous', principal: null, generation: 2 } : change === 'identidad' ? { principal: { id: 'otra-cuenta-sintetica', roles: ['TI'] } } : { generation: 2 }))
    await act(async () => pending.resolve(fullDocument)); expect(screen.queryByText(fullDocument.text)).not.toBeInTheDocument()
  })
  it('foco suspende contenido, rechazo no restaura bytes ni dispara RAG', async () => {
    const { manager, request } = mount({ path: `/documentos?document_id=${metadata.document_id}` }); await screen.findByRole('region', { name: 'Texto completo procesado' })
    const verification = deferred(); manager.revalidate.mockImplementation(() => verification.promise); fireEvent(window, new Event('focus'))
    expect(screen.queryByRole('region', { name: 'Texto completo procesado' })).not.toBeInTheDocument(); await act(async () => verification.resolve(false)); await screen.findByRole('alert'); expect(screen.queryByText(metadata.document_name)).not.toBeInTheDocument(); expect(request.mock.calls.every(([path]) => !path.includes('/rag/'))).toBe(true)
  })
  it('revalidación denegada al entrar no solicita catálogo', async () => { const { request } = mount({ revalidate: vi.fn(async () => false) }); await screen.findByRole('alert'); expect(request).not.toHaveBeenCalled() })
  it('cambio de identidad sin generación elimina también búsqueda y filtros previos', async () => {
    const { manager } = mount(); await screen.findByRole('link', { name: 'Abrir Documento sintético' }); await userEvent.type(screen.getByLabelText('Buscar por nombre'), 'nombre privado sintético'); await userEvent.selectOptions(screen.getByLabelText('Familia documental'), 'LITIGIOS')
    act(() => manager.update({ principal: { id: 'otra-cuenta-sintetica', roles: ['TI'] } })); await waitFor(() => expect(screen.getByLabelText('Buscar por nombre')).toHaveValue('')); expect(screen.getByLabelText('Familia documental')).toHaveValue('')
  })
  it('reintento de GET503 existe y no se convierte en consulta RAG', async () => {
    const request = vi.fn().mockRejectedValueOnce(new ApiError(503)).mockResolvedValue({ items: [metadata], next_cursor: null }); mount({ request }); await userEvent.click(await screen.findByRole('button', { name: 'Reintentar' })); await screen.findByRole('link', { name: 'Abrir Documento sintético' }); expect(request.mock.calls.every(([path]) => path.startsWith('/documents/viewer'))).toBe(true)
  })
  it('PDF original entrega bytes al renderizador local y se retira durante suspensión/desmontaje', async () => {
    const pdf = { ...fullDocument, document_type: 'PDF', representation: 'PDF_ORIGINAL' }
    const { manager, request, view } = mount({ path: `/documentos?document_id=${metadata.document_id}`, request: vi.fn(async (path) => path.includes('/original') ? new Blob(['%PDF-sintetico'], { type: 'application/pdf' }) : pdf) })
    expect(await screen.findByTitle('PDF original renderizado')).toHaveAttribute('data-size', String(new Blob(['%PDF-sintetico']).size)); expect(request).toHaveBeenCalledWith(expect.stringContaining('/original?version_id='), expect.objectContaining({ responseType: 'blob' }))
    expect(document.querySelector('iframe')).toBeNull()
    const verification = deferred(); manager.revalidate.mockImplementation(() => verification.promise); fireEvent(window, new Event('focus')); expect(screen.queryByTitle('PDF original renderizado')).not.toBeInTheDocument()
    await act(async () => verification.resolve(true)); await screen.findByTitle('PDF original renderizado'); view.unmount()
  })
  it('ROBUSTNESS: una cita abre el PDF completo en su página inicial y descarta páginas inválidas', async () => {
    const pdf = { ...fullDocument, document_type: 'PDF', representation: 'PDF_ORIGINAL' }
    const request = vi.fn(async (path) => path.includes('/original') ? new Blob(['%PDF-sintetico'], { type: 'application/pdf' }) : pdf)
    const first = mount({ path: `/documentos?document_id=${metadata.document_id}&page=3`, request })
    expect(await screen.findByTitle('PDF original renderizado')).toHaveAttribute('data-initial-page', '3')
    expect(screen.getByLabelText('URL actual')).toHaveTextContent('page=3')
    expect(request.mock.calls.every(([path]) => !path.includes('page='))).toBe(true)
    first.view.unmount()
    for (const page of ['0', 'abc', '100000']) {
      const view = mount({ path: `/documentos?document_id=${metadata.document_id}&page=${page}`, request })
      expect(await screen.findByTitle('PDF original renderizado')).toHaveAttribute('data-initial-page', '1')
      expect(screen.getByLabelText('URL actual')).not.toHaveTextContent('page=')
      view.view.unmount()
    }
  })
  it('no crea URL para PDF tardío después de logout', async () => {
    const pending = deferred(); const pdf = { ...fullDocument, document_type: 'PDF', representation: 'PDF_ORIGINAL' }
    const { manager, request } = mount({ path: `/documentos?document_id=${metadata.document_id}`, request: vi.fn((path) => path.includes('/original') ? pending.promise : Promise.resolve(pdf)) })
    await waitFor(() => expect(request.mock.calls.some(([path]) => path.includes('/original'))).toBe(true)); act(() => manager.update({ status: 'anonymous', principal: null, generation: 2 })); await act(async () => pending.resolve(new Blob(['%PDF-sintetico'], { type: 'application/pdf' }))); expect(screen.queryByTitle('PDF original renderizado')).not.toBeInTheDocument()
  })
  it('MIME inválido conserva error y permite texto alternativo explícito, nunca iframe', async () => {
    const pdf = { ...fullDocument, document_type: 'PDF', representation: 'PDF_ORIGINAL' }; mount({ path: `/documentos?document_id=${metadata.document_id}`, request: vi.fn(async (path) => path.includes('/original') ? new Blob(['sintetico'], { type: 'text/html' }) : pdf) }); await screen.findByRole('alert'); expect(screen.queryByTitle('PDF original renderizado')).not.toBeInTheDocument(); expect(document.querySelector('iframe')).toBeNull(); await userEvent.click(screen.getByRole('button', { name: 'Texto completo procesado' })); expect(await screen.findByRole('region', { name: 'Texto completo procesado' })).toHaveTextContent('Final del documento sintético.')
  })
})
describe('ROBUSTNESS: selectores aislados y respuestas tardías', () => {
  it.each(['invalido', '33333333-3333-4333-8333-333333333333'])('fragment_id=%s conserva fragmento vacío sin catálogo incluso con selector documental', async (id) => { const { request } = mount({ path: `/documentos?fragment_id=${id}&document_id=DOC-SINTETICO` }); expect(await screen.findByText('No hay un fragmento disponible')).toBeVisible(); expect(request).not.toHaveBeenCalled(); expect(screen.getByLabelText('URL actual')).not.toHaveTextContent('document_id'); expect(screen.getByRole('link', { name: 'Ver documentos autorizados' })).toBeVisible() })
  it('página siguiente usa cursor y volver usa la selección previa', async () => {
    const request = vi.fn(async (path) => ({ items: [metadata], next_cursor: path.includes('cursor=') ? null : 'cursor-sintetico' })); mount({ request }); await userEvent.click(await screen.findByRole('button', { name: 'Página siguiente' })); await waitFor(() => expect(request).toHaveBeenCalledWith(expect.stringContaining('cursor=cursor-sintetico'), expect.any(Object))); await userEvent.click(screen.getByRole('button', { name: 'Página anterior' })); await screen.findByRole('button', { name: 'Página siguiente' })
  })
  it('no persiste listas ni texto y limpia parámetros ajenos', async () => { const storage = vi.spyOn(Storage.prototype, 'setItem'); mount({ path: '/documentos?q=nombre-privado&token=secreto-sintetico' }); await screen.findByRole('link', { name: 'Abrir Documento sintético' }); expect(screen.getByLabelText('URL actual')).not.toHaveTextContent('privado'); expect(storage).not.toHaveBeenCalled() })
})

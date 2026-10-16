import React, { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { SessionProvider } from '../src/auth/SessionProvider.jsx'
import { RagLayout } from '../src/features/rag/state.jsx'
import { RagDocumentPage, RagQueryPage } from '../src/features/rag/pages.jsx'
import { RAG_EVIDENCIA_SUFICIENTE, RAG_SIN_EVIDENCIA } from './e2e/helpers.js'

const CONTEXT = '44444444-4444-4444-8444-444444444444'
function deferred() { let resolve; const promise = new Promise((yes) => { resolve = yes }); return { promise, resolve } }
function Location() { const location = useLocation(); return <output aria-label="URL actual">{location.pathname + location.search}</output> }
function mount({ request = vi.fn(async () => RAG_EVIDENCIA_SUFICIENTE), entry = '/consulta' } = {}) {
  const snapshot = { status: 'authenticated', principal: { id: 'cuenta-sintetica', roles: ['JURIDICO'] }, generation: 1 }
  const manager = { client: { request }, getSnapshot: () => snapshot, subscribe: () => () => {}, restore: vi.fn(), revalidate: vi.fn(async () => true) }
  render(<StrictMode><SessionProvider manager={manager}><MemoryRouter initialEntries={[entry]}><Location /><Routes><Route element={<RagLayout />}><Route path="/consulta" element={<RagQueryPage />} /><Route path="/documentos" element={<RagDocumentPage />} /></Route></Routes></MemoryRouter></SessionProvider></StrictMode>)
  return { request, manager }
}
async function ready() {
  const textarea = await screen.findByLabelText('Consulta en lenguaje natural')
  await waitFor(() => expect(textarea).toBeEnabled())
  return textarea
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('ROBUSTNESS: compositor de la consulta documental (DESIGN §16.6)', () => {
  it('Ctrl+Enter y Cmd+Enter envían; Enter solo agrega una línea sin enviar', async () => {
    const { request } = mount({ request: vi.fn(async () => RAG_SIN_EVIDENCIA) })
    const textarea = await ready()
    fireEvent.change(textarea, { target: { value: 'Consulta documental sintética' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(request).not.toHaveBeenCalled()
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true })
    await screen.findByText('Sin evidencia')
    expect(request).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true })
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2))
    expect(request.mock.calls[1][1].body).toEqual({ query: 'Consulta documental sintética' })
  })

  it('Ctrl+Enter durante una consulta en curso no crea una segunda operación', async () => {
    const response = deferred()
    const { request } = mount({ request: vi.fn(() => response.promise) })
    const textarea = await ready()
    fireEvent.change(textarea, { target: { value: 'Consulta documental sintética' } })
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true })
    await screen.findByText('Buscando en tus documentos autorizados…')
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true })
    expect(request).toHaveBeenCalledTimes(1)
    await act(async () => response.resolve(RAG_SIN_EVIDENCIA))
  })

  it('el contador aparece solo cerca del límite de 4096 caracteres', async () => {
    mount()
    const textarea = await ready()
    fireEvent.change(textarea, { target: { value: 'x'.repeat(3499) } })
    expect(screen.queryByText(/\/ 4,096/)).not.toBeInTheDocument()
    fireEvent.change(textarea, { target: { value: 'x'.repeat(3500) } })
    expect(screen.getByText('3,500 / 4,096')).toBeVisible()
  })

  it('una sugerencia rellena el compositor sin enviar ni mover el foco', async () => {
    const { request } = mount()
    await ready()
    const button = within(screen.getByRole('region', { name: 'Preguntas sugeridas' })).getAllByRole('button')[0]
    button.focus()
    fireEvent.click(button)
    expect(screen.getByLabelText('Consulta en lenguaje natural')).toHaveValue(button.textContent)
    expect(document.activeElement).toBe(button)
    expect(request).not.toHaveBeenCalled()
  })

  it('muestra el tiempo transcurrido desde 3 s y avisa de la demora a los 20 s', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    const response = deferred()
    mount({ request: vi.fn(() => response.promise) })
    const textarea = await ready()
    fireEvent.change(textarea, { target: { value: 'Consulta documental sintética' } })
    fireEvent.click(screen.getByRole('button', { name: 'Consultar' }))
    await screen.findByText('Buscando en tus documentos autorizados…')
    expect(screen.queryByText('2 s')).not.toBeInTheDocument()
    act(() => vi.advanceTimersByTime(3000))
    expect(screen.getByText('3 s')).toBeVisible()
    expect(screen.queryByText(/está tardando más de lo habitual/)).not.toBeInTheDocument()
    act(() => vi.advanceTimersByTime(17000))
    expect(screen.getByText(/está tardando más de lo habitual/)).toBeVisible()
    await act(async () => response.resolve(RAG_SIN_EVIDENCIA))
    expect(screen.queryByText(/está tardando más de lo habitual/)).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Consulta en curso' })).not.toBeInTheDocument()
  })

  it('Dejar de esperar descarta la respuesta tardía y explica que el servidor puede completarla', async () => {
    const response = deferred()
    const { request } = mount({ request: vi.fn(() => response.promise) })
    const textarea = await ready()
    fireEvent.change(textarea, { target: { value: 'Consulta documental sintética' } })
    fireEvent.click(screen.getByRole('button', { name: 'Consultar' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Dejar de esperar' }))
    expect(request.mock.calls[0][1].signal.aborted).toBe(true)
    expect(screen.getByText('Dejaste de esperar esta consulta. El sistema puede terminar de procesarla y la registrará en la auditoría.')).toBeVisible()
    await act(async () => response.resolve(RAG_EVIDENCIA_SUFICIENTE))
    expect(screen.queryByRole('region', { name: 'Respuesta generada' })).not.toBeInTheDocument()
    expect(screen.queryByText(RAG_EVIDENCIA_SUFICIENTE.fragments[0].fragment_text)).not.toBeInTheDocument()
    expect(textarea).toHaveValue('Consulta documental sintética')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('Nueva consulta limpia el compositor y le devuelve el foco', async () => {
    mount({ request: vi.fn(async () => RAG_SIN_EVIDENCIA) })
    const textarea = await ready()
    fireEvent.change(textarea, { target: { value: 'Consulta documental sintética' } })
    fireEvent.click(screen.getByRole('button', { name: 'Consultar' }))
    await screen.findByText('Sin evidencia')
    await userEvent.click(screen.getByRole('button', { name: 'Nueva consulta' }))
    expect(textarea).toHaveValue('')
    expect(textarea).toHaveFocus()
    expect(screen.queryByRole('region', { name: 'Resultado de la consulta' })).not.toBeInTheDocument()
  })

  it('Reformular consulta conserva el texto y enfoca el compositor', async () => {
    mount({ request: vi.fn(async () => RAG_SIN_EVIDENCIA) })
    const textarea = await ready()
    fireEvent.change(textarea, { target: { value: 'Consulta documental sintética' } })
    fireEvent.click(screen.getByRole('button', { name: 'Consultar' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Reformular consulta' }))
    expect(textarea).toHaveFocus()
    expect(textarea).toHaveValue('Consulta documental sintética')
  })
})

describe('ROBUSTNESS: respuesta con citas enlazadas', () => {
  async function answered() {
    mount()
    const textarea = await ready()
    fireEvent.change(textarea, { target: { value: 'Consulta documental sintética' } })
    fireEvent.click(screen.getByRole('button', { name: 'Consultar' }))
    return screen.findByRole('region', { name: 'Respuesta generada' })
  }

  it('la marca [E1] enfoca su fuente citada', async () => {
    const answer = await answered()
    const fragment = RAG_EVIDENCIA_SUFICIENTE.fragments[0]
    const mark = within(answer).getByRole('button', { name: `Ir a la fuente E1: ${fragment.document_name}` })
    expect(mark).toHaveTextContent('[E1]')
    await userEvent.click(mark)
    const source = screen.getByRole('article', { name: `Fuente E1: ${fragment.document_name}` })
    expect(source).toHaveFocus()
    expect(source).toHaveAttribute('id', `fuente-${fragment.fragment_id}`)
  })

  it('una marca sin cita correspondiente queda como texto, sin enlace inventado', async () => {
    const dto = { ...RAG_EVIDENCIA_SUFICIENTE, generated_response: 'Respuesta sintética [E1] y [E4].' }
    mount({ request: vi.fn(async () => dto) })
    const textarea = await ready()
    fireEvent.change(textarea, { target: { value: 'Consulta documental sintética' } })
    fireEvent.click(screen.getByRole('button', { name: 'Consultar' }))
    const answer = await screen.findByRole('region', { name: 'Respuesta generada' })
    expect(answer).toHaveTextContent('Respuesta sintética [E1] y [E4].')
    expect(within(answer).getAllByRole('button')).toHaveLength(1)
  })

  it('los identificadores de la cita quedan plegados en Detalle de la cita', async () => {
    await answered()
    const fragment = RAG_EVIDENCIA_SUFICIENTE.fragments[0]
    const source = screen.getByRole('article', { name: `Fuente E1: ${fragment.document_name}` })
    const details = within(source).getByText('Detalle de la cita').closest('details')
    expect(details).not.toHaveAttribute('open')
    expect(details).toHaveTextContent(fragment.fragment_id)
    expect(within(source).getByRole('link', { name: 'Abrir en el visor' })).toHaveAttribute('href', `/documentos?fragment_id=${fragment.fragment_id}`)
    expect(within(source).getByRole('link', { name: 'Abrir documento completo' }).getAttribute('href')).toMatch(/^\/documentos\?document_id=/)
  })
})

describe('SRS_REQUIRED: referencia contextual RF-048 sin datos en la URL', () => {
  it('muestra el nombre del hallazgo recibido en memoria de navegación y no lo envía ni lo escribe en la URL', async () => {
    const label = 'Exposición contractual — octubre 2026'
    const { request } = mount({ entry: { pathname: '/consulta', search: `?context_reference_id=${CONTEXT}&entity=Privado`, state: { contextLabel: label } } })
    const textarea = await ready()
    expect(screen.getByText(label)).toBeVisible()
    expect(screen.getByText(/no es evidencia ni selecciona documentos/)).toBeVisible()
    expect(screen.getByLabelText('URL actual')).toHaveTextContent(`/consulta?context_reference_id=${CONTEXT}`)
    expect(screen.getByLabelText('URL actual')).not.toHaveTextContent('Exposici')
    fireEvent.change(textarea, { target: { value: 'Consulta documental sintética' } })
    fireEvent.click(screen.getByRole('button', { name: 'Consultar' }))
    await screen.findByRole('region', { name: 'Respuesta generada' })
    expect(request.mock.calls[0][1].body).toEqual({ query: 'Consulta documental sintética', context_reference_id: CONTEXT })
  })

  it('un enlace directo sin memoria de navegación usa un texto genérico', async () => {
    mount({ entry: `/consulta?context_reference_id=${CONTEXT}` })
    await ready()
    expect(screen.getByText(/Consulta relacionada con un hallazgo del análisis/)).toBeVisible()
  })

  it('el nombre del hallazgo se ignora si no hay referencia contextual válida', async () => {
    mount({ entry: { pathname: '/consulta', search: '?context_reference_id=invalido', state: { contextLabel: 'Hallazgo sintético' } } })
    await ready()
    expect(screen.queryByText('Hallazgo sintético')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Quitar referencia' })).not.toBeInTheDocument()
  })
})

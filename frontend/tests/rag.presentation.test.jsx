import React, { StrictMode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { SessionProvider } from '../src/auth/SessionProvider.jsx'
import { ApiError } from '../src/api/errors.js'
import { RagLayout } from '../src/features/rag/state.jsx'
import { RagQueryPage, RagDocumentPage } from '../src/features/rag/pages.jsx'
import { RAG_EVIDENCIA_SUFICIENTE, RAG_SIN_EVIDENCIA, RAG_SIN_AUTORIZACION } from './e2e/helpers.js'

const explanations = {
  EVIDENCIA_INSUFICIENTE: 'Encontré información relacionada, pero la evidencia disponible no es suficiente para responder esta consulta con certeza. Puedes intentar especificar el documento, una fecha, una cláusula o el asunto que buscas.',
  SIN_EVIDENCIA: 'No encontré evidencia en los documentos a los que tienes acceso que permita responder esta pregunta. Puedes intentar indicar el nombre del documento, una fecha, una cláusula o el asunto que buscas.',
  SIN_AUTORIZACION: 'No puedo proporcionar información para esta consulta con tu nivel de acceso actual.',
}
function referenceDto() {
  return { ...RAG_EVIDENCIA_SUFICIENTE, state: 'EVIDENCIA_INSUFICIENTE', generation_status: 'NOT_REQUESTED', generated_response: null, safe_result_message: 'Mensaje DTO sintético anterior.', citations: [], fragments: RAG_EVIDENCIA_SUFICIENTE.fragments.map((fragment) => ({ ...fragment, usage: 'REFERENCE' })) }
}
function mount(dto = RAG_SIN_EVIDENCIA, request = vi.fn(async () => dto)) {
  const snapshot = { status: 'authenticated', principal: { id: 'cuenta-sintetica', roles: ['JURIDICO'] }, generation: 1 }
  const manager = { client: { request }, getSnapshot: () => snapshot, subscribe: () => () => {}, restore: vi.fn(), revalidate: vi.fn(async () => true) }
  render(<StrictMode><SessionProvider manager={manager}><MemoryRouter initialEntries={['/consulta']}><Routes><Route element={<RagLayout />}><Route path="/consulta" element={<RagQueryPage />} /><Route path="/documentos" element={<RagDocumentPage />} /></Route></Routes></MemoryRouter></SessionProvider></StrictMode>)
  return { request, manager }
}
async function submit(query = 'Consulta documental sintética') {
  const textarea = await screen.findByLabelText('Tu consulta')
  await waitFor(() => expect(textarea).toBeEnabled())
  fireEvent.change(textarea, { target: { value: query } })
  await userEvent.click(screen.getByRole('button', { name: 'Consultar', exact: true }))
  return textarea
}
function deferred() { let resolve; const promise = new Promise((yes) => { resolve = yes }); return { promise, resolve } }

describe('ROBUSTNESS: pregunta enviada y presentación de una interacción', () => {
  it('inicio no inventa bloques de una interacción todavía no enviada', async () => {
    mount(); await screen.findByRole('region', { name: 'Preguntas sugeridas' })
    expect(screen.queryByRole('heading', { name: 'Tú', exact: true })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Respuesta', exact: true })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /^Fuentes/ })).not.toBeInTheDocument()
  })

  it('Tú local usa entrada enviada y permanece igual al editar otro borrador', async () => {
    const { request } = mount()
    const textarea = await submit(' ¡Hola! ')
    const question = screen.getByRole('region', { name: 'Tu consulta enviada' })
    expect(within(question).getByText('¡Hola!')).toHaveTextContent('¡Hola!')
    expect(question.querySelector('p').textContent).toBe(' ¡Hola! ')
    fireEvent.change(textarea, { target: { value: 'Borrador sintético diferente' } })
    expect(question.querySelector('p').textContent).toBe(' ¡Hola! ')
    expect(screen.getByRole('status', { name: 'Respuesta local' })).toBeVisible()
    expect(screen.queryByRole('region', { name: 'Respuesta generada' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /^Fuentes/ })).not.toBeInTheDocument()
    expect(request).not.toHaveBeenCalled()
  })

  it('Tú RAG usa snapshot exacto de envío durante loading y después de editar borrador', async () => {
    const response = deferred()
    mount(undefined, vi.fn(() => response.promise))
    const query = ' \tConsulta documental sintética\n '
    const textarea = await submit(query)
    const question = screen.getByRole('region', { name: 'Tu consulta enviada' })
    expect(question.querySelector('p').textContent).toBe(query)
    expect(screen.getByText('Buscando en tus documentos autorizados…')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Dejar de esperar' })).toBeVisible()
    await act(async () => response.resolve(RAG_SIN_EVIDENCIA))
    await screen.findByText(explanations.SIN_EVIDENCIA)
    fireEvent.change(textarea, { target: { value: 'Borrador nuevo' } })
    expect(question.querySelector('p').textContent).toBe(query)
  })

  it('nuevo envío sustituye la pregunta anterior sin historial ni doble POST', async () => {
    const { request } = mount()
    await submit('Consulta documental A'); await screen.findByText(explanations.SIN_EVIDENCIA)
    await submit('Consulta documental B'); await screen.findByText(explanations.SIN_EVIDENCIA)
    expect(screen.getAllByRole('region', { name: 'Tu consulta enviada' })).toHaveLength(1)
    expect(screen.getByRole('region', { name: 'Tu consulta enviada' })).toHaveTextContent('Consulta documental B')
    expect(screen.queryByText('Consulta documental A')).not.toBeInTheDocument()
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls[1][1].body).toEqual({ query: 'Consulta documental B' })
  })

  it('entrada maliciosa enviada permanece texto sin HTML ejecutable', async () => {
    mount()
    const query = '<img src=x onerror=window.__hit=1>'
    await submit(query); await screen.findByText(explanations.SIN_EVIDENCIA)
    expect(screen.getByRole('region', { name: 'Tu consulta enviada' })).toHaveTextContent(query)
    expect(document.querySelector('[onerror]')).toBeNull()
  })

  it('error técnico con state null y mensaje null no inventa evidencia o respuesta', async () => {
    mount({ ...RAG_SIN_EVIDENCIA, state: null, operation_status: 'FAILED', generation_status: 'NOT_REQUESTED', safe_result_message: null })
    await submit()
    expect(await screen.findByRole('alert')).toHaveTextContent('El servicio no está disponible')
    expect(screen.getByRole('heading', { name: 'Respuesta', exact: true })).toBeVisible()
    expect(screen.queryByText(explanations.EVIDENCIA_INSUFICIENTE)).not.toBeInTheDocument()
    expect(screen.queryByText(explanations.SIN_EVIDENCIA)).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /^Fuentes/ })).not.toBeInTheDocument()
  })
})

describe('SRS_REQUIRED: estados canónicos, referencias y límites de exposición', () => {
  it.each([
    ['EVIDENCIA_INSUFICIENTE', 'Evidencia insuficiente', referenceDto()],
    ['SIN_EVIDENCIA', 'Sin evidencia', { ...RAG_SIN_EVIDENCIA, safe_result_message: 'Mensaje DTO sintético anterior.' }],
    ['SIN_AUTORIZACION', 'Sin autorización', RAG_SIN_AUTORIZACION],
  ])('%s conserva estado y presenta el copy aprobado una sola vez', async (state, label, dto) => {
    const { request } = mount(dto)
    await submit()
    expect(await screen.findByText(label, { exact: true })).toBeVisible()
    expect(screen.getAllByText(explanations[state], { exact: true })).toHaveLength(1)
    expect(screen.queryByText('Mensaje DTO sintético anterior.')).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Respuesta generada' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Fuentes citadas' })).not.toBeInTheDocument()
    expect(request).toHaveBeenCalledTimes(1)
    if (state !== 'EVIDENCIA_INSUFICIENTE') expect(screen.queryByRole('region', { name: 'Fuentes relacionadas' })).not.toBeInTheDocument()
  })

  it('Estado 2 conserva referencias y visor sin fabricar citas ni síntesis', async () => {
    const { request } = mount(referenceDto())
    await submit(); await screen.findByText(explanations.EVIDENCIA_INSUFICIENTE)
    const sources = screen.getByRole('region', { name: 'Fuentes relacionadas' })
    expect(within(sources).getByRole('heading', { name: 'Fuentes relacionadas (1)' })).toBeVisible()
    expect(within(sources).getByText('Referencia', { exact: true })).toBeVisible()
    expect(within(sources).queryByText(/\[E1\]/)).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Fuentes citadas' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Respuesta generada' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Editar consulta' })).toBeVisible()
    await userEvent.click(within(sources).getByRole('link', { name: 'Abrir en el visor' }))
    expect(await screen.findByRole('heading', { name: 'Visor documental' })).toBeVisible()
    expect(screen.getByText(referenceDto().fragments[0].fragment_text)).toBeVisible()
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('Estado 1 conserva síntesis, citas y los encabezados previos', async () => {
    mount(RAG_EVIDENCIA_SUFICIENTE); await submit()
    expect(await screen.findByRole('region', { name: 'Respuesta generada' })).toHaveTextContent(RAG_EVIDENCIA_SUFICIENTE.generated_response)
    const sources = screen.getByRole('region', { name: 'Fuentes citadas' })
    expect(within(sources).getByRole('heading', { name: 'Fuentes citadas (1)' })).toBeVisible()
    expect(sources).toHaveTextContent('[E1]')
    expect(within(sources).getByText('Evidencia', { exact: true })).toBeVisible()
    // «Editar consulta» se ofrece en cualquier resultado que no sea un fallo técnico.
    expect(screen.getByRole('button', { name: 'Editar consulta' })).toBeVisible()
    expect(screen.queryByText(explanations.EVIDENCIA_INSUFICIENTE)).not.toBeInTheDocument()
  })

  it('denegación DTO ignora respuesta, fuentes y metadatos defectuosos sin leakage', async () => {
    mount({ ...RAG_EVIDENCIA_SUFICIENTE, state: 'SIN_AUTORIZACION', safe_result_message: 'Documento restringido secreto', generated_response: 'Respuesta restringida secreta' })
    await submit(); await screen.findByText(explanations.SIN_AUTORIZACION)
    expect(screen.queryByText('Documento restringido secreto')).not.toBeInTheDocument()
    expect(screen.queryByText('Respuesta restringida secreta')).not.toBeInTheDocument()
    expect(screen.queryByText(RAG_EVIDENCIA_SUFICIENTE.fragments[0].document_name)).not.toBeInTheDocument()
    expect(screen.queryByText(RAG_EVIDENCIA_SUFICIENTE.fragments[0].fragment_text)).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Fuentes citadas' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Fuentes relacionadas' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Respuesta generada' })).not.toBeInTheDocument()
  })

  it.each([401, 403, 500])('HTTP%i sigue siendo error, sin explicación funcional inventada', async (status) => {
    mount(undefined, vi.fn(async () => { throw new ApiError(status) }))
    await submit()
    expect(await screen.findByRole('alert')).toBeVisible()
    for (const message of Object.values(explanations)) expect(screen.queryByText(message)).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Resultado de la consulta' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Fuentes citadas' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Fuentes relacionadas' })).not.toBeInTheDocument()
  })

  it('fallo provider conserva banner, mensaje técnico y fuentes sin copy de éxito insuficiente', async () => {
    mount({ ...referenceDto(), operation_status: 'FAILED', generation_status: 'FAILED', safe_result_message: 'Fallo técnico sintético controlado.' })
    await submit()
    expect(await screen.findByRole('alert')).toHaveTextContent('El servicio no está disponible')
    expect(screen.getByText('Evidencia insuficiente', { exact: true })).toBeVisible()
    expect(screen.getByText('Fallo técnico sintético controlado.')).toBeVisible()
    expect(screen.getByRole('region', { name: 'Fuentes relacionadas' })).toBeVisible()
    expect(screen.queryByText(explanations.EVIDENCIA_INSUFICIENTE)).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Respuesta generada' })).not.toBeInTheDocument()
    // F-14: tras un fallo técnico el reintento crea una operación nueva (la fallida no se reutiliza).
    expect(screen.getByRole('button', { name: 'Intentar de nuevo' })).toBeVisible()
    // Editar no remedia un fallo técnico; solo se ofrece el reintento.
    expect(screen.queryByRole('button', { name: 'Editar consulta' })).not.toBeInTheDocument()
  })

  it.each(['local', 'RAG'])('gate de foco oculta pregunta enviada y respuesta de %s sin borrar borrador', async (kind) => {
    const { manager, request } = mount()
    const textarea = await submit(kind === 'local' ? 'hola' : 'Consulta documental sintética')
    if (kind === 'RAG') await screen.findByText(explanations.SIN_EVIDENCIA)
    const verification = deferred()
    manager.revalidate.mockImplementation(() => verification.promise)
    fireEvent(window, new Event('focus'))
    expect(screen.queryByRole('region', { name: 'Tu consulta enviada' })).not.toBeInTheDocument()
    expect(screen.queryByRole('status', { name: 'Respuesta local' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Resultado de la consulta' })).not.toBeInTheDocument()
    expect(textarea).toHaveValue(kind === 'local' ? 'hola' : 'Consulta documental sintética')
    await act(async () => verification.resolve(true))
    expect(screen.getByRole('region', { name: 'Tu consulta enviada' })).toBeVisible()
    expect(request).toHaveBeenCalledTimes(kind === 'local' ? 0 : 1)
  })
})

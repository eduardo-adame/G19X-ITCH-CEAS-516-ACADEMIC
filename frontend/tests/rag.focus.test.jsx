import React, { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { SessionProvider } from '../src/auth/SessionProvider.jsx'
import { ApiError } from '../src/api/errors.js'
import { RagLayout } from '../src/features/rag/state.jsx'
import { RagDocumentPage, RagQueryPage } from '../src/features/rag/pages.jsx'
import { RAG_EVIDENCIA_SUFICIENTE } from './e2e/helpers.js'

const evidence = RAG_EVIDENCIA_SUFICIENTE.fragments[0].fragment_text
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function visibility(value) {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(value)
  fireEvent(document, new Event('visibilitychange'))
}
function mount(request = vi.fn(async () => RAG_EVIDENCIA_SUFICIENTE)) {
  let snapshot = { status: 'authenticated', principal: { id: 'cuenta-sintetica-a', roles: ['JURIDICO'] }, generation: 1 }
  const listeners = new Set()
  const manager = {
    client: { request }, getSnapshot: () => snapshot,
    subscribe(callback) { listeners.add(callback); return () => listeners.delete(callback) },
    restore: vi.fn(), revalidate: vi.fn(async () => true),
    update(next) { snapshot = { ...snapshot, ...next }; for (const callback of listeners) callback(snapshot) },
  }
  const view = render(<StrictMode><SessionProvider manager={manager}><MemoryRouter initialEntries={['/consulta']}><Routes><Route element={<RagLayout />}><Route path="/consulta" element={<RagQueryPage />} /><Route path="/documentos" element={<RagDocumentPage />} /></Route></Routes></MemoryRouter></SessionProvider></StrictMode>)
  return { manager, request, view }
}
async function submit(text = 'Consulta sintética A') {
  const textarea = await screen.findByLabelText('Tu consulta')
  await waitFor(() => expect(textarea).toBeEnabled())
  await userEvent.type(textarea, text)
  await userEvent.click(screen.getByRole('button', { name: 'Consultar' }))
  return textarea
}
afterEach(() => vi.restoreAllMocks())

describe('ROBUSTNESS: conservación de la consulta al cambiar foco', () => {
  it('conserva el borrador y su validación durante blur/hidden/visible sin POST', async () => {
    const { request } = mount()
    const textarea = await screen.findByLabelText('Tu consulta')
    await waitFor(() => expect(textarea).toBeEnabled())
    const draft = 'x'.repeat(4097)
    fireEvent.change(textarea, { target: { value: draft } })
    expect(textarea).toHaveValue(draft)
    fireEvent.submit(textarea.closest('form'))
    const alert = await screen.findByRole('alert')
    fireEvent(window, new Event('blur')); visibility('hidden')
    expect(textarea).toHaveValue(draft)
    expect(alert).toBeInTheDocument()
    visibility('visible'); fireEvent(window, new Event('focus'))
    await waitFor(() => expect(textarea).toBeEnabled())
    expect(textarea).toHaveValue(draft)
    expect(alert).toBeInTheDocument()
    expect(request).not.toHaveBeenCalled()
  })

  it('conserva resultado y formulario montado, suspendiendo evidencia hasta validar foco', async () => {
    const { manager, request } = mount()
    const textarea = await submit()
    await screen.findByText(evidence)
    fireEvent(window, new Event('blur')); visibility('hidden')
    expect(screen.getByText(evidence)).toBeVisible()
    const verification = deferred()
    manager.revalidate.mockImplementation(() => verification.promise)
    visibility('visible'); fireEvent(window, new Event('focus'))
    expect(screen.queryByText(evidence)).not.toBeInTheDocument()
    expect(screen.getByLabelText('Tu consulta')).toBe(textarea)
    expect(textarea).toHaveValue('Consulta sintética A')
    expect(textarea).toBeDisabled()
    await act(async () => verification.resolve(true))
    expect(await screen.findByText(evidence)).toBeVisible()
    expect(textarea).toBeEnabled()
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('conserva solicitud en curso, señal e identidad y no permite B mientras está ocupada', async () => {
    const response = deferred()
    const { manager, request } = mount(vi.fn(() => response.promise))
    const textarea = await submit()
    const options = request.mock.calls[0][1]
    const key = options.headers['Idempotency-Key']
    fireEvent(window, new Event('blur')); visibility('hidden')
    expect(options.signal.aborted).toBe(false)
    visibility('visible'); fireEvent(window, new Event('focus'))
    await waitFor(() => expect(manager.revalidate).toHaveBeenCalled())
    expect(textarea).toHaveValue('Consulta sintética A')
    expect(textarea).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Consultar' })).toBeDisabled()
    fireEvent.submit(textarea.closest('form'))
    expect(request).toHaveBeenCalledTimes(1)
    await act(async () => response.resolve(RAG_EVIDENCIA_SUFICIENTE))
    expect(await screen.findByText(evidence)).toBeVisible()
    expect(options.signal.aborted).toBe(false)
    expect(request.mock.calls[0][1].headers['Idempotency-Key']).toBe(key)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('respuesta tardía durante revalidación válida sólo aparece después del éxito', async () => {
    const response = deferred()
    const { manager, request } = mount(vi.fn(() => response.promise))
    const textarea = await submit()
    const verification = deferred()
    manager.revalidate.mockImplementation(() => verification.promise)
    fireEvent(window, new Event('focus'))
    await act(async () => response.resolve(RAG_EVIDENCIA_SUFICIENTE))
    expect(screen.queryByText(evidence)).not.toBeInTheDocument()
    expect(textarea).toHaveValue('Consulta sintética A')
    await act(async () => verification.resolve(true))
    expect(await screen.findByText(evidence)).toBeVisible()
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('conserva identidad de retry tras blur/hidden/focus sin repetición automática', async () => {
    const { request } = mount(vi.fn().mockRejectedValueOnce(new ApiError(0, { uncertain: true })).mockResolvedValue(RAG_EVIDENCIA_SUFICIENTE))
    await submit()
    await screen.findByRole('button', { name: 'Intentar de nuevo' })
    fireEvent(window, new Event('blur')); visibility('hidden'); visibility('visible'); fireEvent(window, new Event('focus'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Consultar' })).toBeEnabled())
    expect(request).toHaveBeenCalledTimes(1)
    await userEvent.click(screen.getByRole('button', { name: 'Intentar de nuevo' }))
    await screen.findByText(evidence)
    expect(request.mock.calls[1][1].headers['Idempotency-Key']).toBe(request.mock.calls[0][1].headers['Idempotency-Key'])
  })

  it('conserva el fragmento del visor tras blur/hidden/focus sin POST adicional', async () => {
    const { request } = mount()
    await submit(); await screen.findByText(evidence)
    await userEvent.click(screen.getByRole('link', { name: 'Abrir en el visor' }))
    await screen.findByRole('heading', { name: 'Visor documental' })
    fireEvent(window, new Event('blur')); visibility('hidden'); visibility('visible'); fireEvent(window, new Event('focus'))
    expect(await screen.findByText(evidence)).toBeVisible()
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('clear permite B y descarta A tardía aunque el transporte ignore abort', async () => {
    const first = deferred(), second = deferred()
    const { request } = mount(vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise))
    await submit()
    const signalA = request.mock.calls[0][1].signal
    await userEvent.click(screen.getByRole('button', { name: 'Dejar de esperar' }))
    expect(signalA.aborted).toBe(true)
    expect(screen.getByText(/Dejaste de esperar esta consulta/)).toBeVisible()
    // Dejar de esperar conserva el texto para poder reformularlo.
    expect(screen.getByLabelText('Tu consulta')).toHaveValue('Consulta sintética A')
    await userEvent.clear(screen.getByLabelText('Tu consulta'))
    await submit('Consulta sintética B')
    const resultB = { ...RAG_EVIDENCIA_SUFICIENTE, generated_response: 'Respuesta sintética B [E1].' }
    await act(async () => second.resolve(resultB))
    expect(await screen.findByRole('region', { name: 'Respuesta generada' })).toHaveTextContent('Respuesta sintética B [E1].')
    await act(async () => first.resolve(RAG_EVIDENCIA_SUFICIENTE))
    expect(screen.getByRole('region', { name: 'Respuesta generada' })).toHaveTextContent('Respuesta sintética B [E1].')
    expect(document.body.textContent).not.toContain('Respuesta generada sintética')
    expect(screen.getByLabelText('Tu consulta')).toHaveValue('Consulta sintética B')
    expect(request.mock.calls[1][1].headers['Idempotency-Key']).not.toBe(request.mock.calls[0][1].headers['Idempotency-Key'])
  })

  it('unmount aborta A e impide que su respuesta llegue a una consulta nueva', async () => {
    const response = deferred()
    const first = mount(vi.fn(() => response.promise))
    await submit()
    const signal = first.request.mock.calls[0][1].signal
    first.view.unmount()
    expect(signal.aborted).toBe(true)
    const next = mount()
    await screen.findByLabelText('Tu consulta')
    await act(async () => response.resolve(RAG_EVIDENCIA_SUFICIENTE))
    expect(screen.queryByText(evidence)).not.toBeInTheDocument()
    expect(next.request).not.toHaveBeenCalled()
  })
})

describe('SRS_REQUIRED: autorización vigente durante retorno al foco', () => {
  it.each(['denegada', 'rechazada'])('revalidación %s retira evidencia y aborta la solicitud pendiente', async (outcome) => {
    const response = deferred()
    const { manager, request } = mount(vi.fn(() => response.promise))
    await submit()
    const verification = deferred()
    manager.revalidate.mockImplementation(() => verification.promise)
    fireEvent(window, new Event('focus'))
    await act(async () => response.resolve(RAG_EVIDENCIA_SUFICIENTE))
    expect(screen.queryByText(evidence)).not.toBeInTheDocument()
    await act(async () => outcome === 'denegada' ? verification.resolve(false) : verification.reject(new ApiError(503)))
    expect(await screen.findByRole('region', { name: 'Preguntas sugeridas' })).toBeVisible()
    expect(screen.queryByText(evidence)).not.toBeInTheDocument()
    expect(request.mock.calls[0][1].signal.aborted).toBe(true)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('denegación antes de recibir A ignora la respuesta tardía y no crea retry', async () => {
    const response = deferred()
    const { manager, request } = mount(vi.fn(() => response.promise))
    await submit()
    manager.revalidate.mockResolvedValue(false)
    fireEvent(window, new Event('focus'))
    await screen.findByRole('region', { name: 'Preguntas sugeridas' })
    await act(async () => response.resolve(RAG_EVIDENCIA_SUFICIENTE))
    expect(screen.queryByText(evidence)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Intentar de nuevo' })).not.toBeInTheDocument()
    expect(request).toHaveBeenCalledTimes(1)
  })

  it.each(['logout', 'usuario', 'revocación'])('%s elimina borrador y evidencia e invalida A tardía', async (change) => {
    const response = deferred()
    const { manager, request } = mount(vi.fn(() => response.promise))
    await submit()
    const update = change === 'logout' ? { status: 'anonymous', principal: null, generation: 2 }
      : change === 'usuario' ? { principal: { id: 'cuenta-sintetica-b', roles: ['JURIDICO'] } } : { generation: 2 }
    act(() => manager.update(update))
    const textarea = await screen.findByLabelText('Tu consulta')
    expect(textarea).toHaveValue('')
    expect(request.mock.calls[0][1].signal.aborted).toBe(true)
    await act(async () => response.resolve(RAG_EVIDENCIA_SUFICIENTE))
    expect(screen.queryByText(evidence)).not.toBeInTheDocument()
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('una revalidación vieja exitosa no abre evidencia mientras la actual sigue pendiente', async () => {
    const { manager } = mount()
    await submit(); await screen.findByText(evidence)
    const old = deferred(), current = deferred()
    manager.revalidate.mockImplementation(() => old.promise)
    fireEvent(window, new Event('focus'))
    await act(async () => {})
    manager.revalidate.mockImplementation(() => current.promise)
    fireEvent(window, new Event('focus'))
    await act(async () => old.resolve(true))
    expect(screen.queryByText(evidence)).not.toBeInTheDocument()
    await act(async () => current.resolve(false))
    expect(await screen.findByRole('region', { name: 'Preguntas sugeridas' })).toBeVisible()
    expect(screen.queryByText(evidence)).not.toBeInTheDocument()
  })
})

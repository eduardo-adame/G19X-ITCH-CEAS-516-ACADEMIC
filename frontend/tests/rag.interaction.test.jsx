import React, { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { SessionProvider } from '../src/auth/SessionProvider.jsx'
import { classifyLocalInteraction, getLocalInteraction, suggestedQuestions } from '../src/features/rag/localInteraction.js'
import { RagLayout, useRag } from '../src/features/rag/state.jsx'
import { RagQueryPage, RagDocumentPage } from '../src/features/rag/pages.jsx'
import { RAG_SIN_EVIDENCIA, RAG_EVIDENCIA_SUFICIENTE } from './e2e/helpers.js'

const inputs = [
  ['hola', 'GREETING'], ['Hola!', 'GREETING'], [' ¡HOLA! ', 'GREETING'],
  ['buenos días', 'GREETING'], ['buenos di\u0301as', 'GREETING'], ['buenas tardes.', 'GREETING'],
  ['buenas noches', 'GREETING'], ['qué tal', 'GREETING'], ['que tal?', 'GREETING'],
  ['ayuda', 'HELP'], ['¿qué puedes hacer?', 'HELP'], ['que puedes hacer', 'HELP'],
  ['cómo funciona', 'HELP'], ['como funciona', 'HELP'], ['cómo puedo consultar', 'HELP'], ['como puedo consultar', 'HELP'],
  ['gracias', 'THANKS'], ['muchas gracias!', 'THANKS'], ['perfecto gracias', 'THANKS'],
]
const documentary = [
  'Hola, ¿qué obligaciones contiene el contrato Alfa?', 'gracias, ¿qué fechas contiene el contrato?',
  'ayuda con el contrato', 'cómo funciona la cláusula', 'qué puedes hacer con el documento Alfa',
  'hola contrato', 'muchas gracias por el contrato Alfa', 'capital de Japón', 'contrato',
  '¿Cuál es la capital de Japón?', '<script>hola</script>', 'holanda', 'hola\nayuda',
]
function deferred() { let resolve; const promise = new Promise((yes) => { resolve = yes }); return { promise, resolve } }
function mount(request = vi.fn(async () => RAG_SIN_EVIDENCIA), path = '/consulta') {
  let snapshot = { status: 'authenticated', principal: { id: 'cuenta-a', roles: ['JURIDICO'] }, generation: 1 }
  const listeners = new Set(), current = { rag: null }
  const manager = {
    client: { request }, getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    restore: vi.fn(), revalidate: vi.fn(async () => true),
    update(next) { snapshot = { ...snapshot, ...next }; for (const listener of listeners) listener(snapshot) },
  }
  function Probe({ children }) { current.rag = useRag(); return children }
  const view = render(<StrictMode><SessionProvider manager={manager}><MemoryRouter initialEntries={[path]}><Routes><Route element={<RagLayout />}><Route path="/consulta" element={<Probe><RagQueryPage /></Probe>} /><Route path="/documentos" element={<Probe><RagDocumentPage /></Probe>} /></Route></Routes></MemoryRouter></SessionProvider></StrictMode>)
  return { request, manager, current, view }
}
async function submit(query) {
  const textarea = await screen.findByLabelText('Tu consulta')
  await waitFor(() => expect(textarea).toBeEnabled())
  fireEvent.change(textarea, { target: { value: query } })
  await userEvent.click(screen.getByRole('button', { name: 'Consultar', exact: true }))
  return textarea
}
afterEach(() => vi.restoreAllMocks())

describe('ROBUSTNESS: router local conservador', () => {
  it.each(inputs)('clasifica la entrada completa %s como %s', (query, kind) => { expect(classifyLocalInteraction(query)).toBe(kind); expect(getLocalInteraction(query)).toMatchObject({ kind, message: expect.any(String) }) })
  it.each(documentary)('mantiene RAG ante consulta o ambigüedad: %s', (query) => { expect(classifyLocalInteraction(query)).toBe('RAG'); expect(getLocalInteraction(query)).toBeNull() })
  it('no depende del corpus ni transforma la consulta original', () => {
    const query = '  ¿QUE\u0301 PUEDES HACER?  '
    expect(classifyLocalInteraction(query)).toBe('HELP')
    expect(query).toBe('  ¿QUE\u0301 PUEDES HACER?  ')
    expect(suggestedQuestions).toHaveLength(4)
    expect(Object.isFrozen(suggestedQuestions)).toBe(true)
  })
})

describe('ROBUSTNESS: respuestas locales y sugerencias', () => {
  it.each([['hola', 'GREETING'], ['qué puedes hacer', 'HELP'], ['gracias', 'THANKS']])('%s responde sin red, identidad ni lifecycle RAG', async (query, kind) => {
    const { request, current } = mount()
    const uuid = vi.spyOn(globalThis.crypto, 'randomUUID')
    const textarea = await submit(query)
    const region = screen.getByRole('status', { name: 'Respuesta local' })
    expect(region).toHaveTextContent(getLocalInteraction(query).message.replace(/\s+/g, ' '))
    expect(current.rag.local).toMatchObject({ query, kind })
    expect(current.rag.local).not.toHaveProperty('state')
    expect(current.rag.local).not.toHaveProperty('operationId')
    expect(current.rag.result).toBeNull()
    expect(current.rag.submission).toBeNull()
    expect(current.rag.busy).toBe(false)
    expect(request).not.toHaveBeenCalled()
    expect(uuid).not.toHaveBeenCalled()
    expect(textarea).toHaveValue(query)
    expect(screen.queryByText('Buscando en tus documentos autorizados…')).not.toBeInTheDocument()
    expect(screen.queryByText('Sin evidencia')).not.toBeInTheDocument()
  })

  it('cuatro sugerencias iniciales prefillean sin enviar y permiten editar/borrar', async () => {
    const { request } = mount()
    const suggestions = await screen.findByRole('region', { name: 'Preguntas sugeridas' })
    const buttons = within(suggestions).getAllByRole('button')
    expect(buttons.map((button) => button.textContent)).toEqual(suggestedQuestions)
    const textarea = screen.getByLabelText('Tu consulta')
    for (const button of buttons) { await userEvent.click(button); expect(textarea).toHaveValue(button.textContent); expect(request).not.toHaveBeenCalled() }
    await userEvent.clear(textarea); await userEvent.type(textarea, 'Consulta documental editada')
    await userEvent.click(screen.getByRole('button', { name: 'Consultar', exact: true }))
    expect(await screen.findByText('Sin evidencia')).toBeVisible()
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0][1].body).toEqual({ query: 'Consulta documental editada' })
    expect(screen.queryByRole('region', { name: 'Preguntas sugeridas' })).not.toBeInTheDocument()
  })

  it('activar una sugerencia con teclado no envía ni roba foco', async () => {
    const { request } = mount()
    const suggestions = await screen.findByRole('region', { name: 'Preguntas sugeridas' })
    const button = within(suggestions).getAllByRole('button')[0]
    button.focus(); await userEvent.keyboard('{Enter}')
    expect(button).toHaveFocus()
    expect(screen.getByLabelText('Tu consulta')).toHaveValue(suggestedQuestions[0])
    expect(request).not.toHaveBeenCalled()
  })

  it.each(['', ' ', '\t\n', '\u00a0', '\u0085\u001c\u001f', 'hola'.repeat(1025), `hola${' '.repeat(4093)}`])('valida vacío/blanco/límite antes de clasificar (%j)', async (query) => {
    const { request, current } = mount()
    const textarea = await screen.findByLabelText('Tu consulta')
    await waitFor(() => expect(textarea).toBeEnabled())
    fireEvent.change(textarea, { target: { value: query } }); fireEvent.submit(textarea.closest('form'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Revisa los datos de la solicitud')
    expect(current.rag.local).toBeNull()
    expect(request).not.toHaveBeenCalled()
    expect(textarea).toHaveValue(query)
  })

  it('4096 puntos que normalizan a hola son locales sin saltar el límite', async () => {
    const { request } = mount()
    const query = `hola${' '.repeat(4092)}`
    await submit(query)
    expect(screen.getByRole('status', { name: 'Respuesta local' })).toBeVisible()
    expect(request).not.toHaveBeenCalled()
  })

  it('la consulta ambigua conserva texto, contexto y un POST independiente', async () => {
    const context = '44444444-4444-4444-8444-444444444444'
    const { request } = mount(undefined, `/consulta?context_reference_id=${context}`)
    const query = '  Hola, ¿que\u0301 obligaciones contiene el contrato Alfa?  '
    await submit(query)
    expect(await screen.findByText('Sin evidencia')).toBeVisible()
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0][1].body).toEqual({ query, context_reference_id: context })
    expect(screen.queryByRole('status', { name: 'Respuesta local' })).not.toBeInTheDocument()
  })

  it('blancos Unicode alrededor de texto documental se conservan en el payload', async () => {
    const { request } = mount()
    const query = '\u0085contrato\u001f'
    await submit(query)
    expect(await screen.findByText('Sin evidencia')).toBeVisible()
    expect(request.mock.calls[0][1].body).toEqual({ query })
  })

  it.each([['FEFF', '\ufeff'], ['espacio de ancho cero', '\u200b']])('%s no es blanco de Python: usa RAG y conserva el payload', async (_name, query) => {
    const { request, current } = mount()
    await submit(query)
    expect(await screen.findByText('Sin evidencia')).toBeVisible()
    expect(current.rag.local).toBeNull()
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0][1].body).toEqual({ query })
  })

  it('blanco inválido no elimina una respuesta anterior ni crea una operación', async () => {
    const { request } = mount()
    await submit('hola')
    await submit('   ')
    expect(screen.getByRole('status', { name: 'Respuesta local' })).toBeVisible()
    expect(screen.getByRole('alert')).toHaveTextContent('Revisa los datos de la solicitud')
    expect(request).not.toHaveBeenCalled()
  })

  it('limpiar elimina respuesta local y devuelve las cuatro sugerencias', async () => {
    mount(); await submit('hola')
    await userEvent.click(screen.getByRole('button', { name: 'Nueva consulta' }))
    expect(screen.queryByRole('status', { name: 'Respuesta local' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Tu consulta')).toHaveValue('')
    expect(screen.getByRole('region', { name: 'Preguntas sugeridas' })).toBeVisible()
  })

  it('blur/hidden conservan local y foco valida sin POST ni nueva respuesta', async () => {
    const { manager, request, current } = mount()
    const textarea = await submit('hola')
    const original = current.rag.local
    fireEvent(window, new Event('blur'))
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    fireEvent(document, new Event('visibilitychange'))
    expect(current.rag.local).toBe(original)
    const verification = deferred()
    manager.revalidate.mockImplementation(() => verification.promise)
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    fireEvent(document, new Event('visibilitychange')); fireEvent(window, new Event('focus'))
    expect(screen.queryByRole('status', { name: 'Respuesta local' })).not.toBeInTheDocument()
    expect(textarea).toHaveValue('hola')
    await act(async () => verification.resolve(true))
    expect(screen.getByRole('status', { name: 'Respuesta local' })).toBeVisible()
    expect(current.rag.local).toBe(original)
    expect(request).not.toHaveBeenCalled()
  })

  it('transición RAG→local elimina evidencia y local→RAG no envía historial', async () => {
    const { request } = mount(vi.fn().mockResolvedValueOnce(RAG_EVIDENCIA_SUFICIENTE).mockResolvedValue(RAG_SIN_EVIDENCIA))
    await submit('Consulta documental A'); await screen.findByText(RAG_EVIDENCIA_SUFICIENTE.fragments[0].fragment_text)
    await submit('gracias')
    expect(screen.queryByText(RAG_EVIDENCIA_SUFICIENTE.fragments[0].fragment_text)).not.toBeInTheDocument()
    expect(screen.getByRole('status', { name: 'Respuesta local' })).toBeVisible()
    expect(request).toHaveBeenCalledTimes(1)
    await submit('Consulta documental B')
    expect(await screen.findByText('Sin evidencia')).toBeVisible()
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls[1][1].body).toEqual({ query: 'Consulta documental B' })
    expect(request.mock.calls[1][1].headers['Idempotency-Key']).not.toBe(request.mock.calls[0][1].headers['Idempotency-Key'])
    expect(screen.queryByRole('status', { name: 'Respuesta local' })).not.toBeInTheDocument()
  })

  it('limpieza y local invalidan A tardía incluso si el transporte ignora abort', async () => {
    const response = deferred()
    const { current, request } = mount(vi.fn(() => response.promise))
    await submit('Consulta documental A')
    const signal = request.mock.calls[0][1].signal
    act(() => { current.rag.clear(); current.rag.submit('hola') })
    expect(signal.aborted).toBe(true)
    await act(async () => response.resolve(RAG_EVIDENCIA_SUFICIENTE))
    expect(screen.getByRole('status', { name: 'Respuesta local' })).toBeVisible()
    expect(screen.queryByText(RAG_EVIDENCIA_SUFICIENTE.fragments[0].fragment_text)).not.toBeInTheDocument()
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('desmontaje no restaura local al iniciar otra consulta', async () => {
    const first = mount(); await submit('hola'); first.view.unmount()
    mount(); await screen.findByRole('region', { name: 'Preguntas sugeridas' })
    expect(screen.queryByRole('status', { name: 'Respuesta local' })).not.toBeInTheDocument()
  })

  it('respuestas locales no persisten consultas ni escriben storage', async () => {
    const storage = vi.spyOn(Storage.prototype, 'setItem')
    mount(); await submit('hola'); await submit('ayuda'); await submit('gracias')
    expect(storage).not.toHaveBeenCalled()
  })
})

describe('SRS_REQUIRED: retiro de estados locales y evidencia por autorización', () => {
  it.each(['logout', 'usuario', 'revocación'])('%s elimina local y consulta antes de otra interacción', async (change) => {
    const { manager, current, request } = mount()
    await submit('hola')
    const update = change === 'logout' ? { status: 'anonymous', principal: null, generation: 2 }
      : change === 'usuario' ? { principal: { id: 'cuenta-b', roles: ['JURIDICO'] } } : { generation: 2 }
    act(() => manager.update(update))
    await screen.findByLabelText('Tu consulta')
    expect(current.rag.local).toBeNull()
    expect(screen.queryByRole('status', { name: 'Respuesta local' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Tu consulta')).toHaveValue('')
    expect(request).not.toHaveBeenCalled()
  })

  it('revalidación denegada retira local sin consultar RAG', async () => {
    const { manager, request } = mount()
    await submit('hola')
    manager.revalidate.mockResolvedValue(false)
    fireEvent(window, new Event('focus'))
    expect(await screen.findByRole('region', { name: 'Preguntas sugeridas' })).toBeVisible()
    expect(screen.queryByRole('status', { name: 'Respuesta local' })).not.toBeInTheDocument()
    expect(request).not.toHaveBeenCalled()
  })

  it('una respuesta local no hidrata fragmentos en el visor', async () => {
    const { current, request } = mount(undefined, '/documentos?fragment_id=33333333-3333-4333-8333-333333333333')
    await screen.findByText('No hay un fragmento disponible')
    act(() => current.rag.submit('hola'))
    expect(screen.getByText('No hay un fragmento disponible')).toBeVisible()
    expect(current.rag.result).toBeNull()
    expect(request).not.toHaveBeenCalled()
  })
})

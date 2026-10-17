import React, { StrictMode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { SessionProvider } from '../src/auth/SessionProvider.jsx'
import { createRagSubmission, requestRag } from '../src/features/rag/api.js'
import { RagLayout } from '../src/features/rag/state.jsx'
import { RagQueryPage } from '../src/features/rag/pages.jsx'
import { RAG_SIN_EVIDENCIA } from './e2e/helpers.js'

const key = '11111111-1111-4111-8111-111111111111'
const context = '44444444-4444-4444-8444-444444444444'
const alphabets = [['ASCII', 'a'], ['ñ precompuesta', 'ñ'], ['emoji', '😀']]
const lengths = [4095, 4096, 4097]
const matrix = alphabets.flatMap(([name, character]) => lengths.map((length) => [name, length, character.repeat(length)]))
const mixed = [
  ['mixta MAX-1', `${'a'.repeat(4094)}😀`, true],
  ['mixta MAX', `${'a'.repeat(4095)}😀`, true],
  ['mixta MAX+1', `${'a'.repeat(4096)}😀`, false],
  ['combinante MAX', 'n\u0303'.repeat(2048), true],
  ['combinante MAX+1', `${'n\u0303'.repeat(2048)}n`, false],
]

function mount() {
  const request = vi.fn(async () => RAG_SIN_EVIDENCIA)
  const snapshot = { status: 'authenticated', principal: { id: key, roles: ['JURIDICO'] }, generation: 1 }
  const manager = { client: { request }, getSnapshot: () => snapshot, subscribe: () => () => {}, restore: vi.fn(), revalidate: vi.fn(async () => true) }
  render(<StrictMode><SessionProvider manager={manager}><MemoryRouter initialEntries={['/consulta']}><Routes><Route element={<RagLayout />}><Route path="/consulta" element={<RagQueryPage />} /></Route></Routes></MemoryRouter></SessionProvider></StrictMode>)
  return request
}

describe('ROBUSTNESS: límite RAG de 4096 puntos de código Unicode', () => {
  it.each(matrix)('%s con %i puntos conserva el texto válido o rechaza antes de transporte', async (_name, length, query) => {
    const client = { request: vi.fn(async () => RAG_SIN_EVIDENCIA) }
    const submission = { key, payload: { query, context_reference_id: context } }
    if (length <= 4096) {
      const created = createRagSubmission(query, context, key)
      expect(created.payload.query).toBe(query)
      expect(created.key).toBe(key)
      await requestRag(client, created)
      expect(client.request).toHaveBeenCalledTimes(1)
      expect(client.request.mock.calls[0][1].body).toEqual(submission.payload)
      expect(client.request.mock.calls[0][1].headers['Idempotency-Key']).toBe(key)
    } else {
      expect(() => createRagSubmission(query, context, key)).toThrow(expect.objectContaining({ status: 422 }))
      await expect(requestRag(client, submission)).rejects.toMatchObject({ status: 422 })
      expect(client.request).not.toHaveBeenCalled()
    }
  })

  it.each(mixed)('%s cuenta cada punto sin normalizar ni truncar', async (_name, query, accepted) => {
    const client = { request: vi.fn(async () => RAG_SIN_EVIDENCIA) }
    if (accepted) {
      const submission = createRagSubmission(query, null, key)
      expect(submission.payload.query).toBe(query)
      await requestRag(client, submission)
      expect(client.request.mock.calls[0][1].body.query).toBe(query)
    } else {
      await expect(requestRag(client, { key, payload: { query } })).rejects.toMatchObject({ status: 422 })
      expect(client.request).not.toHaveBeenCalled()
    }
  })

  it('conserva espacios y representación combinante de una consulta válida', () => {
    const query = ' \tn\u0303 😀\n '
    expect(createRagSubmission(query, null, key).payload.query).toBe(query)
  })

  it.each([null, 123, '', []])('rechaza entrada inválida sin transporte (%j)', async (query) => {
    const client = { request: vi.fn() }
    await expect(requestRag(client, { key, payload: { query } })).rejects.toMatchObject({ status: 422 })
    expect(client.request).not.toHaveBeenCalled()
  })

  it.each(matrix)('formulario %s con %i puntos permite texto exacto y aplica el límite antes de POST', async (_name, length, query) => {
    const request = mount()
    const textarea = await screen.findByLabelText('Tu consulta')
    await waitFor(() => expect(textarea).toBeEnabled())
    fireEvent.change(textarea, { target: { value: query } })
    expect(textarea).toHaveValue(query)
    await userEvent.click(screen.getByRole('button', { name: 'Consultar' }))
    if (length <= 4096) {
      expect(await screen.findByText('Sin evidencia')).toBeVisible()
      expect(request).toHaveBeenCalledTimes(1)
      expect(request.mock.calls[0][1].body.query).toBe(query)
    } else {
      expect(await screen.findByRole('alert')).toHaveTextContent('Revisa los datos de la solicitud')
      expect(request).not.toHaveBeenCalled()
    }
    expect(textarea).toHaveValue(query)
  })
})

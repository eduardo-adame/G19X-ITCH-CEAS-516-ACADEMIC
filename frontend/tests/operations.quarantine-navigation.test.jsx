import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { SessionProvider } from '../src/auth/SessionProvider.jsx'
import { QuarantinePage } from '../src/features/operations/QuarantinePage.jsx'
import { quarantineCauseItem } from './fixtures/quarantineCauses.js'
import { localDayBoundary } from '../src/shared/presentation.js'

const fileA = '11111111-1111-4111-8111-111111111111'
const fileB = '22222222-2222-4222-8222-222222222222'
function Navigation() {
  const location = useLocation(); const navigate = useNavigate()
  return <><output aria-label="Consulta actual">{location.search}</output><button onClick={() => navigate(-1)}>Atrás de prueba</button><button onClick={() => navigate(1)}>Adelante de prueba</button></>
}
function mount(initial = '/cuarentena') {
  const client = { abortAll: vi.fn(), acquireRead: vi.fn((path) => {
    const query = new URLSearchParams(path.split('?')[1])
    const row = { ...quarantineCauseItem('FORMAT_MISMATCH', 'Formato incompatible'), ingest_file_id: query.get('ingest_file_id') || fileA }
    return { promise: Promise.resolve({ items: [row], next_cursor: null }), release: vi.fn() }
  }) }
  const snapshot = { status: 'authenticated', principal: { id: fileA, username: 'cuenta-sintetica', roles: ['TI'] }, generation: 1 }
  const manager = { client, getSnapshot: () => snapshot, subscribe: () => () => {}, restore: vi.fn(), revalidate: vi.fn(async () => true) }
  render(<SessionProvider manager={manager}><MemoryRouter initialEntries={[initial]}><Navigation /><QuarantinePage /></MemoryRouter></SessionProvider>)
  return client
}
async function consistent(client, id) {
  await waitFor(() => {
    expect(screen.getByLabelText('Archivo de origen (identificador)')).toHaveValue(id)
    expect(new URLSearchParams(screen.getByLabelText('Consulta actual').textContent).get('ingest_file_id') || '').toBe(id)
    expect(new URLSearchParams(client.acquireRead.mock.calls.at(-1)[0].split('?')[1]).get('ingest_file_id') || '').toBe(id)
  })
}
// El identificador está en «Más filtros» y se aplica con Enter (o tras una pausa al escribir).
async function setFile(id) {
  const more = screen.getByRole('button', { name: /Más filtros/ })
  if (more.getAttribute('aria-expanded') === 'false') fireEvent.click(more)
  const input = screen.getByLabelText('Archivo de origen (identificador)')
  fireEvent.change(input, { target: { value: id } })
  fireEvent.keyDown(input, { key: 'Enter' })
}

describe('SRS_REQUIRED: URL autoritativa en navegación de cuarentena', () => {
  it('mantiene URL, entrada y consulta iguales en A → B → Atrás → Adelante', async () => {
    const client = mount(); await screen.findByText('Formato incompatible')
    await setFile(fileA); await consistent(client, fileA)
    await setFile(fileB); await consistent(client, fileB)
    await userEvent.click(screen.getByRole('button', { name: 'Atrás de prueba' })); await consistent(client, fileA)
    await userEvent.click(screen.getByRole('button', { name: 'Adelante de prueba' })); await consistent(client, fileB)
  })
  it('restaura también las fechas de rechazo al navegar en el historial', async () => {
    mount(`/cuarentena?rejected_from=${encodeURIComponent(localDayBoundary('2030-01-01'))}`); await screen.findByText('Formato incompatible')
    fireEvent.change(screen.getByLabelText('Retenido desde'), { target: { value: '2030-02-01' } })
    await waitFor(() => expect(new URLSearchParams(screen.getByLabelText('Consulta actual').textContent).get('rejected_from')).toBe(localDayBoundary('2030-02-01')))
    await userEvent.click(screen.getByRole('button', { name: 'Atrás de prueba' }))
    await waitFor(() => expect(screen.getByLabelText('Retenido desde')).toHaveValue('2030-01-01'))
    await userEvent.click(screen.getByRole('button', { name: 'Adelante de prueba' }))
    await waitFor(() => expect(screen.getByLabelText('Retenido desde')).toHaveValue('2030-02-01'))
  })
})
describe('ROBUSTNESS: validación de filtros sin alterar el destino', () => {
  it('no consulta un UUID inválido ni reemplaza silenciosamente el filtro válido', async () => {
    const client = mount(`/cuarentena?ingest_file_id=${fileA}`); await screen.findByText('Formato incompatible')
    const before = client.acquireRead.mock.calls.length
    await setFile('no-es-uuid')
    expect(await screen.findByRole('alert')).toHaveTextContent('Pega el identificador completo')
    expect(screen.getByLabelText('Archivo de origen (identificador)')).toHaveAttribute('aria-invalid', 'true')
    await new Promise((resolve) => setTimeout(resolve, 450))
    expect(client.acquireRead).toHaveBeenCalledTimes(before)
    expect(new URLSearchParams(screen.getByLabelText('Consulta actual').textContent).get('ingest_file_id')).toBe(fileA)
  })
})

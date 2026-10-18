import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { SessionProvider } from '../src/auth/SessionProvider.jsx'
import { QuarantinePage } from '../src/features/operations/QuarantinePage.jsx'
import { conflictComparison, quarantinePage, recordLocation } from '../src/features/operations/adapters.js'

const ownId = '11111111-1111-4111-8111-111111111111'
const conflictId = '22222222-2222-4222-8222-222222222222'
const sheetId = '33333333-3333-4333-8333-333333333333'
const conflict = {
  id: conflictId, ingest_file_id: ownId, source_record_id: ownId, row_number: 2, source_family: 'CONTRATOS_DOCUMENTOS', created_at: '2030-01-01T00:00:00Z',
  cause_code: 'IDENTITY_CONFLICT', cause_description: 'Conflicto de identidad', state: 'Pendiente',
  // El vigente llega con los nombres de columna del almacenamiento; el recibido, con los del contrato de datos.
  original_payload: { id_contrato: 'C-1', estado_revision: 'En revisión', fecha_firma: null, payload_sha256: 'ab12', source_record_id: ownId },
  candidate_payload: { ID_Contrato: 'C-1', Estado_Revision: 'Renovado', Fecha_Firma: null },
  discard_justification: null,
}
const sheetRow = { ...conflict, id: sheetId, cause_code: 'OUT_OF_CATALOG', cause_description: 'Valor fuera del catálogo', source_family: 'AUDITORIA_INTERNA', row_number: 3, source_sheet: 'Asuntos', original_payload: { ID_Asunto: 'A-2', Tipo_Asunto: 'Penal' }, candidate_payload: null }

function mount(items) {
  const client = { request: vi.fn(async () => ({ id: conflictId, state: 'Descartado', discard_justification: 'x' })), acquireRead: vi.fn(() => ({ promise: Promise.resolve({ items, next_cursor: null }), release: vi.fn() })), abortAll: vi.fn() }
  const snapshot = { status: 'authenticated', principal: { id: ownId, username: 'analista', roles: ['ANALISTA'] }, generation: 1 }
  const manager = { client, getSnapshot: () => snapshot, subscribe: () => () => {}, restore: vi.fn(), revalidate: vi.fn(async () => true) }
  render(<SessionProvider manager={manager}><MemoryRouter initialEntries={['/cuarentena']}><QuarantinePage /></MemoryRouter></SessionProvider>)
  return client
}
afterEach(() => vi.restoreAllMocks())

describe('SRS_REQUIRED: un conflicto de identidad solo admite descarte (SRS 5.5.9)', () => {
  it('el adaptador no ofrece corrección para un conflicto', () => {
    const [item] = quarantinePage({ items: [conflict], next_cursor: null }).items
    expect(item).toMatchObject({ isConflict: true, canAct: true, canCorrect: false })
  })
  it('compara vigente y recibido con los nombres del registro recibido y sin campos técnicos', () => {
    expect(conflictComparison(conflict)).toEqual([
      { field: 'ID_Contrato', current: 'C-1', received: 'C-1', differs: false },
      { field: 'Estado_Revision', current: 'En revisión', received: 'Renovado', differs: true },
      { field: 'Fecha_Firma', current: null, received: null, differs: false },
    ])
  })
  it('la fila muestra solo «Descartar» y el diálogo presenta el dato vigente frente al recibido', async () => {
    const client = mount([conflict])
    const row = within(await screen.findByRole('table', { name: 'Elementos en cuarentena' })).getByRole('row', { name: /Conflicto de identidad/ })
    expect(within(row).queryByRole('button', { name: 'Corregir' })).not.toBeInTheDocument()
    expect(within(row).getByText('Conflicto de identidad: solo puede descartarse')).toBeVisible()
    await userEvent.click(within(row).getByRole('button', { name: 'Descartar' }))
    const dialog = screen.getByRole('dialog', { name: 'Confirmar descarte' })
    const table = within(dialog).getByRole('table', { name: 'Dato vigente y dato recibido' })
    const changed = within(table).getByRole('row', { name: /Estado_Revision/ })
    expect(changed).toHaveTextContent('En revisión'); expect(changed).toHaveTextContent('Renovado'); expect(changed).toHaveTextContent('distinto')
    expect(within(table).queryByText('payload_sha256')).not.toBeInTheDocument()
    expect(within(dialog).getByText(/El dato vigente no se modifica/)).toBeVisible()
    await userEvent.type(within(dialog).getByLabelText('Justificación del descarte'), 'El dato vigente es el correcto.')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Confirmar descarte' }))
    expect(client.request).toHaveBeenCalledWith(`/validation/quarantine/${conflictId}/discard`, expect.objectContaining({ method: 'POST' }))
  })
})

describe('ROBUSTNESS: ubicación del registro en libros de varias hojas', () => {
  it('la ubicación incluye la hoja solo cuando existe', () => {
    expect(recordLocation({ row_number: 3, source_sheet: 'Asuntos' })).toBe('hoja «Asuntos», fila 3')
    expect(recordLocation({ row_number: 3, source_sheet: null })).toBe('fila 3')
    expect(recordLocation({ row_number: null })).toBe('')
  })
  it('la tabla muestra la hoja bajo el número de fila', async () => {
    mount([sheetRow])
    const row = within(await screen.findByRole('table', { name: 'Elementos en cuarentena' })).getByRole('row', { name: /Valor fuera del catálogo/ })
    expect(within(row).getByText('Hoja Asuntos')).toBeVisible()
  })
  it('un elemento sin hoja conserva el contrato anterior (hoja nula)', () => {
    const { source_sheet: _omit, ...withoutSheet } = sheetRow
    expect(quarantinePage({ items: [withoutSheet], next_cursor: null }).items[0].source_sheet).toBeNull()
  })
})

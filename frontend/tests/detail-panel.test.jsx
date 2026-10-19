import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { SessionProvider } from '../src/auth/SessionProvider.jsx'
import { AuditPage } from '../src/features/operations/AuditPage.jsx'
import { QuarantinePage } from '../src/features/operations/QuarantinePage.jsx'
import { OcrPanel } from '../src/features/operations/OcrPanel.jsx'
import { SYNTHETIC_OCR_PAGE } from './e2e/helpers.js'

const ownId = '11111111-1111-4111-8111-111111111111'
const itemId = '22222222-2222-4222-8222-222222222222'
const operation = '33333333-3333-4333-8333-333333333333'
const correlation = '44444444-4444-4444-8444-444444444444'
const longResource = `${itemId}/registro-fuente/${operation}`
function session(element, { roles = ['TI'], reads }) {
  const client = { request: vi.fn(async () => null), abortAll: vi.fn(), acquireRead: vi.fn((url) => ({ promise: Promise.resolve(reads(url)), release: vi.fn() })) }
  const snapshot = { status: 'authenticated', principal: { id: ownId, username: 'admin', displayName: 'Admin', roles }, generation: 1 }
  const manager = { client, getSnapshot: () => snapshot, subscribe: () => () => {}, restore: vi.fn(), revalidate: vi.fn(async () => true), logout: vi.fn() }
  render(<SessionProvider manager={manager}><MemoryRouter>{element}</MemoryRouter></SessionProvider>)
  return { client }
}
const audit = { items: [{ id: itemId, occurred_at: '2026-10-15T15:20:00Z', actor_type: 'HUMAN', actor_identifier: 'analista', actor_user_id: ownId, action: 'QUARANTINE_REINJECT', resource_type: 'QUARANTINE_ITEM', resource_identifier: longResource, result: 'SUCCESS', safe_cause_code: null, operation_id: operation, correlation_id: correlation, query_sha256: null, resources: [{ resource_type: 'DOCUMENT', resource_identifier: 'DOC-1', id_documento: 'CONTRATO-2026-000123', fragment_id: null }] }], next_cursor: null }
const quarantine = { items: [{ id: itemId, ingest_file_id: null, source_record_id: operation, row_number: 13, source_family: 'CUMPLIMIENTO', source_sheet: 'Contratos vigentes', created_at: '2026-10-15T15:20:00Z', cause_code: 'MISSING_REQUIRED_FIELD', cause_description: 'Falta un campo obligatorio', state: 'Pendiente', original_payload: { Dato: null }, candidate_payload: null, discard_justification: null }], next_cursor: null }

describe('ROBUSTNESS: detalle de fila en panel lateral (decisión del usuario, 2026-10-18)', () => {
  it('Auditoría: el detalle se abre en un panel, no dentro de la celda, y resalta la fila', async () => {
    session(<AuditPage />, { reads: () => audit })
    const open = await screen.findByRole('button', { name: 'Ver detalle de Reinyección de registro' })
    expect(document.querySelector('details')).toBeNull()
    await userEvent.click(open)
    const panel = screen.getByRole('dialog', { name: 'Reinyección de registro' })
    expect(panel).toHaveClass('detail-panel')
    expect(within(panel).getByText('15 oct 2026, 09:20:00 (hora de la Ciudad de México)')).toBeInTheDocument()
    // Etiqueta legible con el código registrado a la vista; nada se oculta.
    expect(within(panel).getByText('Persona')).toBeInTheDocument()
    expect(within(panel).getByText('HUMAN')).toHaveClass('detail-code')
    expect(within(panel).getByText('QUARANTINE_REINJECT')).toBeInTheDocument()
    expect(within(panel).getByText(longResource)).toBeInTheDocument()
    expect(within(panel).getByRole('button', { name: 'Copiar recurso' })).toBeInTheDocument()
    expect(within(panel).getByText('Referencias (1)')).toBeInTheDocument()
    expect(within(panel).getByText('CONTRATO-2026-000123')).toBeInTheDocument()
    expect(document.querySelector('tbody tr[data-selected="true"]')).not.toBeNull()
  })
  it('Esc cierra el panel, devuelve el foco al botón de la fila y quita el resaltado', async () => {
    session(<AuditPage />, { reads: () => audit })
    const open = await screen.findByRole('button', { name: 'Ver detalle de Reinyección de registro' })
    await userEvent.click(open)
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(open).toHaveFocus()
    expect(document.querySelector('tbody tr[data-selected]')).toBeNull()
  })
  it('un clic fuera del panel lo cierra; un clic dentro no', async () => {
    session(<AuditPage />, { reads: () => audit })
    await userEvent.click(await screen.findByRole('button', { name: 'Ver detalle de Reinyección de registro' }))
    await userEvent.click(within(screen.getByRole('dialog')).getByText('Trazabilidad'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('dialog').parentElement)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('«Ver eventos de esta operación» cierra el panel y filtra por la correlación', async () => {
    const { client } = session(<AuditPage />, { reads: () => audit })
    await userEvent.click(await screen.findByRole('button', { name: 'Ver detalle de Reinyección de registro' }))
    await userEvent.click(screen.getByRole('button', { name: 'Ver eventos de esta operación' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => expect(client.acquireRead.mock.calls.at(-1)[0]).toContain(`correlation_id=${correlation}`))
  })
  it('Cuarentena: regla con su código, ubicación y ausencia como «—», sin botón de copiar vacío', async () => {
    session(<QuarantinePage />, { roles: ['ANALISTA'], reads: () => quarantine })
    await userEvent.click(await screen.findByRole('button', { name: 'Ver detalle de la fila 13' }))
    const panel = screen.getByRole('dialog', { name: 'Detalle del elemento retenido' })
    expect(within(panel).getAllByText('Falta un campo obligatorio').length).toBeGreaterThan(0)
    expect(within(panel).getByText('MISSING_REQUIRED_FIELD')).toHaveClass('detail-code')
    expect(within(panel).getByText('Contratos vigentes')).toBeInTheDocument()
    const origin = within(panel).getByText('Archivo de origen').closest('.detail-field')
    expect(origin).toHaveTextContent('Archivo de origen—')
    expect(within(panel).queryByRole('button', { name: 'Copiar archivo de origen' })).toBeNull()
    expect(within(panel).getByRole('button', { name: 'Copiar registro fuente' })).toBeInTheDocument()
    // Las acciones siguen en la tabla, no en el panel.
    expect(within(panel).queryByRole('button', { name: 'Descartar' })).toBeNull()
  })
  it('OCR: estados con su valor registrado y la confianza tal como llegó', async () => {
    session(<OcrPanel />, { reads: () => SYNTHETIC_OCR_PAGE })
    await userEvent.click(await screen.findByRole('button', { name: 'Ver detalle de Contrato de prueba OCR' }))
    const panel = screen.getByRole('dialog', { name: 'Contrato de prueba OCR' })
    expect(within(panel).getByText('RECHAZADA')).toHaveClass('detail-code')
    expect(within(panel).getByText('0.61')).toBeInTheDocument()
    expect(within(panel).getByRole('button', { name: 'Copiar versión' })).toBeInTheDocument()
  })
})

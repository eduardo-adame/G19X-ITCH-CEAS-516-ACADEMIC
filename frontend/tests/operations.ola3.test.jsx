import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { SessionProvider } from '../src/auth/SessionProvider.jsx'
import { AppShell, useLeaveGuard } from '../src/components/layout.jsx'
import { DateRangeFields } from '../src/components/filters.jsx'
import { quickRanges } from '../src/shared/presentation.js'
import { DATA_FORMATS, formatProblem } from '../src/features/operations/dataFormats.js'
import { changedKeys, QuarantineEditor } from '../src/features/operations/QuarantineEditor.jsx'
import { AdministrationPage } from '../src/features/operations/AdministrationPage.jsx'
import { AuditPage } from '../src/features/operations/AuditPage.jsx'
import { QuarantinePage } from '../src/features/operations/QuarantinePage.jsx'
import { IngestionPage } from '../src/features/operations/IngestionPage.jsx'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
const ownId = '11111111-1111-4111-8111-111111111111'
const otherId = '22222222-2222-4222-8222-222222222222'
const thirdId = '33333333-3333-4333-8333-333333333333'
const correlation = '44444444-4444-4444-8444-444444444444'
function session(element, { roles = ['TI'], request = vi.fn(async () => null), reads = () => ({ items: [], next_cursor: null }), path = '/' } = {}) {
  const client = { request, abortAll: vi.fn(), acquireRead: vi.fn((url) => ({ promise: Promise.resolve(reads(url)), release: vi.fn() })) }
  const snapshot = { status: 'authenticated', principal: { id: ownId, username: 'admin', displayName: 'Admin', roles }, generation: 1 }
  const manager = { client, getSnapshot: () => snapshot, subscribe: () => () => {}, restore: vi.fn(), revalidate: vi.fn(async () => true), logout: vi.fn() }
  render(<SessionProvider manager={manager}><MemoryRouter initialEntries={[path]}>{element}</MemoryRouter></SessionProvider>)
  return { request, client }
}

describe('ROBUSTNESS: rangos rápidos de fechas', () => {
  it('calcula Hoy, Últimos 7 y 30 días y Este mes en días locales', () => {
    expect(quickRanges(new Date(2026, 9, 16, 10, 0)).map(({ value, from, to }) => [value, from, to])).toEqual([
      ['today', '2026-10-16', '2026-10-16'], ['last_7', '2026-10-10', '2026-10-16'], ['last_30', '2026-09-17', '2026-10-16'], ['this_month', '2026-10-01', '2026-10-16'],
    ])
  })
  it('elegir un rango rellena ambas fechas y una fecha manual se muestra como «Personalizado»', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(2026, 9, 16, 10, 0))
    const onChange = vi.fn()
    const { rerender } = render(<DateRangeFields quick from="" to="" onChange={onChange} />)
    const quick = screen.getByLabelText('Rango rápido')
    expect(quick).toHaveValue('any')
    fireEvent.change(quick, { target: { value: 'last_7' } })
    expect(onChange).toHaveBeenLastCalledWith({ from: '2026-10-10', to: '2026-10-16' })
    rerender(<DateRangeFields quick from="2026-10-02" to="2026-10-05" onChange={onChange} />)
    expect(screen.getByLabelText('Rango rápido')).toHaveValue('custom')
    expect(within(screen.getByLabelText('Rango rápido')).getByRole('option', { name: 'Personalizado' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Rango rápido'), { target: { value: 'any' } })
    expect(onChange).toHaveBeenLastCalledWith({ from: '', to: '' })
  })
})

describe('ROBUSTNESS: ingesta', () => {
  it('rechaza al instante un formato no admitido, también al soltarlo', async () => {
    expect(formatProblem({ name: 'datos.CSV' })).toBeNull()
    expect(formatProblem({ name: 'informe.exe' })).toMatch('Formato no admitido')
    const { request } = session(<IngestionPage />, { roles: ['ANALISTA'] })
    const zone = screen.getByText(/Arrastra un archivo aquí/).closest('div')
    fireEvent.drop(zone, { dataTransfer: { files: [new File(['x'], 'macro.xlsm')] } })
    expect(screen.getByRole('alert')).toHaveTextContent('Formato no admitido. Usa un archivo CSV, XLSX, PDF o DOCX.')
    expect(screen.queryByText(/Seleccionado:/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Recibir y procesar' })).toBeDisabled()
    fireEvent.drop(zone, { dataTransfer: { files: [new File(['x'], 'contratos.csv')] } })
    expect(screen.queryByText('Formato no admitido. Usa un archivo CSV, XLSX, PDF o DOCX.')).not.toBeInTheDocument()
    expect(screen.getByText(/Seleccionado:/)).toHaveTextContent('contratos.csv')
    expect(request).not.toHaveBeenCalled()
  })
  it('muestra el formato esperado de la ubicación elegida', async () => {
    session(<IngestionPage />, { roles: ['ANALISTA'] })
    await userEvent.selectOptions(screen.getByLabelText('Ubicación controlada'), 'litigation')
    const help = screen.getByText('Formato esperado para «Litigios»').closest('details')
    expect(help).toHaveTextContent('ID_Litigio, Fecha_Apertura, Estado, Nivel_Severidad')
    expect(help).toHaveTextContent('Monto_Reclamado, Estimacion_Interna')
    expect(Object.keys(DATA_FORMATS)).toEqual(['contracts-documents', 'litigation', 'compliance', 'internal-audit'])
  })
  it('el formato esperado coincide con el contrato que valida el backend', () => {
    const backend = readFileSync(resolve(process.cwd(), '../backend/app/validation/contracts.py'), 'utf8')
    const columns = (list) => [...list.matchAll(/"([A-Za-z_]+)"/g)].map((match) => match[1])
    const required = new Set([...backend.matchAll(/required_columns=\(([^)]*)\)/g)].map((match) => columns(match[1]).join(',')))
    const optional = new Set([...backend.matchAll(/FieldSpec\("([A-Za-z_]+)"[^)]*required=False/g)].map((match) => match[1]))
    const formats = Object.values(DATA_FORMATS).flat()
    expect(new Set(formats.map((format) => format.required.join(',')))).toEqual(required)
    expect(new Set(formats.flatMap((format) => format.optional))).toEqual(optional)
  })
  it('TI ve la calidad técnica de OCR al inicio de la vista, con su valor y la fecha de cálculo', async () => {
    session(<IngestionPage />, { reads: (url) => url.startsWith('/technical/kpis') ? { kpi_code: 'KPI-CD-03', availability: 'DISPONIBLE', value: '98.5', calculated_at: '2026-10-14T16:00:00Z' } : { items: [], next_cursor: null } })
    const card = await screen.findByRole('region', { name: 'Calidad técnica de OCR' })
    expect(await within(card).findByText('98.5 %', { exact: true })).toBeVisible()
    expect(card).toHaveTextContent('Calculado:')
    const receive = screen.getByRole('heading', { name: 'Recibir archivo' })
    expect(card.compareDocumentPosition(receive) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
  it('con una operación en curso, cambiar de vista desde el menú pide confirmación', async () => {
    function Busy() { useLeaveGuard(true, 'Hay una operación de ingesta en curso.'); return <h1>Ingesta</h1> }
    const navigation = [{ id: 'a', path: '/ingesta', label: 'Operaciones de ingesta', capability: 'ingest.upload' }, { id: 'b', path: '/auditoria', label: 'Auditoría', capability: 'audit.read.own' }]
    const unload = vi.spyOn(window, 'addEventListener')
    session(<Routes><Route element={<AppShell navigation={navigation} />}><Route path="/ingesta" element={<Busy />} /><Route path="/auditoria" element={<h1>Vista de auditoría</h1>} /></Route></Routes>, { roles: ['ANALISTA'], path: '/ingesta' })
    expect(unload).toHaveBeenCalledWith('beforeunload', expect.any(Function))
    await userEvent.click(screen.getAllByRole('link', { name: 'Auditoría' })[0])
    const dialog = screen.getByRole('dialog', { name: '¿Salir de esta vista?' })
    expect(dialog).toHaveTextContent('Hay una operación de ingesta en curso.')
    expect(within(dialog).getByRole('button', { name: 'Quedarme' })).toHaveFocus()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Quedarme' }))
    expect(screen.getByRole('heading', { name: 'Ingesta' })).toBeVisible()
    await userEvent.click(screen.getAllByRole('link', { name: 'Auditoría' })[0])
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Salir de todos modos' }))
    expect(await screen.findByRole('heading', { name: 'Vista de auditoría' })).toBeVisible()
  })
})

describe('ROBUSTNESS: cuarentena', () => {
  const item = { id: otherId, canCorrect: true, cause_description: 'Falta campo obligatorio', row_number: 2, original_payload: { Nombre: 'Ana', Fecha: null }, candidate_payload: null }
  it('marca los campos cambiados respecto al original y avisa si no hay cambios', async () => {
    expect(changedKeys({ Nombre: 'Ana', Fecha: '2026-01-01' }, item.original_payload)).toEqual(['Fecha'])
    expect(changedKeys({ Nuevo: 'x' }, {})).toEqual(['Nuevo'])
    session(<QuarantineEditor item={item} onClose={vi.fn()} onConfirmed={vi.fn()} />)
    expect(screen.getByText('Sin cambios respecto al original: el registro probablemente vuelva a rechazarse.')).toBeVisible()
    await userEvent.type(screen.getByLabelText('Fecha'), '2026-01-01')
    expect(screen.getByText('1 campo modificado respecto al original: Fecha.')).toBeVisible()
    expect(screen.getByText(/Original: Sin valor/)).toBeVisible()
  })
  it('tras reinyectar ofrece corregir el siguiente pendiente de la página', async () => {
    const quarantine = { items: [
      { id: otherId, ingest_file_id: null, source_record_id: null, row_number: 2, source_family: 'CUMPLIMIENTO', created_at: '2030-01-01T00:00:00Z', cause_code: 'MISSING_REQUIRED_FIELD', cause_description: 'Primera causa', state: 'Pendiente', original_payload: { Dato: null }, candidate_payload: null, discard_justification: null },
      { id: thirdId, ingest_file_id: null, source_record_id: null, row_number: 3, source_family: 'CUMPLIMIENTO', created_at: '2030-01-01T00:00:00Z', cause_code: 'MISSING_REQUIRED_FIELD', cause_description: 'Segunda causa', state: 'Pendiente', original_payload: { Dato: null }, candidate_payload: null, discard_justification: null },
    ], next_cursor: null }
    const request = vi.fn(async () => ({ quarantine_state: 'Reinyectado', job_id: correlation, operation_id: thirdId, job_state: 'COMPLETED' }))
    session(<QuarantinePage />, { roles: ['ANALISTA'], request, reads: () => quarantine })
    await userEvent.click((await screen.findAllByRole('button', { name: 'Corregir' }))[0])
    await userEvent.type(screen.getByLabelText('Dato'), 'valor')
    await userEvent.click(screen.getByRole('button', { name: 'Validar y reinyectar' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Corregir siguiente pendiente' }, { timeout: 3000 }))
    expect(within(screen.getByRole('dialog', { name: 'Corregir registro pendiente' })).getByText('Segunda causa')).toBeVisible()
  })
  it('la justificación del descarte es un área de texto con contador', async () => {
    const quarantine = { items: [{ id: otherId, ingest_file_id: null, source_record_id: null, row_number: 2, source_family: 'CUMPLIMIENTO', created_at: '2030-01-01T00:00:00Z', cause_code: 'MISSING_REQUIRED_FIELD', cause_description: 'Causa', state: 'Pendiente', original_payload: { Dato: null }, candidate_payload: null, discard_justification: null }], next_cursor: null }
    session(<QuarantinePage />, { roles: ['ANALISTA'], reads: () => quarantine })
    await userEvent.click(await screen.findByRole('button', { name: 'Descartar' }))
    const field = screen.getByLabelText('Justificación del descarte')
    expect(field.tagName).toBe('TEXTAREA')
    await userEvent.type(field, 'Duplicado')
    expect(screen.getByText('9 caracteres')).toBeVisible()
  })
})

describe('ROBUSTNESS: auditoría', () => {
  const audit = { items: [{ id: otherId, occurred_at: '2030-01-01T00:00:00Z', actor_type: 'HUMAN', actor_identifier: 'admin', actor_user_id: ownId, action: 'DOCUMENT_PRINT', resource_type: 'DOCUMENT_VERSION', resource_identifier: 'DOC-1', result: 'SUCCESS', safe_cause_code: null, operation_id: thirdId, correlation_id: correlation, query_sha256: null, resources: [] }], next_cursor: null }
  it('copia identificadores y filtra por la operación del evento', async () => {
    const write = vi.fn(async () => {}); Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: write } })
    const { client } = session(<AuditPage />, { reads: () => audit })
    expect(await screen.findByText('Impresión de documento')).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'Copiar correlación' }))
    expect(write).toHaveBeenCalledWith(correlation)
    expect(await screen.findByText('Copiado')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Ver eventos de esta operación' }))
    await waitFor(() => expect(client.acquireRead.mock.calls.at(-1)[0]).toContain(`correlation_id=${correlation}`))
    expect(await screen.findByRole('button', { name: /Correlación: 44444444…/ })).toBeVisible()
  })
})

describe('SRS_REQUIRED: confirmaciones de administración', () => {
  const accounts = { items: [{ id: otherId, username: 'ana.m', display_name: 'Ana Martínez', state: 'ACTIVE', roles: ['JURIDICO'], created_at: '2026-10-01T10:00:00Z', disabled_at: null }], next_cursor: null }
  const reads = (url) => url.startsWith('/security/users') ? accounts : { items: [], next_cursor: null }
  async function pick(item) {
    await userEvent.click(await screen.findByRole('button', { name: 'Acciones para Ana Martínez' }))
    await userEvent.click(screen.getByRole('menuitem', { name: item }))
    return screen.getByRole('dialog')
  }
  it('asignar roles muestra un resumen y solo se aplica al confirmar', async () => {
    const { request } = session(<AdministrationPage />, { reads })
    const dialog = await pick('Asignar roles')
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Analista' }))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Revisar' }))
    expect(within(dialog).getByRole('group', { name: 'Revisión' })).toHaveTextContent('La cuenta Ana Martínez (ana.m) quedará exactamente con: Jurídico · Analista.')
    expect(within(dialog).getByRole('button', { name: 'Volver' })).toHaveFocus()
    expect(request).not.toHaveBeenCalled()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Asignar roles' }))
    await waitFor(() => expect(request).toHaveBeenCalledWith(`/security/users/${otherId}/roles`, expect.objectContaining({ method: 'PUT', body: { roles: ['JURIDICO', 'ANALISTA'] } })))
  })
  it('restablecer acceso confirma sin guardar la contraseña en el resumen', async () => {
    const { request } = session(<AdministrationPage />, { reads })
    const dialog = await pick('Restablecer acceso')
    await userEvent.type(within(dialog).getByLabelText('Contraseña nueva'), 'Temporal-456')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Mostrar contraseña' }))
    expect(within(dialog).getByLabelText('Contraseña nueva')).toHaveAttribute('type', 'text')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Revisar' }))
    const review = within(dialog).getByRole('group', { name: 'Revisión' })
    expect(review).toHaveTextContent('Ana Martínez (ana.m)')
    expect(review).not.toHaveTextContent('Temporal-456')
    expect(dialog.querySelector('input[name="password"]')).toHaveAttribute('type', 'password')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Volver' }))
    expect(request).not.toHaveBeenCalled()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Revisar' }))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Restablecer acceso' }))
    await waitFor(() => expect(request).toHaveBeenCalledWith(`/security/users/${otherId}/reset-access`, expect.objectContaining({ method: 'POST', body: { password: 'Temporal-456' } })))
    expect(document.body).not.toHaveTextContent('Temporal-456')
  })
})

import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { SessionProvider } from '../src/auth/SessionProvider.jsx'
import { ApiError } from '../src/api/errors.js'
import { IngestionPage } from '../src/features/operations/IngestionPage.jsx'
import { QuarantinePage } from '../src/features/operations/QuarantinePage.jsx'
import { AdministrationPage } from '../src/features/operations/AdministrationPage.jsx'
import { formFields, payloadFromFields } from '../src/features/operations/QuarantineEditor.jsx'
import { ResourceState, TableSkeleton } from '../src/components/feedback.jsx'
import { navigationIcon } from '../src/components/Icon.jsx'

const ownId = '11111111-1111-4111-8111-111111111111'
const otherId = '22222222-2222-4222-8222-222222222222'
const ingestion = { file_id: ownId, operation_id: otherId, correlation_id: ownId, state: 'COMPLETADO', format: 'CSV', family: 'CUMPLIMIENTO', routing_target: 'VALIDATION', safe_cause_code: null, idempotent: false }
const row = { id: otherId, ingest_file_id: ownId, source_record_id: null, row_number: 4, source_family: 'CUMPLIMIENTO', created_at: '2030-01-01T00:00:00Z', cause_code: 'MISSING_REQUIRED_FIELD', cause_description: 'Falta campo obligatorio', state: 'Pendiente', original_payload: { Área: 'Finanzas', Fecha: null }, candidate_payload: null, discard_justification: null }

function Location() { return <output aria-label="URL actual">{useLocation().search}</output> }
function mount(element, { roles = ['TI'], request = vi.fn(async () => null), reads = () => ({ items: [row], next_cursor: null }), path = '/' } = {}) {
  const client = { request, acquireRead: vi.fn((url) => ({ promise: Promise.resolve(reads(url)), release: vi.fn() })), abortAll: vi.fn() }
  const snapshot = { status: 'authenticated', principal: { id: ownId, username: 'cuenta-sintetica', roles }, generation: 1 }
  const manager = { client, getSnapshot: () => snapshot, subscribe: () => () => {}, restore: vi.fn(), revalidate: vi.fn(async () => true) }
  render(<SessionProvider manager={manager}><MemoryRouter initialEntries={[path]}><Location />{element}</MemoryRouter></SessionProvider>)
  return { client }
}
afterEach(() => vi.restoreAllMocks())

describe('ROBUSTNESS: formulario de corrección equivalente al JSON (UX-041)', () => {
  it('sin cambios, el formulario reproduce exactamente el payload de origen (incluidos nulos y vacíos)', () => {
    const source = { Área: 'Finanzas', Fecha: null, Nota: '' }
    expect(payloadFromFields(formFields(source), source)).toEqual(source)
  })
  it('un campo nulo editado es texto; vuelto a vaciar recupera el nulo', () => {
    const source = { Fecha: null }
    expect(payloadFromFields({ Fecha: '2026-10-01' }, source)).toEqual({ Fecha: '2026-10-01' })
    expect(payloadFromFields({ Fecha: '' }, source)).toEqual({ Fecha: null })
  })
  it('valores no textuales no se ofrecen como formulario (se corrigen en JSON)', () => {
    expect(formFields({ Monto: 10 })).toBeNull()
    expect(formFields({ Lista: ['a'] })).toBeNull()
    expect(formFields({})).toBeNull()
  })
  it('el formulario envía el mismo cuerpo que el JSON equivalente', async () => {
    const request = vi.fn(async () => ({ detail: 'La reinyección fue confirmada; el recálculo sigue pendiente' }))
    mount(<QuarantinePage />, { roles: ['ANALISTA'], request })
    await screen.findByText('Falta campo obligatorio')
    await userEvent.click(screen.getByRole('button', { name: 'Corregir' }))
    await userEvent.type(screen.getByLabelText('Fecha'), '2026-10-01')
    await userEvent.click(screen.getByRole('button', { name: 'Editar como JSON' }))
    expect(JSON.parse(screen.getByLabelText('Candidato corregido (JSON)').value)).toEqual({ Área: 'Finanzas', Fecha: '2026-10-01' })
    await userEvent.click(screen.getByRole('button', { name: 'Editar como formulario' }))
    await userEvent.click(screen.getByRole('button', { name: 'Validar y reinyectar' }))
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1))
    expect(request.mock.calls[0][1].body.corrected_payload).toEqual({ Área: 'Finanzas', Fecha: '2026-10-01' })
    expect(await screen.findByText('Falta campo obligatorio · fila 4', { selector: 'div' })).toBeVisible()
  })
  it('un JSON que no es objeto de texto no cambia a formulario ni se pierde', async () => {
    mount(<QuarantinePage />, { roles: ['ANALISTA'] })
    await screen.findByText('Falta campo obligatorio')
    await userEvent.click(screen.getByRole('button', { name: 'Corregir' }))
    await userEvent.click(screen.getByRole('button', { name: 'Editar como JSON' }))
    fireEvent.change(screen.getByLabelText('Candidato corregido (JSON)'), { target: { value: '{"Monto": 10}' } })
    await userEvent.click(screen.getByRole('button', { name: 'Editar como formulario' }))
    expect(screen.getByRole('alert')).toHaveTextContent('valores de texto')
    expect(screen.getByLabelText('Candidato corregido (JSON)')).toHaveValue('{"Monto": 10}')
  })
})

describe('ROBUSTNESS: pestañas de cuarentena sobre el filtro de estado (UX-040)', () => {
  it('«Por resolver» aplica el estado Pendiente y «Todos» lo retira', async () => {
    const { client } = mount(<QuarantinePage />, { roles: ['ANALISTA'] })
    const tabs = await screen.findByRole('tablist', { name: 'Estado de los elementos' })
    expect(within(tabs).getByRole('tab', { name: 'Todos' })).toHaveAttribute('aria-selected', 'true')
    await userEvent.click(within(tabs).getByRole('tab', { name: 'Por resolver' }))
    await waitFor(() => expect(screen.getByLabelText('URL actual')).toHaveTextContent('state=Pendiente'))
    expect(client.acquireRead.mock.calls.at(-1)[0]).toContain('state=Pendiente')
    await userEvent.click(within(tabs).getByRole('tab', { name: 'Todos' }))
    await waitFor(() => expect(screen.getByLabelText('URL actual')).not.toHaveTextContent('state='))
  })
  it('un vacío explica qué pestaña está vacía', async () => {
    mount(<QuarantinePage />, { roles: ['ANALISTA'], reads: () => ({ items: [], next_cursor: null }), path: '/?state=Pendiente' })
    expect(await screen.findByText('Nada por resolver')).toBeVisible()
  })
})

describe('ROBUSTNESS: ingesta con zona de carga y seguimiento (UX-037/038/047)', () => {
  it('antes de recibir archivos muestra un vacío con contexto', () => {
    mount(<IngestionPage />, { roles: ['ANALISTA'] })
    expect(screen.getByText('Aún no has recibido archivos en esta sesión')).toBeVisible()
  })
  it('soltar un archivo lo selecciona y el resultado muestra su nombre y el identificador solo en el detalle', async () => {
    const request = vi.fn(async (path) => path === '/ingestion/uploads' ? ingestion : { downstream_target: 'VALIDATION', operation_id: otherId, downstream_result_id: null, state: 'COMPLETED' })
    mount(<IngestionPage />, { roles: ['ANALISTA'], request })
    const zone = screen.getByText(/Arrastra un archivo aquí/).closest('div')
    fireEvent.drop(zone, { dataTransfer: { files: [new File(['Dato\n1'], 'cumplimiento-octubre.csv', { type: 'text/csv' })] } })
    expect(screen.getByText('cumplimiento-octubre.csv')).toBeVisible()
    fireEvent.submit(screen.getByRole('button', { name: 'Recibir y procesar' }).closest('form'))
    const table = await screen.findByRole('region', { name: 'Archivos recibidos en esta sesión' })
    expect(await within(table).findByText('Procesamiento ejecutado')).toBeVisible()
    expect(within(table).getByText('cumplimiento-octubre.csv')).toBeVisible()
    // El identificador no está en la tabla: solo aparece al abrir el panel de detalle.
    expect(within(table).queryByText(ownId)).toBeNull()
    await userEvent.click(within(table).getByRole('button', { name: 'Ver detalle de cumplimiento-octubre.csv' }))
    expect(within(screen.getByRole('dialog', { name: 'cumplimiento-octubre.csv' })).getAllByText(ownId).length).toBeGreaterThan(0)
    expect(request.mock.calls[0][1].body.get('file').name).toBe('cumplimiento-octubre.csv')
  })
  it('un error de recepción se titula con la acción que falló', async () => {
    mount(<IngestionPage />, { roles: ['ANALISTA'], request: vi.fn(async () => { throw new ApiError(422) }) })
    await userEvent.upload(screen.getByLabelText('Archivo (máximo 50 MiB)'), new File(['x'], 'dato.csv', { type: 'text/csv' }))
    fireEvent.submit(screen.getByRole('button', { name: 'Recibir y procesar' }).closest('form'))
    expect((await screen.findByText('No se pudo recibir el archivo')).closest('[role="alert"]')).toHaveTextContent('Revisa los datos')
  })
})

describe('ROBUSTNESS: administración por secciones y copia del identificador (UX-044)', () => {
  it('separa Cuentas y Permisos concedidos', async () => {
    mount(<AdministrationPage />)
    const tabs = screen.getByRole('tablist', { name: 'Secciones de administración' })
    expect(await screen.findByRole('heading', { name: 'Cuentas registradas' })).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'Alcance por familia' })).not.toBeInTheDocument()
    await userEvent.click(within(tabs).getByRole('tab', { name: 'Permisos concedidos' }))
    expect(await screen.findByRole('heading', { name: 'Alcance por familia' })).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'Cuentas registradas' })).not.toBeInTheDocument()
  })
  it('tras crear una cuenta ofrece copiar su identificador', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    mount(<AdministrationPage />, { request: vi.fn(async () => ({ id: otherId })) })
    await userEvent.click(await screen.findByRole('button', { name: 'Nueva cuenta' }))
    await userEvent.type(screen.getByLabelText('Usuario'), 'nuevo')
    await userEvent.type(screen.getByLabelText('Nombre visible'), 'Cuenta nueva')
    await userEvent.type(screen.getByLabelText('Contraseña nueva'), 'Temporal-123')
    await userEvent.click(screen.getByRole('checkbox', { name: 'Jurídico' }))
    await userEvent.click(screen.getByRole('button', { name: 'Crear cuenta' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Copiar identificador' }))
    expect(writeText).toHaveBeenCalledWith(otherId)
    expect(await screen.findByText('Identificador copiado.')).toBeVisible()
  })
})

describe('ROBUSTNESS: carga, vacíos e iconos (UX-046/047/049)', () => {
  it('el esqueleto de tabla anuncia la carga sin mostrar valores', () => {
    render(<ResourceState resource={{ state: 'loading' }} context="la cuarentena" skeleton="table">{() => '0'}</ResourceState>)
    expect(screen.getByRole('status')).toHaveTextContent('Cargando la cuarentena…')
    expect(screen.queryByText('0')).not.toBeInTheDocument()
  })
  it('el vacío por defecto se conserva y el contextual sustituye título y mensaje', () => {
    const { rerender } = render(<ResourceState resource={{ state: 'empty' }}>{() => null}</ResourceState>)
    expect(screen.getByText('Sin resultados')).toBeVisible()
    rerender(<ResourceState resource={{ state: 'empty' }} empty={{ title: 'Nada por resolver', message: 'Sin pendientes.' }}>{() => null}</ResourceState>)
    expect(screen.getByText('Nada por resolver')).toBeVisible()
    expect(screen.getByText('Sin pendientes.')).toBeVisible()
  })
  it('TableSkeleton dibuja cabecera y cinco filas', () => {
    const { container } = render(<TableSkeleton columns={3} />)
    expect(container.querySelectorAll('.border-t')).toHaveLength(5)
  })
  it('cada destino de navegación tiene un icono propio', () => {
    const paths = ['/', '/contratos', '/litigios', '/tendencias', '/consulta', '/documentos', '/ingesta', '/cuarentena', '/auditoria', '/administracion']
    expect(new Set(paths.map(navigationIcon)).size).toBe(paths.length)
  })
})

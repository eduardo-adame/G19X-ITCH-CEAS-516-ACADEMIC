import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { SessionProvider } from '../src/auth/SessionProvider.jsx'
import { ApiError } from '../src/api/errors.js'
import { AdministrationPage, failureReason } from '../src/features/operations/AdministrationPage.jsx'
import { consumePermissionChange } from '../src/auth/sessionNotice.js'

const ownId = '11111111-1111-4111-8111-111111111111'
const otherId = '22222222-2222-4222-8222-222222222222'
const account = (id, username, display_name, roles, state = 'ACTIVE') => ({ id, username, display_name, state, roles, created_at: '2026-10-01T10:00:00Z', disabled_at: state === 'DISABLED' ? '2026-10-02T10:00:00Z' : null })
const ACCOUNTS = { items: [account(ownId, 'admin', 'Admin TI', ['TI']), account(otherId, 'ana.m', 'Ana Martínez', ['ANALISTA'])], next_cursor: null }
function mount({ roles = ['TI'], request = vi.fn(async (path) => path === '/security/users' ? { id: otherId } : null), onRevalidate, reads } = {}) {
  let snapshot = { status: 'authenticated', principal: { id: ownId, username: 'admin', roles }, generation: 1 }
  const listeners = new Set()
  const acquireRead = vi.fn((path) => ({ promise: Promise.resolve(reads?.(path) ?? (path.startsWith('/security/users') ? ACCOUNTS : { items: [], next_cursor: null })), release: vi.fn() }))
  const client = { request, abortAll: vi.fn(), acquireRead }
  const manager = {
    client, getSnapshot: () => snapshot, subscribe: (callback) => { listeners.add(callback); return () => listeners.delete(callback) }, restore: vi.fn(),
    revalidate: vi.fn(async () => { const replacement = await onRevalidate?.(snapshot); if (replacement) { snapshot = replacement; for (const callback of listeners) callback(snapshot) } return snapshot.status === 'authenticated' }),
  }
  render(<SessionProvider manager={manager}><MemoryRouter><AdministrationPage /></MemoryRouter></SessionProvider>)
  return { request, manager, acquireRead }
}
// Elegir una acción en el menú «Acciones» de la fila de una cuenta.
async function pick(name, item) {
  await userEvent.click(await screen.findByRole('button', { name: `Acciones para ${name}` }))
  await userEvent.click(screen.getByRole('menuitem', { name: item }))
  return screen.getByRole('dialog')
}
async function newAccount() {
  await userEvent.click(await screen.findByRole('button', { name: 'Nueva cuenta' }))
  const dialog = screen.getByRole('dialog', { name: 'Nueva cuenta' })
  await userEvent.type(within(dialog).getByLabelText('Usuario'), 'nuevo')
  await userEvent.type(within(dialog).getByLabelText('Nombre visible'), 'Cuenta nueva')
  await userEvent.type(within(dialog).getByLabelText('Contraseña nueva'), 'Temporal-123')
  await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Jurídico' }))
  return dialog
}

describe('SRS_REQUIRED: administración TI', () => {
  it('deniega por defecto a un rol no TI', () => {
    const { request } = mount({ roles: ['ANALISTA'] }); expect(screen.getByRole('alert')).toHaveTextContent('Acceso no autorizado'); expect(request).not.toHaveBeenCalled()
  })

  it('crea una cuenta en un diálogo sin persistir la contraseña en storage, URL ni resultado', async () => {
    const storage = vi.spyOn(Storage.prototype, 'setItem'); const { request, acquireRead } = mount()
    const dialog = await newAccount()
    const reads = acquireRead.mock.calls.length
    await userEvent.click(within(dialog).getByRole('button', { name: 'Crear cuenta' }))
    expect(await within(dialog).findByText(/Identificador creado/)).toHaveTextContent(`Identificador creado: ${otherId}`)
    expect(request.mock.calls[0][0]).toBe('/security/users'); expect(request.mock.calls[0][0]).not.toContain('Temporal-123')
    // La lista se vuelve a leer y el aviso queda sobre ella al cerrar el diálogo.
    await waitFor(() => expect(acquireRead.mock.calls.length).toBeGreaterThan(reads))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Listo' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByText('Cuenta nuevo creada.')).toBeVisible()
    expect(storage).not.toHaveBeenCalled(); expect(document.body).not.toHaveTextContent('Temporal-123'); storage.mockRestore()
  })

  it('impide modificar roles propios antes de invocar backend', async () => {
    const { request } = mount()
    await userEvent.click(await screen.findByRole('button', { name: 'Acciones para Admin TI' }))
    const own = screen.getByRole('menuitem', { name: /Asignar roles/ })
    expect(own).toHaveAttribute('aria-disabled', 'true')
    expect(own).toHaveTextContent('No puedes modificar tus propios roles')
    await userEvent.click(own)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(request).not.toHaveBeenCalled()
  })

  it('deshabilita solo después de revisar y confirmar en el mismo diálogo', async () => {
    const { request } = mount(); const dialog = await pick('Ana Martínez', 'Deshabilitar cuenta')
    expect(dialog).toHaveAccessibleName('Deshabilitar cuenta · Ana Martínez')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Revisar' })); expect(request).not.toHaveBeenCalled()
    expect(within(dialog).getByRole('group', { name: 'Revisión' })).toHaveTextContent('Se deshabilitará la cuenta Ana Martínez (ana.m)')
    expect(within(dialog).getByRole('button', { name: 'Volver' })).toHaveFocus()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Deshabilitar cuenta' }))
    await waitFor(() => expect(request).toHaveBeenCalledWith(`/security/users/${otherId}/disable`, { method: 'POST', body: undefined }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByText('Cuenta de Ana Martínez deshabilitada.')).toBeVisible()
  })

  it('dejar el sistema sin TI activo se explica con su motivo dentro del diálogo', async () => {
    const request = vi.fn(async () => { throw new ApiError(409) }); mount({ request }); const dialog = await pick('Ana Martínez', 'Deshabilitar cuenta')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Revisar' })); await userEvent.click(within(dialog).getByRole('button', { name: 'Deshabilitar cuenta' }))
    expect(await within(dialog).findByText(/El sistema quedaría sin ninguna cuenta TI activa/)).toBeVisible()
    expect(within(dialog).queryByText('Acceso no autorizado.')).not.toBeInTheDocument()
  })

  it('una revocación durante revalidación impide la mutación', async () => {
    const { request } = mount({ onRevalidate: async (previous) => ({ status: 'authenticated', principal: { ...previous.principal, roles: ['ANALISTA'] }, generation: previous.generation + 1 }) })
    const dialog = await newAccount()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Crear cuenta' }))
    await waitFor(() => expect(request).not.toHaveBeenCalled())
    expect(screen.queryByText(/Identificador creado/)).not.toBeInTheDocument()
  })
})

describe('ROBUSTNESS: lista de cuentas (SRS 0.26)', () => {
  it('muestra nombre, usuario, roles y estado, y busca y filtra en el servidor', async () => {
    const { acquireRead } = mount()
    const table = await screen.findByRole('table', { name: 'Cuentas registradas' })
    expect(within(table).getByText('Ana Martínez')).toBeVisible()
    expect(within(table).getByText('Analista')).toBeVisible()
    expect(within(table).getAllByText('Activa')).toHaveLength(2)
    expect(within(table).getByText('(tú)')).toBeVisible()
    expect(screen.queryByLabelText('Operación administrativa')).not.toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('Buscar por usuario o nombre'), 'ana{Enter}')
    await waitFor(() => expect(acquireRead.mock.calls.at(-1)[0]).toBe('/security/users?q=ana&limit=25'))
    await userEvent.selectOptions(screen.getByLabelText('Estado'), 'DISABLED')
    await waitFor(() => expect(acquireRead.mock.calls.at(-1)[0]).toBe('/security/users?q=ana&state=DISABLED&limit=25'))
  })
  it('cada acción de fila abre su diálogo con los datos vigentes y Cancelar no cambia nada', async () => {
    const { request } = mount()
    let dialog = await pick('Ana Martínez', 'Asignar roles')
    expect(dialog).toHaveAccessibleName('Asignar roles · Ana Martínez')
    expect(within(dialog).getByRole('checkbox', { name: 'Analista' })).toBeChecked()
    expect(within(dialog).getByRole('checkbox', { name: 'Jurídico' })).not.toBeChecked()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Acciones para Ana Martínez' })).toHaveFocus()
    dialog = await pick('Ana Martínez', 'Editar nombre')
    expect(within(dialog).getByLabelText('Nombre visible')).toHaveValue('Ana Martínez')
    await userEvent.keyboard('{Escape}')
    expect(request).not.toHaveBeenCalled()
  })
  it('sin cuentas para los filtros lo indica', async () => {
    mount({ reads: (path) => path.startsWith('/security/users') ? { items: [], next_cursor: null } : { items: [] } })
    expect(await screen.findByText('Sin cuentas para estos filtros')).toBeVisible()
  })
  it('una respuesta fuera de contrato no se muestra', async () => {
    mount({ reads: (path) => path.startsWith('/security/users') ? { items: [{ ...ACCOUNTS.items[1], roles: ['ADMIN'] }], next_cursor: null } : { items: [] } })
    expect(await screen.findByText(/Error al cargar las cuentas/)).toBeVisible()
    expect(screen.queryByText('Ana Martínez')).not.toBeInTheDocument()
  })
})

describe('ROBUSTNESS: permisos concedidos (SRS 0.26)', () => {
  const scopes = { items: [{ role_id: 'JURIDICO', source_family: 'LITIGIOS', active: true }, { role_id: 'ANALISTA', source_family: 'CUMPLIMIENTO', active: false }] }
  const exceptions = { items: [{ id: '33333333-3333-4333-8333-333333333333', subject_type: 'USER', account_id: otherId, username: 'ana.m', display_name: 'Ana Martínez', role_id: null, document_id: 'DOC-7', decision: 'DENY', created_at: '2026-10-03T10:00:00Z' }], next_cursor: null }
  const reads = (path) => path.startsWith('/security/document-scopes') ? scopes : path.startsWith('/security/document-exceptions') ? exceptions : ACCOUNTS
  it('la matriz muestra el alcance y «Quitar» pide confirmar el cambio exacto', async () => {
    const request = vi.fn(async () => null); mount({ reads, request }); await userEvent.click(screen.getByRole('tab', { name: 'Permisos concedidos' }))
    const matrix = await screen.findByRole('table', { name: 'Alcance por familia vigente' })
    const juridico = within(matrix).getByText('Jurídico').closest('tr')
    expect(within(juridico).getByText('Con acceso')).toBeVisible()
    expect(within(juridico).getAllByText('Sin acceso')).toHaveLength(3)
    await userEvent.click(within(matrix).getByRole('button', { name: 'Quitar acceso a Jurídico en Litigios' }))
    const dialog = screen.getByRole('dialog', { name: 'Quitar acceso' })
    expect(dialog).toHaveTextContent('El rol Jurídico dejará de consultar los documentos de Litigios.')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Quitar acceso' }))
    await waitFor(() => expect(request).toHaveBeenCalledWith('/security/document-scopes/JURIDICO/LITIGIOS', { method: 'PUT', body: { active: false } }))
  })
  it('una excepción vigente se retira desde su fila', async () => {
    const request = vi.fn(async () => null); mount({ reads, request }); await userEvent.click(screen.getByRole('tab', { name: 'Permisos concedidos' }))
    const table = await screen.findByRole('table', { name: 'Excepciones documentales vigentes' })
    expect(within(table).getByText('DOC-7')).toBeVisible(); expect(within(table).getByText('Denegar')).toBeVisible()
    await userEvent.click(within(table).getByRole('button', { name: 'Acciones para la excepción de DOC-7' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Retirar excepción' }))
    const dialog = screen.getByRole('dialog', { name: 'Excepción de DOC-7' })
    expect(within(dialog).getByRole('group', { name: 'Cuenta seleccionada' })).toHaveTextContent('Ana Martínez')
    expect(within(dialog).getByLabelText('Vigencia')).toHaveValue('false')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Guardar' }))
    await waitFor(() => expect(request).toHaveBeenCalledWith(`/security/document-exceptions/user/${otherId}/DOC-7`, { method: 'PUT', body: { decision: 'DENY', active: false } }))
    expect(await screen.findByText('Excepción de DOC-7 retirada.')).toBeVisible()
  })
  it('«Nueva excepción» elige la cuenta buscándola, o un rol', async () => {
    mount({ reads }); await userEvent.click(screen.getByRole('tab', { name: 'Permisos concedidos' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Nueva excepción' }))
    const dialog = screen.getByRole('dialog', { name: 'Nueva excepción' })
    await userEvent.type(within(dialog).getByLabelText('Cuenta'), 'ana')
    await userEvent.click(await within(dialog).findByRole('button', { name: /Ana Martínez/ }))
    expect(within(dialog).getByRole('group', { name: 'Cuenta seleccionada' })).toHaveTextContent('ana.m')
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Un rol' }))
    expect(within(dialog).getByLabelText('Rol')).toBeVisible()
    expect(within(dialog).queryByRole('group', { name: 'Cuenta seleccionada' })).not.toBeInTheDocument()
  })
})

describe('ROBUSTNESS: motivos de rechazo y cierre de la propia sesión (certificación O-2 y O-4)', () => {
  const permissionReads = (path) => path.startsWith('/security/document-scopes') ? { items: [] } : path.startsWith('/security/document-exceptions') ? { items: [], next_cursor: null } : ACCOUNTS
  it('cada rechazo 409/422 tiene su motivo; 403 y fallos técnicos conservan el mensaje seguro', () => {
    expect(failureReason('roles', new ApiError(409))).toMatch('sin ninguna cuenta TI activa')
    expect(failureReason('create', new ApiError(409))).toMatch('Ya existe una cuenta con ese usuario')
    expect(failureReason('reset', new ApiError(422))).toBe('La contraseña debe tener entre 12 y 128 caracteres.')
    expect(failureReason('update', new ApiError(422))).toMatch('nombre visible no puede quedar vacío')
    expect(failureReason('user-exception', new ApiError(422))).toMatch('documento existente')
    expect(failureReason('disable', new ApiError(403))).toBeNull()
    expect(failureReason('disable', new ApiError(503))).toBeNull()
  })
  it('un nombre inválido se explica en el diálogo de edición', async () => {
    mount({ request: vi.fn(async () => { throw new ApiError(422) }) })
    const dialog = await pick('Ana Martínez', 'Editar nombre')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Guardar' }))
    expect(await within(dialog).findByText(/El nombre visible no puede quedar vacío/)).toBeVisible()
  })
  it('la contraseña exige entre 12 y 128 caracteres antes de enviar', async () => {
    mount(); await userEvent.click(await screen.findByRole('button', { name: 'Nueva cuenta' }))
    const field = within(screen.getByRole('dialog')).getByLabelText('Contraseña nueva')
    expect(field).toHaveAttribute('minlength', '12'); expect(field).toHaveAttribute('maxlength', '128')
    expect(field.getAttribute('aria-describedby')).toContain('password-rule')
    expect(screen.getByText('Entre 12 y 128 caracteres.')).toBeVisible()
  })
  it('darse alcance al propio rol advierte del cierre de sesión y lo anota para la pantalla de acceso', async () => {
    consumePermissionChange()
    const request = vi.fn(async () => null)
    mount({ request, reads: permissionReads })
    await userEvent.click(screen.getByRole('tab', { name: 'Permisos concedidos' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Dar acceso a TI en Litigios' }))
    const dialog = screen.getByRole('dialog', { name: 'Dar acceso' })
    expect(within(dialog).getByRole('note')).toHaveTextContent('se cerrará tu sesión')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Dar acceso' }))
    await waitFor(() => expect(request).toHaveBeenCalledWith('/security/document-scopes/TI/LITIGIOS', { method: 'PUT', body: { active: true } }))
    expect(consumePermissionChange()).toBe(true)
  })
  it('un cambio que no afecta a la propia cuenta no advierte ni anota nada', async () => {
    consumePermissionChange()
    const request = vi.fn(async () => null)
    mount({ request, reads: permissionReads })
    await userEvent.click(screen.getByRole('tab', { name: 'Permisos concedidos' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Dar acceso a Jurídico en Litigios' }))
    const dialog = screen.getByRole('dialog', { name: 'Dar acceso' })
    expect(within(dialog).queryByRole('note')).not.toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Dar acceso' }))
    await waitFor(() => expect(request).toHaveBeenCalled())
    expect(consumePermissionChange()).toBe(false)
  })
})

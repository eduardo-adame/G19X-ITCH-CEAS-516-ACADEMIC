/** SRS_REQUIRED y ROBUSTNESS (RF-068, SRS 0.26): lista de cuentas, permisos vigentes y acciones por fila. */
import { test, expect } from '@playwright/test'
import { mockSessionTI, PRINCIPAL_TI, showFilters } from './helpers.js'

const ANA = '22222222-2222-4222-8222-222222222222'
const account = (id, username, display_name, roles, state = 'ACTIVE') => ({ id, username, display_name, state, roles, created_at: '2026-10-01T10:00:00Z', disabled_at: state === 'DISABLED' ? '2026-10-02T10:00:00Z' : null })
const ACCOUNTS = [
  account(PRINCIPAL_TI.id, PRINCIPAL_TI.username, PRINCIPAL_TI.display_name, ['TI']),
  account(ANA, 'ana.martinez', 'Ana Martínez', ['ANALISTA', 'JURIDICO']),
  ...Array.from({ length: 8 }, (_, index) => account(`3333333${index}-3333-4333-8333-333333333333`, `cuenta.${index}`, `Cuenta sintética ${index}`, ['JURIDICO'], index === 7 ? 'DISABLED' : 'ACTIVE')),
]

async function mockDirectory(page) {
  const calls = []
  await mockSessionTI(page)
  await page.route('**/api/security/users?*', (route) => {
    const url = new URL(route.request().url()); calls.push(url.search)
    const q = (url.searchParams.get('q') || '').toLowerCase(); const state = url.searchParams.get('state')
    return route.fulfill({ json: { items: ACCOUNTS.filter((item) => (!q || `${item.username} ${item.display_name}`.toLowerCase().includes(q)) && (!state || item.state === state)), next_cursor: null } })
  })
  await page.route('**/api/security/document-scopes', (route) => route.fulfill({ json: { items: [{ role_id: 'JURIDICO', source_family: 'LITIGIOS', active: true }, { role_id: 'TI', source_family: 'CONTRATOS_DOCUMENTOS', active: true }] } }))
  await page.route('**/api/security/document-exceptions?*', (route) => route.fulfill({ json: { items: [{ id: '44444444-4444-4444-8444-444444444444', subject_type: 'USER', account_id: ANA, username: 'ana.martinez', display_name: 'Ana Martínez', role_id: null, document_id: 'DOC-007', decision: 'DENY', created_at: '2026-10-03T10:00:00Z' }], next_cursor: null } }))
  return calls
}

test('la lista de cuentas permite buscar y operar desde el menú de cada fila', async ({ page }) => {
  const calls = await mockDirectory(page)
  await page.goto('/administracion')
  const table = page.getByRole('table', { name: 'Cuentas registradas' })
  await expect(table.getByText('Ana Martínez')).toBeVisible()
  await expect(page.getByText('Identificador conocido de cuenta (UUID)')).toHaveCount(0)
  // El menú se dibuja fuera de la tabla: la última fila no lo recorta.
  const last = page.getByRole('button', { name: 'Acciones para Cuenta sintética 7' })
  await last.scrollIntoViewIfNeeded(); await last.click()
  const menu = page.getByRole('menu')
  await expect(menu.getByRole('menuitem', { name: 'Activar cuenta' })).toBeVisible()
  const box = await menu.boundingBox(); const viewport = page.viewportSize()
  expect(box.y).toBeGreaterThanOrEqual(0); expect(box.y + box.height).toBeLessThanOrEqual(viewport.height)
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await page.getByRole('button', { name: 'Acciones para Ana Martínez' }).click()
  await page.getByRole('menuitem', { name: 'Asignar roles' }).click()
  // La acción se abre en un diálogo sobre la lista, con los roles actuales marcados.
  const dialog = page.getByRole('dialog', { name: 'Asignar roles · Ana Martínez' })
  await expect(dialog.getByRole('group', { name: 'Cuenta seleccionada' })).toContainText('ana.martinez')
  await expect(dialog.getByRole('checkbox', { name: 'Analista' })).toBeChecked()
  await expect(dialog.getByRole('checkbox', { name: 'Jurídico' })).toBeChecked()
  await expect(dialog.getByRole('checkbox', { name: 'TI' })).not.toBeChecked()
  await dialog.getByRole('checkbox', { name: 'TI' }).check()
  await dialog.getByRole('button', { name: 'Revisar' }).click()
  await expect(dialog.getByRole('group', { name: 'Revisión' })).toContainText('quedará exactamente con: Jurídico · Analista · TI')
  await dialog.getByRole('button', { name: 'Volver' }).click()
  await dialog.getByRole('button', { name: 'Cancelar' }).click()
  await expect(dialog).toHaveCount(0)
  await page.getByRole('button', { name: 'Acciones para Usuario de Prueba' }).click()
  await expect(page.getByRole('menuitem', { name: /Asignar roles/ })).toHaveAttribute('aria-disabled', 'true')
  await page.keyboard.press('Escape')
  await showFilters(page)
  await page.getByLabel('Buscar por usuario o nombre').fill('martínez'); await page.getByLabel('Buscar por usuario o nombre').press('Enter')
  await expect(table.getByRole('row')).toHaveCount(2)
  expect(calls.at(-1)).toContain('q=mart%C3%ADnez')
})

test('permisos documentales: matriz de alcance y excepciones vigentes', async ({ page }) => {
  await mockDirectory(page)
  await page.goto('/administracion')
  await page.getByRole('tab', { name: 'Permisos concedidos' }).click()
  const matrix = page.getByRole('table', { name: 'Alcance por familia vigente' })
  await expect(matrix.getByRole('row', { name: /Jurídico/ }).getByText('Con acceso')).toBeVisible()
  const exceptions = page.getByRole('table', { name: 'Excepciones documentales vigentes' })
  await expect(exceptions.getByText('DOC-007')).toBeVisible()
  await exceptions.getByRole('button', { name: 'Acciones para la excepción de DOC-007' }).click()
  await page.getByRole('menuitem', { name: 'Cambiar a Autorizar' }).click()
  const dialog = page.getByRole('dialog', { name: 'Excepción de DOC-007' })
  await expect(dialog.getByLabel('Decisión documental')).toHaveValue('ALLOW')
  await expect(dialog.getByLabel('Identificador del documento')).toHaveValue('DOC-007')
  await expect(dialog.getByRole('group', { name: 'Cuenta seleccionada' })).toContainText('Ana Martínez')
})

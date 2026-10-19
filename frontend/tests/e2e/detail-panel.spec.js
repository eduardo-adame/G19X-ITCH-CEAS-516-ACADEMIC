/**
 * Spec: detalle de fila en panel lateral (Auditoría y Zona de cuarentena).
 * Clasificación: BROWSER_CONTRACT_E2E. Fixtures HTTP sintéticos con identificadores largos.
 * La fila conserva su alto, el panel no provoca desplazamiento horizontal y en móvil ocupa la pantalla.
 */
import { test, expect } from '@playwright/test'
import { mockSessionTI, mockDashboardEmpty } from './helpers.js'

const u = (n) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`
const AUDIT = { items: [1, 2].map((n) => ({
  id: u(n), occurred_at: `2026-10-1${n}T15:20:00Z`, actor_type: 'HUMAN', actor_identifier: 'analista.juridico@ejemplo.test', actor_user_id: u(9),
  action: 'QUARANTINE_REINJECT', resource_type: 'QUARANTINE_ITEM', resource_identifier: `${u(5)}/registro-fuente/${u(6)}`, result: 'SUCCESS',
  safe_cause_code: 'VALIDATION_RULE_FAILED_AFTER_CORRECTION', operation_id: u(7), correlation_id: u(8), query_sha256: null,
  resources: [{ resource_type: 'DOCUMENT', resource_identifier: u(4), id_documento: 'CONTRATO-ARRENDAMIENTO-2026-000123', fragment_id: u(3) }],
})), next_cursor: null }
const QUARANTINE = { items: [1, 2].map((n) => ({
  id: u(n), ingest_file_id: u(4), source_record_id: u(5), row_number: 12 + n, source_family: 'CUMPLIMIENTO', source_sheet: 'Contratos vigentes 2026',
  created_at: `2026-10-1${n}T15:20:00Z`, cause_code: 'MISSING_REQUIRED_FIELD', cause_description: 'Falta un campo obligatorio del registro', state: 'Pendiente',
  original_payload: { Dato: null }, candidate_payload: null, discard_justification: null,
})), next_cursor: null }

test.beforeEach(async ({ page }) => {
  await mockSessionTI(page)
  await mockDashboardEmpty(page)
})

for (const [view, path, api, data, button, title] of [
  ['Auditoría', '/auditoria', '**/api/audit/events**', AUDIT, 'Ver detalle de Reinyección de registro', 'Reinyección de registro'],
  ['Cuarentena', '/cuarentena', '**/api/validation/quarantine**', QUARANTINE, 'Ver detalle de la fila 13', 'Detalle del elemento retenido'],
]) {
  test(`${view}: el detalle se lee en un panel y la fila no cambia de alto`, async ({ page }, testInfo) => {
    await page.route(api, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) }))
    await page.goto(path)
    const open = page.getByRole('button', { name: button }).first()
    await expect(open).toBeVisible({ timeout: 8000 })
    const row = page.locator('tbody tr').first()
    const before = (await row.boundingBox()).height
    await open.click()
    const panel = page.getByRole('dialog', { name: title })
    await expect(panel).toBeVisible()
    // Mide con la animación de entrada terminada.
    await panel.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)))
    await expect(row).toHaveAttribute('data-selected', 'true')
    expect(Math.abs((await row.boundingBox()).height - before)).toBeLessThan(1)
    const box = await panel.boundingBox()
    const viewport = page.viewportSize()
    if (testInfo.project.name === 'narrow') expect(Math.round(box.width)).toBe(viewport.width)
    else expect(box.width).toBeLessThanOrEqual(481)
    expect(Math.round(box.x + box.width)).toBe(viewport.width)
    // Los identificadores largos caben a lo ancho del panel sin desplazamiento horizontal.
    expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.keyboard.press('Escape')
    await expect(panel).toBeHidden()
    await expect(open).toBeFocused()
  })
}

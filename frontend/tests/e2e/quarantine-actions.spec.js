/**
 * Spec: acciones de Zona de cuarentena en una sola línea.
 * Clasificación: BROWSER_CONTRACT_E2E. Fixtures HTTP sintéticos.
 * «Corregir» queda a la izquierda y «Descartar» a la derecha en la misma línea en todos los anchos; la nota de
 * un elemento que solo puede descartarse va debajo del botón.
 */
import { test, expect } from '@playwright/test'
import { mockSessionTI, mockDashboardEmpty } from './helpers.js'

const u = (n) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`
const item = (n, extra) => ({ id: u(n), ingest_file_id: u(4), source_record_id: u(5), row_number: 10 + n, source_family: 'CUMPLIMIENTO', source_sheet: null, created_at: `2026-10-1${n}T15:20:00Z`, cause_code: 'MISSING_REQUIRED_FIELD', cause_description: 'Falta un campo obligatorio del registro', state: 'Pendiente', original_payload: { Dato: null }, candidate_payload: null, discard_justification: null, ...extra })
const QUARANTINE = { items: [item(1), item(3, { cause_code: 'IDENTITY_CONFLICT', cause_description: 'Conflicto de identidad con un registro existente' })], next_cursor: null }

test.beforeEach(async ({ page }) => {
  await mockSessionTI(page)
  await mockDashboardEmpty(page)
})

test('Cuarentena: Corregir y Descartar comparten línea y la nota va debajo', async ({ page }) => {
  await page.route('**/api/validation/quarantine**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(QUARANTINE) }))
  await page.goto('/cuarentena')
  const [first, conflict] = [page.locator('tbody tr').nth(0), page.locator('tbody tr').nth(1)]
  const correct = await first.getByRole('button', { name: 'Corregir' }).boundingBox()
  const discard = await first.getByRole('button', { name: 'Descartar' }).boundingBox()
  expect(Math.abs(correct.y - discard.y)).toBeLessThan(1)
  expect(correct.x + correct.width).toBeLessThan(discard.x)
  await expect(conflict.getByRole('button', { name: 'Corregir' })).toHaveCount(0)
  const lone = await conflict.getByRole('button', { name: 'Descartar' }).boundingBox()
  const note = await conflict.getByText('Conflicto de identidad: solo puede descartarse').boundingBox()
  expect(note.y).toBeGreaterThanOrEqual(lone.y + lone.height)
})

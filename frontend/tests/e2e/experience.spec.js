/** ROBUSTNESS (DESIGN §21.2): título por vista, ayuda de indicadores, enlace a su vista y aviso sin conexión. */
import { test, expect } from '@playwright/test'
import { mockSessionTI, mockDashboardEmpty, SYNTHETIC_KPI_RESPONSE } from './helpers.js'

test('el indicador del resumen abre su vista con el periodo y explica qué mide', async ({ page }) => {
  await mockSessionTI(page); await mockDashboardEmpty(page)
  await page.route('**/api/dashboard/kpis**', (route) => route.fulfill({ json: SYNTHETIC_KPI_RESPONSE }))
  await page.goto('/?period=last_3_months')
  await expect(page).toHaveTitle('Resumen ejecutivo · Legaltech')
  await page.getByRole('button', { name: 'Qué mide: Obligaciones regulatorias vencidas sin atender' }).click()
  const note = page.getByRole('note')
  await expect(note).toContainText('fecha límite ya pasó')
  const box = await note.boundingBox(); const viewport = page.viewportSize()
  expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
  await page.keyboard.press('Escape')
  await expect(note).toHaveCount(0)
  await page.getByRole('link', { name: /Contratos próximos a vencimiento sin revisión \(ver en Riesgo contractual\)/ }).click()
  await expect(page).toHaveURL(/\/contratos\?period=last_3_months$/)
  await expect(page).toHaveTitle('Riesgo contractual · Legaltech')
})

test('sin red se avisa y el aviso desaparece al recuperarla', async ({ page, context }) => {
  await mockSessionTI(page); await mockDashboardEmpty(page)
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await context.setOffline(true)
  await expect(page.getByText('Sin conexión de red.', { exact: false })).toBeVisible()
  await context.setOffline(false)
  await expect(page.getByText('Sin conexión de red.', { exact: false })).toHaveCount(0)
})

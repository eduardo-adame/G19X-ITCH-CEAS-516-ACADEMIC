/**
 * Regresión de composición visual con fixtures de contrato (MOCKED, no backend
 * real). Los proyectos de Playwright ejecutan este spec en 1440×900, 1024×768 y
 * 390×844.
 */
import { test, expect } from '@playwright/test'
import { mockSessionTI, mockDashboardEmpty } from './helpers.js'

test.beforeEach(async ({ page }) => {
  await mockSessionTI(page)
  await mockDashboardEmpty(page)
})

test.describe('Composición Legal Minimal', () => {
  test('el resumen conserva la jerarquía de KPI y gráficas sin desbordamiento', async ({ page }) => {
    await page.goto('/')

    await expect(page.getByRole('heading', { name: 'Resumen ejecutivo' })).toBeVisible()
    await expect(page.locator('.kpi-row-five')).toBeVisible()
    await expect(page.getByText('Evolución de exposición acumulada', { exact: true })).toBeVisible()
    await expect(page.getByText('Composición por severidad', { exact: true })).toBeVisible()

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
    expect(overflow).toBe(false)
  })

  for (const route of ['/contratos', '/litigios']) {
    test(`no presenta superficies sin dimensión contractual en ${route}`, async ({ page }) => {
      await page.goto(route)

      await expect(page.locator('main h1')).toBeVisible()
      await expect(page.getByRole('region', { name: 'Exposición por tipo' })).toHaveCount(0)
      await expect(page.getByText('Exposición por tipo')).toHaveCount(0)

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
      expect(overflow).toBe(false)
    })
  }
})

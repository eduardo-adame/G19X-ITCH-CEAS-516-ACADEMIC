/** ROBUSTNESS: el área principal es el único contenedor desplazable; el documento nunca crece por debajo. */
import { test, expect } from '@playwright/test'
import { mockSessionTI, mockDashboardEmpty, SYNTHETIC_KPI_RESPONSE } from './helpers.js'

for (const path of ['/', '/contratos', '/litigios', '/tendencias', '/consulta', '/documentos', '/ingesta', '/cuarentena', '/auditoria', '/administracion']) {
  test(`${path}: al llegar al final no aparece espacio en blanco fuera del área principal`, async ({ page }) => {
    await mockSessionTI(page); await mockDashboardEmpty(page)
    await page.route('**/api/dashboard/kpis**', (route) => route.fulfill({ json: SYNTHETIC_KPI_RESPONSE }))
    await page.goto(path)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await page.waitForTimeout(500)
    const result = await page.evaluate(async () => {
      // Abre cualquier desplegable restante: sus tablas (con caption accesible) provocaban el desbordamiento.
      document.querySelectorAll('details').forEach((element) => { element.open = true })
      await new Promise((resolve) => setTimeout(resolve, 200))
      const main = document.querySelector('main')
      main.scrollTop = main.scrollHeight
      window.scrollTo(0, document.documentElement.scrollHeight)
      await new Promise((resolve) => setTimeout(resolve, 100))
      return { documentHeight: document.documentElement.scrollHeight, viewport: window.innerHeight, scrollY: window.scrollY }
    })
    expect(result.documentHeight).toBeLessThanOrEqual(result.viewport)
    expect(result.scrollY).toBe(0)
  })
}

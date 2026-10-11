import { test, expect } from '@playwright/test'
import { mockSessionTI, mockDashboardEmpty, mockLogout, RAG_EVIDENCIA_SUFICIENTE } from './helpers.js'

const notice = 'No fue posible validar tu sesión. Inicia sesión nuevamente.'
const fragment = RAG_EVIDENCIA_SUFICIENTE.fragments[0].fragment_text
async function initial(page) {
  await mockSessionTI(page); await mockDashboardEmpty(page); await mockLogout(page)
  await page.route('**/api/rag/query', (route) => route.fulfill({ json: RAG_EVIDENCIA_SUFICIENTE }))
  await page.goto('/consulta')
  await expect(page.getByLabel('Consulta en lenguaje natural')).toBeEnabled()
  await page.getByLabel('Consulta en lenguaje natural').fill('Consulta sintética de validación de sesión')
  await page.getByRole('button', { name: 'Consultar', exact: true }).click()
  await expect(page.getByText(fragment, { exact: true })).toBeVisible()
}
async function fail(page, failure) {
  await page.route('**/api/auth/me', (route) => failure === 'network' ? route.abort('failed') : route.fulfill({ status: failure, json: { detail: 'Detalle interno sintético no autorizado' } }))
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByLabel('Usuario', { exact: true })).toBeVisible()
  await expect(page.getByText(fragment, { exact: true })).toHaveCount(0)
}

test.describe('BROWSER_CONTRACT_E2E SRS_REQUIRED: revalidación de sesión segura', () => {
  for (const failure of [401, 403, 500, 503, 'network']) {
    test(`fallo${failure} retira evidencia y distingue el motivo técnico`, async ({ page }) => {
      await initial(page); await fail(page, failure)
      if ([500, 503, 'network'].includes(failure)) await expect(page.getByRole('alert')).toHaveText(notice)
      else await expect(page.getByText(notice)).toHaveCount(0)
      await expect(page.getByText(/Detalle interno/)).toHaveCount(0)
      expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 })
      expect(new URL(page.url()).search).toBe('')
    })
  }
  test('refresh no conserva motivo técnico ni reenvía la consulta', async ({ page }) => {
    await initial(page); await fail(page, 500)
    await expect(page.getByText(notice)).toBeVisible()
    await page.route('**/api/auth/refresh', (route) => route.fulfill({ status: 401, json: {} }))
    let posts = 0; page.on('request', (request) => { if (new URL(request.url()).pathname === '/api/rag/query') posts++ })
    await page.reload(); await expect(page.getByLabel('Usuario', { exact: true })).toBeVisible()
    await expect(page.getByText(notice)).toHaveCount(0); expect(posts).toBe(0)
  })
  test('login exitoso limpia motivo y logout voluntario no lo vuelve a mostrar', async ({ page }) => {
    await initial(page); await fail(page, 'network'); await expect(page.getByText(notice)).toBeVisible()
    await mockSessionTI(page)
    await page.getByLabel('Usuario', { exact: true }).fill('cuenta-sintetica')
    await page.getByLabel('Contraseña', { exact: true }).fill('clave-sintetica')
    await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Cerrar sesión' })).toBeVisible()
    await expect(page.getByText(notice)).toHaveCount(0)
    await page.getByRole('button', { name: 'Cerrar sesión' }).click()
    await expect(page.getByLabel('Usuario', { exact: true })).toBeVisible()
    await expect(page.getByText(notice)).toHaveCount(0)
  })
})

import { test, expect } from '@playwright/test'
import { mockSessionTI, mockDashboardEmpty, ME_RESPONSE_TI, RAG_EVIDENCIA_SUFICIENTE } from './helpers.js'

const fragment = RAG_EVIDENCIA_SUFICIENTE.fragments[0].fragment_text
const draft = 'Consulta sintética de conservación al cambiar foco'
function deferred() {
  let resolve
  const promise = new Promise((yes) => { resolve = yes })
  return { promise, resolve }
}
async function changeVisibility(page, state) {
  await page.evaluate((value) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value })
    document.dispatchEvent(new Event('visibilitychange'))
  }, state)
}
async function focusCycle(page) {
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await changeVisibility(page, 'hidden')
  await changeVisibility(page, 'visible')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
}
async function submit(page) {
  await page.goto('/consulta')
  const textarea = page.getByRole('textbox', { name: 'Consulta en lenguaje natural' })
  await expect(textarea).toBeEnabled()
  await textarea.fill(draft)
  await page.getByRole('button', { name: 'Consultar', exact: true }).click()
  return textarea
}
test.beforeEach(async ({ page }) => {
  await mockSessionTI(page)
  await mockDashboardEmpty(page)
})

test.describe('BROWSER_CONTRACT_E2E ROBUSTNESS: foco de consulta documental', () => {
  test('conserva borrador sin ejecutar consulta al volver visible', async ({ page }) => {
    const posts = []
    await page.route('**/api/rag/query', async (route) => { posts.push(route.request().headers()['idempotency-key']); await route.fulfill({ json: RAG_EVIDENCIA_SUFICIENTE }) })
    await page.goto('/consulta')
    const textarea = page.getByRole('textbox', { name: 'Consulta en lenguaje natural' })
    await expect(textarea).toBeEnabled()
    await textarea.fill(draft)
    await focusCycle(page)
    await expect(textarea).toBeEnabled()
    await expect(textarea).toHaveValue(draft)
    expect(posts).toHaveLength(0)
  })

  test('conserva resultado y visor después de blur/hidden/focus con un único POST', async ({ page }) => {
    const posts = []
    await page.route('**/api/rag/query', async (route) => { posts.push(route.request().headers()['idempotency-key']); await route.fulfill({ json: RAG_EVIDENCIA_SUFICIENTE }) })
    const textarea = await submit(page)
    await expect(page.getByText(fragment, { exact: true })).toBeVisible()
    await focusCycle(page)
    await expect(textarea).toBeEnabled()
    await expect(textarea).toHaveValue(draft)
    await expect(page.getByText(fragment, { exact: true })).toBeVisible()
    await page.getByRole('link', { name: 'Ver fragmento en visor' }).click()
    await expect(page.getByRole('heading', { name: 'Visor documental' })).toBeVisible()
    await focusCycle(page)
    await expect(page.getByText(fragment, { exact: true })).toBeVisible()
    expect(posts).toHaveLength(1)
  })

  test('solicitud demorada conserva identidad y bloqueo de B tras volver al foco', async ({ page }) => {
    const response = deferred(), received = deferred(), posts = []
    await page.route('**/api/rag/query', async (route) => {
      posts.push(route.request().headers()['idempotency-key']); received.resolve()
      await response.promise
      await route.fulfill({ json: RAG_EVIDENCIA_SUFICIENTE })
    })
    const textarea = await submit(page)
    await received.promise
    const key = posts[0]
    await focusCycle(page)
    await expect(textarea).toHaveValue(draft)
    await expect(textarea).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Consultar', exact: true })).toBeDisabled()
    expect(posts).toEqual([key])
    response.resolve()
    await expect(page.getByText(fragment, { exact: true })).toBeVisible()
    await expect(textarea).toBeEnabled()
    expect(posts).toEqual([key])
  })

  test('retry explícito conserva key después del cambio de foco', async ({ page }) => {
    const posts = []
    await page.route('**/api/rag/query', async (route) => {
      posts.push(route.request().headers()['idempotency-key'])
      if (posts.length === 1) await route.abort('failed')
      else await route.fulfill({ json: RAG_EVIDENCIA_SUFICIENTE })
    })
    await submit(page)
    await expect(page.getByRole('button', { name: 'Reintentar la misma operación' })).toBeVisible()
    await focusCycle(page)
    await expect(page.getByRole('button', { name: 'Consultar', exact: true })).toBeEnabled()
    expect(posts).toHaveLength(1)
    await page.getByRole('button', { name: 'Reintentar la misma operación' }).click()
    await expect(page.getByText(fragment, { exact: true })).toBeVisible()
    expect(posts).toHaveLength(2)
    expect(posts[1]).toBe(posts[0])
  })
})

test.describe('BROWSER_CONTRACT_E2E SRS_REQUIRED: evidencia y revalidación vigente', () => {
  test('oculta evidencia durante /auth/me pendiente y la devuelve sólo al éxito sin POST', async ({ page }) => {
    let posts = 0
    await page.route('**/api/rag/query', async (route) => { posts++; await route.fulfill({ json: RAG_EVIDENCIA_SUFICIENTE }) })
    const textarea = await submit(page)
    await expect(page.getByText(fragment, { exact: true })).toBeVisible()
    const verification = deferred(), received = deferred()
    await page.route('**/api/auth/me', async (route) => { received.resolve(); await verification.promise; await route.fulfill({ json: ME_RESPONSE_TI }) })
    await focusCycle(page)
    await received.promise
    await expect(page.getByText(fragment, { exact: true })).toHaveCount(0)
    await expect(textarea).toHaveValue(draft)
    await expect(textarea).toBeDisabled()
    verification.resolve()
    await expect(page.getByText(fragment, { exact: true })).toBeVisible()
    await expect(textarea).toHaveValue(draft)
    expect(posts).toBe(1)
  })

  test('fallo de revalidación retira el resultado sin recuperar ni repetir RAG', async ({ page }) => {
    let posts = 0
    await page.route('**/api/rag/query', async (route) => { posts++; await route.fulfill({ json: RAG_EVIDENCIA_SUFICIENTE }) })
    await submit(page)
    await expect(page.getByText(fragment, { exact: true })).toBeVisible()
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 503, json: {} }))
    await focusCycle(page)
    await expect(page.getByText(fragment, { exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Iniciar sesión' })).toBeVisible()
    expect(posts).toBe(1)
  })
})

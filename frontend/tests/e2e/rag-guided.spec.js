import { test, expect } from '@playwright/test'
import { mockSessionTI, mockDashboardEmpty, RAG_SIN_EVIDENCIA, RAG_EVIDENCIA_SUFICIENTE } from './helpers.js'

const suggestions = [
  '¿Qué obligaciones aparecen en los documentos disponibles?',
  '¿Qué fechas relevantes aparecen en la documentación?',
  '¿Qué cláusulas relacionadas con terminación están disponibles?',
  '¿Qué información existe sobre un asunto específico?',
]
test.beforeEach(async ({ page }) => { await mockSessionTI(page); await mockDashboardEmpty(page) })
async function observe(page, dto = RAG_SIN_EVIDENCIA) {
  const requests = []
  await page.route('**/api/rag/query', async (route) => {
    requests.push({ body: route.request().postDataJSON(), key: route.request().headers()['idempotency-key'] })
    await route.fulfill({ json: dto })
  })
  return requests
}
async function submit(page, query) {
  const textarea = page.getByRole('textbox', { name: 'Tu consulta' })
  await expect(textarea).toBeEnabled()
  await textarea.fill(query)
  await page.getByRole('button', { name: 'Consultar', exact: true }).click()
  return textarea
}

test.describe('BROWSER_CONTRACT_E2E ROBUSTNESS: interacción local guiada', () => {
  for (const [query, message] of [['hola', 'Hola. Puedo ayudarte'], ['qué puedes hacer', 'Puedo buscar información'], ['gracias', 'Con gusto. Puedes realizar otra consulta']]) {
    test(`${query} produce respuesta inmediata con cero POST RAG`, async ({ page }) => {
      const requests = await observe(page)
      await page.goto('/consulta')
      const textarea = await submit(page, query)
      await expect(page.getByRole('status', { name: 'Respuesta local' })).toContainText(message)
      await expect(textarea).toHaveValue(query)
      await expect(page.getByText('Sin evidencia', { exact: true })).toHaveCount(0)
      await expect(page.getByText('Buscando en tus documentos autorizados…')).toHaveCount(0)
      await expect(page.getByRole('link', { name: 'Abrir en el visor' })).toHaveCount(0)
      expect(requests).toHaveLength(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    })
  }

  test('las cuatro sugerencias prefillean sin POST y se pueden editar antes de enviar', async ({ page }) => {
    const requests = await observe(page)
    await page.goto('/consulta')
    const region = page.getByRole('region', { name: 'Preguntas sugeridas' })
    await expect(region.getByRole('button')).toHaveCount(4)
    const textarea = page.getByRole('textbox', { name: 'Tu consulta' })
    for (const suggestion of suggestions) {
      await region.getByRole('button', { name: suggestion, exact: true }).click()
      await expect(textarea).toHaveValue(suggestion)
      expect(requests).toHaveLength(0)
    }
    const query = 'Consulta sintética editada sobre fechas'
    await textarea.fill(query)
    await page.getByRole('button', { name: 'Consultar', exact: true }).click()
    await expect(page.getByText('Sin evidencia', { exact: true })).toBeVisible()
    expect(requests).toHaveLength(1)
    expect(requests[0].body).toEqual({ query })
    await expect(region).toHaveCount(0)
  })

  test('sugerencia alcanzable por teclado prefillea sin enviar ni mover foco', async ({ page }) => {
    const requests = await observe(page)
    await page.goto('/consulta')
    const button = page.getByRole('button', { name: suggestions[0], exact: true })
    await expect(button).toBeVisible()
    await page.getByRole('button', { name: 'Consultar', exact: true }).focus()
    await page.keyboard.press('Tab')
    await expect(button).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(button).toBeFocused()
    await expect(page.getByRole('textbox', { name: 'Tu consulta' })).toHaveValue(suggestions[0])
    expect(requests).toHaveLength(0)
  })

  for (const query of ['Hola, ¿qué obligaciones contiene el contrato Alfa?', 'gracias, ¿qué fechas contiene el contrato?', '¿Cuál es la capital de Japón?']) {
    test(`entrada no local conserva el flujo documental: ${query}`, async ({ page }) => {
      const requests = await observe(page)
      await page.goto('/consulta'); await submit(page, query)
      await expect(page.getByText('Sin evidencia', { exact: true })).toBeVisible()
      await expect(page.getByRole('status', { name: 'Respuesta local' })).toHaveCount(0)
      await expect(page.getByText('Tokio', { exact: true })).toHaveCount(0)
      expect(requests).toHaveLength(1)
      expect(requests[0].body).toEqual({ query })
    })
  }

  for (const [name, query] of [['FEFF', '\ufeff'], ['espacio de ancho cero', '\u200b']]) {
    test(`${name} conserva la validación de Python y el texto exacto enviado a RAG`, async ({ page }) => {
      const requests = await observe(page)
      await page.goto('/consulta'); await submit(page, query)
      await expect(page.getByText('Sin evidencia', { exact: true })).toBeVisible()
      await expect(page.getByRole('status', { name: 'Respuesta local' })).toHaveCount(0)
      expect(requests).toHaveLength(1)
      expect(requests[0].body).toEqual({ query })
    })
  }

  for (const query of [' \t ', `hola${' '.repeat(4093)}`]) {
    test(`blanco o saludo sobredimensionado rechaza antes de router y POST (${query.length})`, async ({ page }) => {
      const requests = await observe(page)
      await page.goto('/consulta'); await submit(page, query)
      await expect(page.getByRole('alert')).toContainText('Revisa los datos de la solicitud')
      await expect(page.getByRole('status', { name: 'Respuesta local' })).toHaveCount(0)
      expect(requests).toHaveLength(0)
    })
  }

  test('blur/hidden/foco conservan respuesta local sin POST y limpiar restaura sugerencias', async ({ page }) => {
    const requests = await observe(page)
    await page.goto('/consulta'); await submit(page, 'hola')
    await expect(page.getByRole('status', { name: 'Respuesta local' })).toBeVisible()
    await page.evaluate(() => {
      window.dispatchEvent(new Event('blur'))
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await expect(page.getByRole('status', { name: 'Respuesta local' })).toBeVisible()
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
      document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus'))
    })
    await expect(page.getByRole('status', { name: 'Respuesta local' })).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Tu consulta' })).toHaveValue('hola')
    await page.getByRole('button', { name: 'Nueva consulta' }).click()
    await expect(page.getByRole('region', { name: 'Preguntas sugeridas' }).getByRole('button')).toHaveCount(4)
    await expect(page.getByRole('status', { name: 'Respuesta local' })).toHaveCount(0)
    expect(requests).toHaveLength(0)
  })

  test('RAG→local→RAG retira evidencia anterior y conserva consultas independientes', async ({ page }) => {
    const requests = await observe(page, RAG_EVIDENCIA_SUFICIENTE)
    await page.goto('/consulta'); await submit(page, 'Consulta documental A')
    await expect(page.getByText(RAG_EVIDENCIA_SUFICIENTE.fragments[0].fragment_text, { exact: true })).toBeVisible()
    await submit(page, 'gracias')
    await expect(page.getByRole('status', { name: 'Respuesta local' })).toBeVisible()
    await expect(page.getByText(RAG_EVIDENCIA_SUFICIENTE.fragments[0].fragment_text, { exact: true })).toHaveCount(0)
    expect(requests).toHaveLength(1)
    await submit(page, 'Consulta documental B')
    await expect(page.getByText(RAG_EVIDENCIA_SUFICIENTE.fragments[0].fragment_text, { exact: true })).toBeVisible()
    expect(requests).toHaveLength(2)
    expect(requests[1].body).toEqual({ query: 'Consulta documental B' })
    expect(requests[1].key).not.toBe(requests[0].key)
    await page.getByRole('link', { name: 'Abrir en el visor' }).click()
    await expect(page.getByRole('heading', { name: 'Visor documental' })).toBeVisible()
  })

  test('F5 no restaura respuesta local ni realiza POST automático', async ({ page }) => {
    const requests = await observe(page)
    await page.goto('/consulta'); await submit(page, 'hola')
    await expect(page.getByRole('status', { name: 'Respuesta local' })).toBeVisible()
    await page.reload()
    await expect(page.getByRole('region', { name: 'Preguntas sugeridas' })).toBeVisible()
    await expect(page.getByRole('status', { name: 'Respuesta local' })).toHaveCount(0)
    await expect(page.getByRole('textbox', { name: 'Tu consulta' })).toHaveValue('')
    expect(requests).toHaveLength(0)
  })
})

test.describe('BROWSER_CONTRACT_E2E SRS_REQUIRED: revalidación de respuesta local', () => {
  test('fallo de identidad al volver al foco retira local y lleva a login seguro', async ({ page }) => {
    const requests = await observe(page)
    await page.goto('/consulta'); await submit(page, 'hola')
    await expect(page.getByRole('status', { name: 'Respuesta local' })).toBeVisible()
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 503, json: {} }))
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(page.getByRole('button', { name: 'Iniciar sesión', exact: true })).toBeVisible()
    await expect(page.getByRole('status', { name: 'Respuesta local' })).toHaveCount(0)
    await expect(page.getByRole('alert')).toBeVisible()
    expect(requests).toHaveLength(0)
  })
})

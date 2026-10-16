import { test, expect } from '@playwright/test'
import { mockSessionTI, mockDashboardEmpty, ME_RESPONSE_TI, RAG_EVIDENCIA_SUFICIENTE, RAG_SIN_EVIDENCIA, RAG_SIN_AUTORIZACION } from './helpers.js'

const explanations = {
  EVIDENCIA_INSUFICIENTE: 'Encontré información relacionada, pero la evidencia disponible no es suficiente para responder esta consulta con certeza. Puedes intentar especificar el documento, una fecha, una cláusula o el asunto que buscas.',
  SIN_EVIDENCIA: 'No encontré evidencia en los documentos a los que tienes acceso que permita responder esta pregunta. Puedes intentar indicar el nombre del documento, una fecha, una cláusula o el asunto que buscas.',
  SIN_AUTORIZACION: 'No puedo proporcionar información para esta consulta con tu nivel de acceso actual.',
}
function referenceDto() { return { ...RAG_EVIDENCIA_SUFICIENTE, state: 'EVIDENCIA_INSUFICIENTE', generation_status: 'NOT_REQUESTED', generated_response: null, safe_result_message: 'Mensaje DTO sintético anterior.', citations: [], fragments: RAG_EVIDENCIA_SUFICIENTE.fragments.map((fragment) => ({ ...fragment, usage: 'REFERENCE' })) } }
function deferred() { let resolve; const promise = new Promise((yes) => { resolve = yes }); return { promise, resolve } }
test.beforeEach(async ({ page }) => { await mockSessionTI(page); await mockDashboardEmpty(page) })
async function mockRag(page, dto = RAG_SIN_EVIDENCIA, status = 200) {
  const requests = []
  await page.route('**/api/rag/query', async (route) => { requests.push(route.request().postDataJSON()); await route.fulfill({ status, json: dto }) })
  return requests
}
async function submit(page, query = 'Consulta documental sintética') {
  const textarea = page.getByRole('textbox', { name: 'Consulta en lenguaje natural' })
  await expect(textarea).toBeEnabled()
  await textarea.fill(query)
  await page.getByRole('button', { name: 'Consultar', exact: true }).click()
  return textarea
}

test.describe('BROWSER_CONTRACT_E2E ROBUSTNESS: pregunta enviada actual', () => {
  for (const [kind, query] of [['local', 'hola'], ['RAG', 'Consulta documental sintética']]) {
    test(`Tú ${kind} conserva snapshot al editar el borrador y no añade historial`, async ({ page }) => {
      const requests = await mockRag(page)
      await page.goto('/consulta')
      const textarea = await submit(page, query)
      const question = page.getByRole('region', { name: 'Tu consulta enviada' })
      await expect(question).toContainText(query)
      if (kind === 'RAG') await expect(page.getByText(explanations.SIN_EVIDENCIA)).toBeVisible()
      else await expect(page.getByRole('status', { name: 'Respuesta local' })).toBeVisible()
      await textarea.fill('Borrador sintético distinto')
      await expect(question).toContainText(query)
      await expect(question).not.toContainText('Borrador sintético distinto')
      expect(requests).toHaveLength(kind === 'RAG' ? 1 : 0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    })
  }

  test('pregunta enviada con HTML potencial se muestra como texto', async ({ page }) => {
    await mockRag(page)
    await page.goto('/consulta')
    const query = '<img src=x onerror=window.__sent_xss=1>'
    await submit(page, query)
    await expect(page.getByRole('region', { name: 'Tu consulta enviada' })).toContainText(query)
    expect(await page.evaluate(() => window.__sent_xss)).toBeUndefined()
    await expect(page.locator('[onerror]')).toHaveCount(0)
  })
})

test.describe('BROWSER_CONTRACT_E2E SRS_REQUIRED: presentación canónica y fuentes', () => {
  for (const [state, label, dto] of [
    ['EVIDENCIA_INSUFICIENTE', 'Evidencia insuficiente', referenceDto()],
    ['SIN_EVIDENCIA', 'Sin evidencia', { ...RAG_SIN_EVIDENCIA, safe_result_message: 'Mensaje DTO sintético anterior.' }],
    ['SIN_AUTORIZACION', 'Sin autorización', RAG_SIN_AUTORIZACION],
  ]) {
    test(`${state} conserva su estado y muestra explicación aprobada sin duplicados`, async ({ page }) => {
      const requests = await mockRag(page, dto)
      await page.goto('/consulta'); await submit(page)
      await expect(page.getByText(label, { exact: true })).toBeVisible()
      await expect(page.getByText(explanations[state], { exact: true })).toHaveCount(1)
      await expect(page.getByText('Mensaje DTO sintético anterior.', { exact: true })).toHaveCount(0)
      await expect(page.getByRole('region', { name: 'Respuesta generada' })).toHaveCount(0)
      await expect(page.getByRole('region', { name: 'Fuentes citadas' })).toHaveCount(0)
      if (state === 'EVIDENCIA_INSUFICIENTE') {
        const sources = page.getByRole('region', { name: 'Fuentes relacionadas' })
        await expect(sources.getByRole('heading', { name: 'Fuentes relacionadas (1)' })).toBeVisible()
        await expect(sources.getByText('Referencia', { exact: true })).toBeVisible()
        await sources.getByRole('link', { name: 'Abrir en el visor' }).click()
        await expect(page.getByRole('heading', { name: 'Visor documental' })).toBeVisible()
        await expect(page.getByText(dto.fragments[0].fragment_text, { exact: true })).toBeVisible()
      } else await expect(page.getByRole('region', { name: 'Fuentes relacionadas' })).toHaveCount(0)
      expect(requests).toHaveLength(1)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    })
  }

  test('Estado 1 conserva síntesis, cita y encabezados de fuentes anteriores', async ({ page }) => {
    const requests = await mockRag(page, RAG_EVIDENCIA_SUFICIENTE)
    await page.goto('/consulta'); await submit(page)
    await expect(page.getByRole('region', { name: 'Respuesta generada' })).toContainText(RAG_EVIDENCIA_SUFICIENTE.generated_response)
    const sources = page.getByRole('region', { name: 'Fuentes citadas' })
    await expect(sources.getByRole('heading', { name: 'Fuentes citadas (1)' })).toBeVisible()
    await expect(sources).toContainText('[E1]')
    // La marca [E1] de la respuesta lleva el foco a su fuente.
    await page.getByRole('region', { name: 'Respuesta generada' }).getByRole('button', { name: /^Ir a la fuente E1/ }).click()
    await expect(sources.getByRole('article')).toBeFocused()
    expect(requests).toHaveLength(1)
  })

  test('fallo técnico mantiene mensaje/error y referencias sin explicación de éxito', async ({ page }) => {
    const dto = { ...referenceDto(), operation_status: 'FAILED', generation_status: 'FAILED', safe_result_message: 'Fallo técnico sintético controlado.' }
    await mockRag(page, dto)
    await page.goto('/consulta'); await submit(page)
    await expect(page.getByRole('alert')).toContainText('El servicio no está disponible')
    await expect(page.getByText('Evidencia insuficiente', { exact: true })).toBeVisible()
    await expect(page.getByText('Fallo técnico sintético controlado.', { exact: true })).toBeVisible()
    await expect(page.getByText(explanations.EVIDENCIA_INSUFICIENTE, { exact: true })).toHaveCount(0)
    await expect(page.getByRole('region', { name: 'Fuentes relacionadas' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Intentar de nuevo' })).toBeVisible()
  })

  test('estado null fallido con mensaje null conserva error explícito sin inventar evidencia', async ({ page }) => {
    await mockRag(page, { ...RAG_SIN_EVIDENCIA, state: null, operation_status: 'FAILED', safe_result_message: null })
    await page.goto('/consulta'); await submit(page)
    await expect(page.getByRole('alert')).toContainText('El servicio no está disponible')
    await expect(page.getByText(explanations.SIN_EVIDENCIA, { exact: true })).toHaveCount(0)
    await expect(page.getByText(explanations.EVIDENCIA_INSUFICIENTE, { exact: true })).toHaveCount(0)
    await expect(page.getByRole('region', { name: 'Fuentes citadas' })).toHaveCount(0); await expect(page.getByRole('region', { name: 'Fuentes relacionadas' })).toHaveCount(0)
  })

  for (const status of [401, 403, 500]) {
    test(`HTTP${status} sigue siendo error sin presentar un estado funcional inventado`, async ({ page }) => {
      await mockRag(page, {}, status)
      await page.goto('/consulta')
      await expect(page.getByRole('textbox', { name: 'Consulta en lenguaje natural' })).toBeEnabled()
      if (status === 401) {
        await page.route('**/api/auth/refresh', (route) => route.fulfill({ status: 401, json: {} }))
      }
      await submit(page)
      if (status === 401) await expect(page.getByRole('button', { name: 'Iniciar sesión', exact: true })).toBeVisible()
      else await expect(page.getByRole('alert')).toBeVisible()
      for (const message of Object.values(explanations)) await expect(page.getByText(message, { exact: true })).toHaveCount(0)
      await expect(page.getByRole('region', { name: 'Fuentes citadas' })).toHaveCount(0); await expect(page.getByRole('region', { name: 'Fuentes relacionadas' })).toHaveCount(0)
    })
  }

  for (const [kind, query] of [['local', 'hola'], ['RAG', 'Consulta documental sintética']]) {
    test(`revalidación pendiente retira del DOM pregunta y respuesta ${kind}`, async ({ page }) => {
      const requests = await mockRag(page)
      await page.goto('/consulta'); await submit(page, query)
      if (kind === 'RAG') await expect(page.getByText(explanations.SIN_EVIDENCIA)).toBeVisible()
      else await expect(page.getByRole('status', { name: 'Respuesta local' })).toBeVisible()
      const verification = deferred(), received = deferred()
      await page.route('**/api/auth/me', async (route) => { received.resolve(); await verification.promise; await route.fulfill({ json: ME_RESPONSE_TI }) })
      await page.evaluate(() => window.dispatchEvent(new Event('focus')))
      await received.promise
      await expect(page.getByRole('region', { name: 'Tu consulta enviada' })).toHaveCount(0)
      await expect(page.getByRole('region', { name: 'Resultado de la consulta' })).toHaveCount(0)
      await expect(page.getByRole('status', { name: 'Respuesta local' })).toHaveCount(0)
      await expect(page.getByRole('textbox', { name: 'Consulta en lenguaje natural' })).toHaveValue(query)
      verification.resolve()
      await expect(page.getByRole('region', { name: 'Tu consulta enviada' })).toBeVisible()
      expect(requests).toHaveLength(kind === 'local' ? 0 : 1)
    })
  }
})

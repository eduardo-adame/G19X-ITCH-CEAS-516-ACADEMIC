import { test, expect } from '@playwright/test'
import { mockSessionTI, mockDashboardEmpty, RAG_SIN_EVIDENCIA } from './helpers.js'

const alphabets = [['ASCII', 'a'], ['ñ precompuesta', 'ñ'], ['emoji', '😀']]
const lengths = [4095, 4096, 4097]
const matrix = alphabets.flatMap(([name, character]) => lengths.map((length) => [name, length, character.repeat(length)]))
const mixed = [
  ['mixta MAX-1', `${'a'.repeat(4094)}😀`, true],
  ['mixta MAX', `${'a'.repeat(4095)}😀`, true],
  ['mixta MAX+1', `${'a'.repeat(4096)}😀`, false],
  ['combinante MAX', 'n\u0303'.repeat(2048), true],
  ['combinante MAX+1', `${'n\u0303'.repeat(2048)}n`, false],
]

test.beforeEach(async ({ page }) => {
  await mockSessionTI(page)
  await mockDashboardEmpty(page)
})

async function inputAndSubmit(page, query, accepted) {
  const requests = []
  await page.route('**/api/rag/query', async (route) => {
    requests.push({ query: route.request().postDataJSON().query, key: route.request().headers()['idempotency-key'] })
    await route.fulfill({ json: RAG_SIN_EVIDENCIA })
  })
  await page.goto('/consulta')
  const textarea = page.getByRole('textbox', { name: 'Tu consulta' })
  await expect(textarea).toBeEnabled()
  await textarea.focus()
  // La entrada de teclado permite verificar el límite real del control, sin asignar su valor por fill.
  await page.keyboard.insertText(query)
  await expect(textarea).toHaveValue(query)
  expect(await textarea.evaluate((element) => ({ points: Array.from(element.value).length, units: element.value.length }))).toEqual({ points: Array.from(query).length, units: query.length })
  await page.getByRole('button', { name: 'Consultar', exact: true }).click()
  if (accepted) {
    await expect(page.getByText('Sin evidencia', { exact: true })).toBeVisible()
    expect(requests).toHaveLength(1)
    expect(requests[0].query).toBe(query)
    expect(requests[0].key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  } else {
    await expect(page.getByRole('alert')).toContainText('Revisa los datos de la solicitud')
    expect(requests).toHaveLength(0)
  }
  await expect(textarea).toHaveValue(query)
}

test.describe('BROWSER_CONTRACT_E2E ROBUSTNESS: límite Unicode de consulta', () => {
  for (const [name, length, query] of matrix) {
    test(`${name} con ${length} puntos usa teclado y conserva texto sin truncación`, async ({ page }) => {
      await inputAndSubmit(page, query, length <= 4096)
    })
  }
  for (const [name, query, accepted] of mixed) {
    test(`${name} conserva la representación exacta y valida puntos de código`, async ({ page }) => {
      await inputAndSubmit(page, query, accepted)
    })
  }
})

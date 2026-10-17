/** ROBUSTNESS y SRS_REQUIRED (RF-077, SRS 0.25): herramientas del visor e impresión auditada con un PDF sintético. */
import { test, expect } from '@playwright/test'
import { mockSessionTI } from './helpers.js'

const VERSION = '55555555-5555-4555-8555-555555555555'
const PDF_ITEM = { document_id: 'DOC-PDF', document_version_id: VERSION, version_number: 2, document_name: 'Contrato sintético de prueba', document_type: 'PDF', source_family: 'CONTRATOS_DOCUMENTOS', document_date: null, representation: 'PDF_ORIGINAL', text_available: true }
const TEXT = 'Primera cláusula sintética.\nSegunda CLAUSULA sintética.\nCierre del documento.'

// PDF mínimo válido de varias páginas, generado en la prueba (sin archivos reales).
function syntheticPdf(pages) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pages} >>`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  for (let page = 1; page <= pages; page++) {
    const stream = `BT /F1 36 Tf 72 700 Td (Pagina ${page}) Tj ET`
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + (page - 1) * 2} 0 R >>`)
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
  }
  let body = '%PDF-1.4\n'
  const offsets = objects.map((object, index) => { const offset = body.length; body += `${index + 1} 0 obj\n${object}\nendobj\n`; return offset })
  const xref = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return Buffer.from(body, 'latin1')
}

async function mockViewer(page, { printStatus = 200 } = {}) {
  const calls = []
  await mockSessionTI(page)
  await page.addInitScript(() => {
    window.__printed = []
    // El diálogo del navegador no existe en la prueba: se registra qué se habría impreso.
    window.print = () => { const root = document.querySelector('.print-root'); window.__printed.push({ text: root?.innerText ?? '', images: root?.querySelectorAll('img').length ?? 0 }) }
  })
  await page.route('**/api/documents/viewer**', async (route) => {
    const url = new URL(route.request().url())
    calls.push(`${route.request().method()} ${url.pathname}`)
    if (url.pathname.endsWith('/print')) return route.fulfill(printStatus === 200 ? { json: { operation_id: '66666666-6666-4666-8666-666666666666', correlation_id: '77777777-7777-4777-8777-777777777777' } } : { status: printStatus, json: { detail: 'Operación no confirmada' } })
    if (url.pathname.endsWith('/original')) return route.fulfill({ status: 200, contentType: 'application/pdf', body: syntheticPdf(3) })
    if (url.pathname.endsWith('/DOC-PDF')) return route.fulfill({ json: { ...PDF_ITEM, text: TEXT, operation_id: '88888888-8888-4888-8888-888888888888', correlation_id: '99999999-9999-4999-8999-999999999999' } })
    return route.fulfill({ json: { items: [PDF_ITEM], next_cursor: null } })
  })
  return calls
}

test('página escrita, flechas y zoom en el PDF original', async ({ page }) => {
  await mockViewer(page)
  await page.goto(`/documentos?document_id=DOC-PDF&version_id=${VERSION}`)
  const field = page.getByRole('textbox', { name: 'Página' })
  await expect(field).toHaveValue('1')
  await expect(page.getByText('de 3', { exact: true })).toBeVisible()
  await field.fill('3'); await field.press('Enter')
  await expect(page.getByRole('img', { name: 'Página 3 de 3 del PDF original' })).toBeVisible()
  await page.getByRole('region', { name: /del PDF original/ }).focus()
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByRole('img', { name: 'Página 2 de 3 del PDF original' })).toBeVisible()
  const fit = page.getByRole('button', { name: 'Ajustar al ancho' })
  await expect(fit).toHaveAttribute('aria-pressed', 'true')
  const canvas = page.getByRole('img', { name: /del PDF original/ })
  const fitted = (await canvas.boundingBox()).width
  const region = (await page.getByRole('region', { name: /del PDF original/ }).boundingBox()).width
  expect(fitted).toBeLessThanOrEqual(region)
  await page.getByRole('button', { name: 'Acercar' }).click()
  await page.getByRole('button', { name: 'Acercar' }).click()
  await expect(fit).toHaveAttribute('aria-pressed', 'false')
  await expect.poll(async () => (await canvas.boundingBox()).width).not.toBe(fitted)
  await fit.click()
  await expect.poll(async () => Math.round((await canvas.boundingBox()).width)).toBe(Math.round(fitted))
})

test('la ayuda explica el visor y la búsqueda resalta en el texto procesado', async ({ page }) => {
  await mockViewer(page)
  await page.goto(`/documentos?document_id=DOC-PDF&version_id=${VERSION}`)
  await page.getByRole('button', { name: 'Ayuda del visor' }).click()
  await expect(page.getByText(/cada apertura y cada impresión quedan registradas/)).toBeVisible()
  await page.getByRole('button', { name: 'Texto completo procesado' }).click()
  await page.getByRole('searchbox', { name: 'Buscar en el texto' }).fill('clausula')
  await expect(page.locator('#viewer-search-status')).toHaveText('1 de 2')
  await expect(page.locator('mark.search-hit')).toHaveCount(2)
})

test('imprimir registra la auditoría antes de abrir el diálogo y cada hoja lleva su pie', async ({ page }) => {
  const calls = await mockViewer(page)
  await page.goto(`/documentos?document_id=DOC-PDF&version_id=${VERSION}`)
  await expect(page.getByRole('img', { name: 'Página 1 de 3 del PDF original' })).toBeVisible()
  await page.getByRole('button', { name: 'Imprimir' }).click()
  const dialog = page.getByRole('dialog', { name: 'Imprimir documento' })
  await expect(dialog.getByRole('radio', { name: 'Todo el documento (3 páginas)' })).toBeChecked()
  await dialog.getByRole('button', { name: 'Imprimir' }).click()
  await expect.poll(() => page.evaluate(() => window.__printed.length)).toBe(1)
  expect(calls).toContain(`POST /api/documents/viewer/DOC-PDF/print`)
  const printed = await page.evaluate(() => window.__printed[0])
  expect(printed.images).toBe(3)
  expect(printed.text).toContain('Impreso por Usuario de Prueba (usuario-prueba)')
  expect(printed.text).toContain('Contrato sintético de prueba, versión 2 · Página 3 de 3')
  // En medio impreso solo se ven las hojas; la aplicación queda oculta.
  await page.emulateMedia({ media: 'print' })
  await expect(page.locator('.print-root')).toBeVisible()
  await expect(page.locator('#root')).toBeHidden()
  await page.emulateMedia({ media: 'screen' })
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')))
  await expect(page.locator('.print-root')).toHaveCount(0)
})

test('si la auditoría no confirma el registro no se imprime', async ({ page }) => {
  await mockViewer(page, { printStatus: 503 })
  await page.goto(`/documentos?document_id=DOC-PDF&version_id=${VERSION}`)
  await expect(page.getByRole('img', { name: 'Página 1 de 3 del PDF original' })).toBeVisible()
  await page.getByRole('button', { name: 'Imprimir' }).click()
  const dialog = page.getByRole('dialog', { name: 'Imprimir documento' })
  await dialog.getByRole('radio', { name: 'Solo la página actual (página 1)' }).check()
  await dialog.getByRole('button', { name: 'Imprimir' }).click()
  await expect(dialog.getByText('No se pudo registrar la impresión en la auditoría; por seguridad no se imprimió.')).toBeVisible()
  expect(await page.evaluate(() => window.__printed.length)).toBe(0)
  await expect(page.locator('.print-root')).toHaveCount(0)
})

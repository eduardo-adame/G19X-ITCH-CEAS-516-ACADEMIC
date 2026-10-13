import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const pdf = vi.hoisted(() => {
  const renderTask = vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }))
  const getPage = vi.fn(async () => ({ getViewport: () => ({ width: 612, height: 792 }), render: renderTask }))
  const destroy = vi.fn(async () => {})
  const getDocument = vi.fn(() => ({ promise: Promise.resolve({ numPages: 2, getPage, cleanup: vi.fn() }), destroy }))
  return { renderTask, getPage, getDocument, destroy }
})

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ AnnotationMode: { DISABLE: 0 }, GlobalWorkerOptions: {}, getDocument: pdf.getDocument }))
vi.mock('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url', () => ({ default: '/assets/pdf.worker.min.mjs' }))

import { PdfOriginal } from '../src/features/documents/PdfOriginal.jsx'

beforeEach(() => { pdf.getDocument.mockClear(); pdf.getPage.mockClear(); pdf.renderTask.mockClear(); pdf.destroy.mockClear() })
afterEach(() => vi.restoreAllMocks())

describe('SRS_REQUIRED: renderizador local de PDF', () => {
  it('renderiza bytes locales sin anotaciones, formularios, XFA ni evaluación', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({})
    Object.defineProperty(Blob.prototype, 'arrayBuffer', { configurable: true, value: vi.fn(async () => new TextEncoder().encode('%PDF-sintetico').buffer) })
    render(<PdfOriginal blob={new Blob(['%PDF-sintetico'], { type: 'application/pdf' })} />)
    await waitFor(() => expect(pdf.getDocument).toHaveBeenCalled())
    expect(pdf.getDocument).toHaveBeenCalledWith(expect.objectContaining({ data: expect.any(Uint8Array), isEvalSupported: false, enableXfa: false, useWorkerFetch: false }))
    await waitFor(() => expect(pdf.renderTask).toHaveBeenCalled())
    expect(pdf.renderTask).toHaveBeenCalledWith(expect.objectContaining({ annotationMode: 0, renderInteractiveForms: false }))
    expect(screen.getByRole('img', { name: 'Página 1 de 2 del PDF original' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Página siguiente' })).toBeEnabled()
  })
  it('navega entre páginas con el mismo blob autorizado', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({})
    Object.defineProperty(Blob.prototype, 'arrayBuffer', { configurable: true, value: vi.fn(async () => new TextEncoder().encode('%PDF-sintetico').buffer) })
    render(<PdfOriginal blob={new Blob(['%PDF-sintetico'], { type: 'application/pdf' })} />)
    await screen.findByRole('img', { name: 'Página 1 de 2 del PDF original' })
    fireEvent.click(screen.getByRole('button', { name: 'Página siguiente' }))
    await screen.findByRole('img', { name: 'Página 2 de 2 del PDF original' })
    expect(pdf.getDocument).toHaveBeenCalledTimes(2)
  })
  it('desmonta un documento con el contrato API6 sin destroy propio y borra sus píxeles', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({})
    Object.defineProperty(Blob.prototype, 'arrayBuffer', { configurable: true, value: vi.fn(async () => new TextEncoder().encode('%PDF-sintetico').buffer) })
    const view = render(<PdfOriginal blob={new Blob(['%PDF-sintetico'], { type: 'application/pdf' })} />)
    const canvas = await screen.findByRole('img', { name: 'Página 1 de 2 del PDF original' })
    expect(canvas.width).toBeGreaterThan(0)
    expect(() => view.unmount()).not.toThrow()
    expect(pdf.destroy).toHaveBeenCalledTimes(1)
    expect(canvas.width).toBe(0)
    expect(canvas.height).toBe(0)
  })
})

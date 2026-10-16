import React, { useEffect, useRef, useState } from 'react'
import { AnnotationMode, GlobalWorkerOptions, getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import workerSource from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import { Button } from '../../components/controls.jsx'
import { ErrorState, Loading } from '../../components/feedback.jsx'
import { Icon } from '../../components/Icon.jsx'

// La distribución compatible incorpora las APIs JavaScript que faltan en
// navegadores Chromium anteriores. El worker usa esa misma distribución local.
// El visor usa el mismo worker local y la misma versión de PDF.js; nunca carga
// código, fuentes ni contenido desde una URL externa del documento.
GlobalWorkerOptions.workerSrc = workerSource

// PDF.js mide en puntos (72 por pulgada); el 100 % equivale al tamaño real en pantalla (96 px por pulgada).
export const CSS_UNIT = 96 / 72
export const ZOOM_STEPS = Object.freeze([0.5, 0.75, 1, 1.25, 1.5, 2])
const PRINT_SCALE = 2
// Margen mínimo para que el ajuste al ancho no provoque desplazamiento horizontal por redondeo.
const FIT_PADDING = 4

export function nextZoom(current, direction) {
  const steps = direction > 0 ? ZOOM_STEPS.filter((step) => step > current + 0.001) : ZOOM_STEPS.filter((step) => step < current - 0.001)
  return direction > 0 ? steps[0] ?? ZOOM_STEPS.at(-1) : steps.at(-1) ?? ZOOM_STEPS[0]
}

// Página escrita por la persona: solo enteros dentro del documento.
export function parsePage(value, pages) {
  const text = String(value).trim()
  if (!/^\d{1,5}$/.test(text)) return null
  const page = Number(text)
  return page >= 1 && page <= pages ? page : null
}

async function renderInto(pdfPage, canvas, scale) {
  const viewport = pdfPage.getViewport({ scale })
  const ratio = Math.min(window.devicePixelRatio || 1, 2)
  canvas.width = Math.ceil(viewport.width * ratio)
  canvas.height = Math.ceil(viewport.height * ratio)
  canvas.style.width = `${Math.ceil(viewport.width)}px`
  canvas.style.height = `${Math.ceil(viewport.height)}px`
  const task = pdfPage.render({
    canvasContext: canvas.getContext('2d', { alpha: false }),
    viewport,
    transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0],
    annotationMode: AnnotationMode.DISABLE,
    renderInteractiveForms: false,
  })
  return task
}

export function PdfOriginal({ blob, initialPage = 1, onReady, onPage }) {
  const canvasRef = useRef(null)
  const scrollRef = useRef(null)
  const documentRef = useRef(null)
  const [load, setLoad] = useState({ loading: true, error: null, pages: 0 })
  // La página inicial se acota al número real de páginas cuando el documento termina de cargar.
  const [page, setPage] = useState(Math.max(1, Number(initialPage) || 1))
  const [zoom, setZoom] = useState('fit')
  const [width, setWidth] = useState(0)
  const [baseWidth, setBaseWidth] = useState(0)
  const [draft, setDraft] = useState(String(page))
  const [pageError, setPageError] = useState(null)
  const ready = useRef(onReady); ready.current = onReady
  const pageChanged = useRef(onPage); pageChanged.current = onPage

  // El documento se carga una sola vez por archivo; cambiar de página o de zoom solo vuelve a dibujar.
  useEffect(() => {
    let active = true
    let task = null
    setLoad({ loading: true, error: null, pages: 0 })
    ;(async () => {
      try {
        const bytes = new Uint8Array(await blob.arrayBuffer())
        if (!active) return
        task = getDocument({ data: bytes, isEvalSupported: false, enableXfa: false, useWorkerFetch: false })
        const proxy = await task.promise
        if (!active) return
        documentRef.current = proxy
        setPage((current) => Math.min(Math.max(current, 1), proxy.numPages))
        setLoad({ loading: false, error: null, pages: proxy.numPages })
        ready.current?.({ pages: proxy.numPages, renderPage: (number) => renderForPrint(proxy, number) })
      } catch (cause) {
        if (active) setLoad({ loading: false, error: cause, pages: 0 })
      }
    })()
    return () => {
      active = false
      documentRef.current = null
      // La tarea de carga es dueña del documento y del worker. PDF.js 6 no
      // expone destroy en PDFDocumentProxy; destruir por ambas rutas rompía
      // el desmontaje y la navegación al cerrar o suspender el visor.
      task?.destroy().catch(() => {})
    }
  }, [blob])

  // Ancho disponible para «Ajustar al ancho»; se recalcula al cambiar el panel o la pantalla completa.
  useEffect(() => {
    const element = scrollRef.current
    if (!element || typeof ResizeObserver !== 'function') { setWidth(element?.clientWidth || 0); return undefined }
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)))
    observer.observe(element)
    return () => observer.disconnect()
  }, [load.loading])

  const fitScale = baseWidth && width ? Math.max(0.25, (width - FIT_PADDING) / baseWidth) : CSS_UNIT
  const scale = zoom === 'fit' ? fitScale : zoom * CSS_UNIT
  const percent = Math.round((scale / CSS_UNIT) * 100)

  useEffect(() => {
    const proxy = documentRef.current
    const canvas = canvasRef.current
    if (!proxy || !canvas || load.loading) return undefined
    let active = true
    let task = null
    ;(async () => {
      try {
        const pdfPage = await proxy.getPage(page)
        if (!active) return
        const natural = pdfPage.getViewport({ scale: 1 }).width
        if (natural !== baseWidth) setBaseWidth(natural)
        task = await renderInto(pdfPage, canvas, scale)
        await task.promise
      } catch (cause) {
        if (active && cause?.name !== 'RenderingCancelledException') setLoad((current) => ({ ...current, error: cause }))
      }
    })()
    return () => { active = false; task?.cancel() }
  }, [page, scale, load.loading, baseWidth])

  // Al desmontar se borran los píxeles del documento autorizado.
  useEffect(() => { const canvas = canvasRef.current; return () => { if (canvas) { canvas.width = 0; canvas.height = 0 } } }, [])
  useEffect(() => { setDraft(String(page)); setPageError(null); pageChanged.current?.(page) }, [page])

  function go(next) { if (load.pages) setPage(Math.min(Math.max(next, 1), load.pages)) }
  function commitDraft() {
    const value = parsePage(draft, load.pages)
    if (value === null) { setPageError(`Escribe un número de página entre 1 y ${load.pages}.`); return }
    setPageError(null); go(value)
  }
  function changeZoom(direction) { setZoom(nextZoom(scale / CSS_UNIT, direction)) }
  // Atajos solo con el foco en el documento, para no interferir con campos de texto.
  function keyboard(event) {
    if (event.ctrlKey || event.metaKey || event.altKey) return
    const action = { ArrowLeft: () => go(page - 1), ArrowRight: () => go(page + 1), '+': () => changeZoom(1), '=': () => changeZoom(1), '-': () => changeZoom(-1) }[event.key]
    if (action) { event.preventDefault(); action() }
  }

  if (load.error) return <ErrorState error={load.error} />
  const pages = load.pages
  return <div className="viewer-body space-y-3">
    <p className="text-xs text-muted">Archivo original PDF. Se representa localmente sin enlaces, formularios ni acciones del documento.</p>
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <nav className="flex flex-wrap items-center gap-2" aria-label="Navegación del PDF">
        <Button variant="secondary" className="h-8 px-2" aria-label="Página anterior" title="Página anterior (←)" disabled={!pages || page <= 1} onClick={() => go(page - 1)}><Icon name="previous" size={16} /></Button>
        {pages ? <form className="flex items-center gap-1.5 text-xs text-secondary" onSubmit={(event) => { event.preventDefault(); commitDraft() }}>
          <label htmlFor="pdf-page">Página</label>
          <input id="pdf-page" className="control control-compact w-14 text-center tabular-nums" inputMode="numeric" autoComplete="off" value={draft} aria-invalid={Boolean(pageError)} aria-describedby={pageError ? 'pdf-page-error' : undefined} onChange={(event) => setDraft(event.target.value)} onBlur={commitDraft} />
          <span>de {pages}</span>
        </form> : <span className="text-xs text-secondary">Preparando páginas…</span>}
        <Button variant="secondary" className="h-8 px-2" aria-label="Página siguiente" title="Página siguiente (→)" disabled={!pages || page >= pages} onClick={() => go(page + 1)}><Icon name="next" size={16} /></Button>
      </nav>
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Zoom">
        <Button variant="secondary" className="h-8 px-2" aria-label="Alejar" title="Alejar (−)" disabled={!pages || scale / CSS_UNIT <= ZOOM_STEPS[0] + 0.001} onClick={() => changeZoom(-1)}><Icon name="zoomOut" size={16} /></Button>
        <span className="w-12 text-center text-xs tabular-nums text-secondary" aria-live="polite">{pages ? `${percent} %` : ''}</span>
        <Button variant="secondary" className="h-8 px-2" aria-label="Acercar" title="Acercar (+)" disabled={!pages || scale / CSS_UNIT >= ZOOM_STEPS.at(-1) - 0.001} onClick={() => changeZoom(1)}><Icon name="zoomIn" size={16} /></Button>
        <Button variant="ghost" className="h-8" aria-pressed={zoom === 'fit'} disabled={!pages} onClick={() => setZoom('fit')}><Icon name="fit" size={16} />Ajustar al ancho</Button>
      </div>
    </div>
    {pageError && <p id="pdf-page-error" role="alert" className="text-xs text-[var(--critical)]">{pageError}</p>}
    <div ref={scrollRef} tabIndex={0} role="region" aria-label={pages ? `Página ${page} de ${pages} del PDF original. Usa las flechas para cambiar de página y + o − para el zoom.` : 'PDF original autorizado'} onKeyDown={keyboard} className="viewer-scroll max-h-[740px] overflow-auto rounded border border-border bg-secondary p-2">
      {load.loading && <Loading label="Renderizando el PDF autorizado…" />}
      <canvas ref={canvasRef} role="img" aria-label={pages ? `Página ${page} de ${pages} del PDF original` : 'PDF original autorizado'} className={load.loading ? 'hidden' : 'mx-auto block bg-white shadow-sm'} />
    </div>
  </div>
}

// Página dibujada a mayor resolución para papel; devuelve una URL local que se libera tras imprimir.
async function renderForPrint(proxy, number) {
  const pdfPage = await proxy.getPage(number)
  const viewport = pdfPage.getViewport({ scale: PRINT_SCALE })
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height)
  await pdfPage.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport, annotationMode: AnnotationMode.DISABLE, renderInteractiveForms: false }).promise
  const image = await new Promise((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('print')), 'image/jpeg', 0.92))
  canvas.width = 0; canvas.height = 0
  return URL.createObjectURL(image)
}

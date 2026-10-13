import React, { useEffect, useRef, useState } from 'react'
import { AnnotationMode, GlobalWorkerOptions, getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import workerSource from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import { Button } from '../../components/controls.jsx'
import { ErrorState, Loading } from '../../components/feedback.jsx'

// La distribución compatible incorpora las APIs JavaScript que faltan en
// navegadores Chromium anteriores. El worker usa esa misma distribución local.
// El visor usa el mismo worker local y la misma versión de PDF.js; nunca carga
// código, fuentes ni contenido desde una URL externa del documento.
GlobalWorkerOptions.workerSrc = workerSource

export function PdfOriginal({ blob }) {
  const canvasRef = useRef(null)
  const [state, setState] = useState({ loading: true, error: null, page: 1, pages: 0 })
  const page = state.page

  useEffect(() => {
    let active = true
    let task = null
    let renderTask = null
    let documentProxy = null
    const canvas = canvasRef.current

    async function render() {
      try {
        const bytes = new Uint8Array(await blob.arrayBuffer())
        if (!active) return
        task = getDocument({
          data: bytes,
          isEvalSupported: false,
          enableXfa: false,
          useWorkerFetch: false,
        })
        documentProxy = await task.promise
        if (!active) return
        const safePage = Math.min(Math.max(page, 1), documentProxy.numPages)
        const pdfPage = await documentProxy.getPage(safePage)
        if (!active || !canvasRef.current) return
        const viewport = pdfPage.getViewport({ scale: 1.5 })
        const ratio = Math.min(window.devicePixelRatio || 1, 2)
        const context = canvas.getContext('2d', { alpha: false })
        canvas.width = Math.ceil(viewport.width * ratio)
        canvas.height = Math.ceil(viewport.height * ratio)
        canvas.style.width = `${Math.ceil(viewport.width)}px`
        // El ancho puede reducirse por el panel; la altura conserva la relación
        // de aspecto de la página en lugar de estirar el contenido del PDF.
        canvas.style.height = 'auto'
        renderTask = pdfPage.render({
          canvasContext: context,
          viewport,
          transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0],
          annotationMode: AnnotationMode.DISABLE,
          renderInteractiveForms: false,
        })
        await renderTask.promise
        if (active) setState({ loading: false, error: null, page: safePage, pages: documentProxy.numPages })
      } catch (cause) {
        if (active && cause?.name !== 'RenderingCancelledException') setState((previous) => ({ ...previous, loading: false, error: cause }))
      }
    }
    setState((previous) => ({ ...previous, loading: true, error: null }))
    render()
    return () => {
      active = false
      renderTask?.cancel()
      // La tarea de carga es dueña del documento y del worker. PDF.js 6 no
      // expone destroy en PDFDocumentProxy; destruir por ambas rutas rompía
      // el desmontaje y la navegación al cerrar o suspender el visor.
      task?.destroy().catch(() => {})
      if (canvas) { canvas.width = 0; canvas.height = 0 }
    }
  }, [blob, page])

  if (state.error) return <ErrorState error={state.error} />
  return <div className="space-y-3">
    <p className="text-xs text-muted">Archivo original PDF. Se representa localmente sin enlaces, formularios ni acciones del documento.</p>
    <div className="flex items-center gap-3" aria-label="Navegación del PDF">
      <Button variant="secondary" disabled={state.loading || page <= 1} onClick={() => setState((current) => ({ ...current, page: current.page - 1 }))}>Página anterior</Button>
      <span className="text-xs text-secondary">{state.pages ? `Página ${page} de ${state.pages}` : 'Preparando páginas…'}</span>
      <Button variant="secondary" disabled={state.loading || !state.pages || page >= state.pages} onClick={() => setState((current) => ({ ...current, page: current.page + 1 }))}>Página siguiente</Button>
    </div>
    <div className="max-h-[740px] overflow-auto rounded border border-border bg-muted p-2">
      {state.loading && <Loading label="Renderizando el PDF autorizado…" />}
      <canvas ref={canvasRef} role="img" aria-label={state.pages ? `Página ${page} de ${state.pages} del PDF original` : 'PDF original autorizado'} className={state.loading ? 'hidden' : 'mx-auto block max-w-full bg-white shadow-sm'} />
    </div>
  </div>
}

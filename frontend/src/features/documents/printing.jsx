import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSession } from '../../auth/SessionProvider.jsx'
import { Button } from '../../components/controls.jsx'
import { ErrorState } from '../../components/feedback.jsx'
import { Icon } from '../../components/Icon.jsx'
import { Modal } from '../../components/layout.jsx'
import { formatUserTimestamp } from '../../shared/presentation.js'
import { registerPrint } from './api.js'

// Pie de identificación de cada hoja impresa (RF-077, SRS 0.25). No incluye contenido del documento.
export function printFooter({ principal, item, printedAt, page = null, pages = null }) {
  const parts = [`Impreso por ${principal.displayName} (${principal.username})`, formatUserTimestamp(printedAt.toISOString()), `${item.name}, versión ${item.versionNumber}`]
  if (page !== null) parts.push(`Página ${page} de ${pages}`)
  return parts.join(' · ')
}

// Hojas que solo existen durante la impresión: ocultas en pantalla y únicas visibles al imprimir.
function PrintSheets({ job, onDone }) {
  const root = useRef(null)
  const done = useRef(onDone); done.current = onDone
  useEffect(() => {
    let active = true
    const finish = () => { if (active) { active = false; done.current() } }
    const images = [...root.current.querySelectorAll('img')]
    Promise.all(images.map((image) => (typeof image.decode === 'function' ? image.decode() : Promise.resolve()).catch(() => {}))).then(() => {
      if (!active) return
      window.addEventListener('afterprint', finish, { once: true })
      window.print()
    })
    return () => { active = false; window.removeEventListener('afterprint', finish) }
  }, [])
  return createPortal(<div ref={root} className="print-root" aria-hidden="true">
    {job.kind === 'pdf'
      ? job.pages.map((sheet) => <figure key={sheet.page} className="print-page"><img src={sheet.url} alt="" /><figcaption className="print-caption">{sheet.footer}</figcaption></figure>)
      : <><p className="print-title">{job.title}</p><div className="print-text">{job.text}</div><p className="print-footer">{job.footer}</p></>}
  </div>, document.body)
}

// Diálogo de impresión: prepara las hojas, registra la impresión en auditoría y solo entonces abre el
// diálogo del navegador. Si el registro no se confirma, no se imprime.
export function PrintControl({ item, mode, pages = 0, currentPage = 1, renderPage, text }) {
  const session = useSession()
  const [open, setOpen] = useState(false)
  const [scope, setScope] = useState('all')
  const [phase, setPhase] = useState('choose')
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [error, setError] = useState(null)
  const [failedAt, setFailedAt] = useState(null)
  const [job, setJob] = useState(null)
  const cancelRef = useRef(null)
  const run = useRef(null)
  const pdf = mode === 'pdf'
  const unavailable = pdf ? !pages || !renderPage : typeof text !== 'string'

  function release(sheets) { sheets?.forEach((sheet) => URL.revokeObjectURL(sheet.url)) }
  function close() { run.current?.abort(); setOpen(false); setPhase('choose'); setError(null) }
  useEffect(() => () => run.current?.abort(), [])

  async function confirm() {
    const controller = new AbortController(); run.current = controller
    const printedAt = new Date()
    const principal = session.principal
    let sheets = []
    let stage = 'preparing'
    setError(null)
    try {
      if (pdf) {
        const selected = scope === 'current' ? [currentPage] : Array.from({ length: pages }, (_, index) => index + 1)
        setPhase('preparing'); setProgress({ done: 0, total: selected.length })
        for (const page of selected) {
          const url = await renderPage(page)
          if (controller.signal.aborted) { URL.revokeObjectURL(url); release(sheets); return }
          sheets.push({ page, url, footer: printFooter({ principal, item, printedAt, page, pages }) })
          setProgress({ done: sheets.length, total: selected.length })
        }
      }
      setPhase('registering'); stage = 'registering'
      await registerPrint(session.client, item.documentId, item.versionId, controller.signal)
      if (controller.signal.aborted) { release(sheets); return }
      setJob(pdf ? { kind: 'pdf', pages: sheets } : { kind: 'text', title: item.name, text, footer: printFooter({ principal, item, printedAt }) })
      setOpen(false); setPhase('choose')
    } catch (cause) {
      release(sheets)
      if (controller.signal.aborted) return
      setError(cause); setFailedAt(stage); setPhase('error')
    }
  }
  const busy = phase === 'preparing' || phase === 'registering'
  return <>
    <Button variant="secondary" disabled={unavailable || Boolean(job)} onClick={() => { setScope('all'); setOpen(true) }}><Icon name="print" size={16} />Imprimir</Button>
    <Modal open={open} title="Imprimir documento" initialFocus={cancelRef} onClose={close}><div className="space-y-4 text-[13px]">
      {pdf && <fieldset className="space-y-2" disabled={busy}><legend className="mb-1 text-xs font-medium text-secondary">Qué imprimir</legend>
        <label className="flex items-center gap-2"><input type="radio" name="print-scope" value="all" checked={scope === 'all'} onChange={() => setScope('all')} />Todo el documento ({pages} {pages === 1 ? 'página' : 'páginas'})</label>
        <label className="flex items-center gap-2"><input type="radio" name="print-scope" value="current" checked={scope === 'current'} onChange={() => setScope('current')} />Solo la página actual (página {currentPage})</label>
      </fieldset>}
      {!pdf && <p>Se imprimirá el texto completo procesado; no reproduce la maquetación original.</p>}
      <p className="text-xs text-secondary">La impresión quedará registrada en la auditoría con tu usuario, el documento y la fecha. Cada hoja llevará un pie con esos datos.</p>
      {phase === 'preparing' && <p role="status" className="text-xs text-secondary">Preparando página {Math.min(progress.done + 1, progress.total)} de {progress.total}…</p>}
      {phase === 'registering' && <p role="status" className="text-xs text-secondary">Registrando la impresión…</p>}
      {phase === 'error' && <div className="space-y-2"><p className="text-xs">{failedAt === 'registering' ? 'No se pudo registrar la impresión en la auditoría; por seguridad no se imprimió.' : 'No se pudieron preparar las páginas para imprimir.'}</p><ErrorState error={error} title="No se imprimió el documento" /></div>}
      <div className="flex flex-wrap justify-end gap-3"><Button ref={cancelRef} variant="secondary" onClick={close}>Cancelar</Button><Button busy={busy} onClick={confirm}><Icon name="print" size={16} />Imprimir</Button></div>
    </div></Modal>
    {job && <PrintSheets job={job} onDone={() => { release(job.pages); setJob(null) }} />}
  </>
}

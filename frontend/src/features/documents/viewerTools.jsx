import React, { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Button } from '../../components/controls.jsx'
import { Icon } from '../../components/Icon.jsx'
import { findMatches, foldedIndex, MAX_MATCHES, MIN_SEARCH_LENGTH, segments } from './textSearch.js'

// Ayuda del visor, desplegable y accesible por teclado.
export function ViewerHelp() {
  const [open, setOpen] = useState(false)
  const id = useId()
  return <>
    <Button variant="ghost" className="h-8 px-2" aria-expanded={open} aria-controls={id} aria-label="Ayuda del visor" title="Ayuda del visor" onClick={() => setOpen((value) => !value)}><Icon name="help" size={16} /></Button>
    {open && <div id={id} className="basis-full space-y-2 rounded-control bg-secondary px-4 py-3 text-xs text-secondary">
      <p><span className="font-medium text-primary">Archivo original PDF:</span> muestra el archivo tal como se recibió, como imagen y sin enlaces, formularios ni acciones del documento. Cambia de página con ← y → y ajusta el zoom con + y − cuando el documento tiene el foco.</p>
      <p><span className="font-medium text-primary">Texto completo procesado:</span> el texto extraído durante el procesamiento; no reproduce la maquetación original. Aquí puedes buscar palabras.</p>
      <p><span className="font-medium text-primary">Registro:</span> cada apertura y cada impresión quedan registradas en la auditoría con tu usuario, el documento y la fecha. Las hojas impresas llevan un pie con esos datos.</p>
    </div>}
  </>
}

// Pantalla completa del área de lectura; si el navegador no la permite, el control no se muestra.
export function useFullscreen(ref) {
  const [active, setActive] = useState(false)
  const supported = typeof document !== 'undefined' && document.fullscreenEnabled === true
  useEffect(() => {
    const change = () => setActive(Boolean(ref.current) && document.fullscreenElement === ref.current)
    document.addEventListener('fullscreenchange', change)
    return () => document.removeEventListener('fullscreenchange', change)
  }, [ref])
  function toggle() {
    if (active) document.exitFullscreen?.().catch(() => {})
    else ref.current?.requestFullscreen?.().catch(() => {})
  }
  return { supported, active, toggle }
}

export function FullscreenButton({ fullscreen }) {
  if (!fullscreen.supported) return null
  const label = fullscreen.active ? 'Salir de pantalla completa' : 'Pantalla completa'
  return <Button variant="ghost" className="h-8 px-2" aria-label={label} title={label} onClick={fullscreen.toggle}><Icon name={fullscreen.active ? 'contract' : 'expand'} size={16} /></Button>
}

// Texto completo procesado con búsqueda local: resalta coincidencias y recorre con Enter / Mayús + Enter.
export function SearchableText({ text }) {
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const [current, setCurrent] = useState(0)
  const scroll = useRef(null)
  const index = useMemo(() => foldedIndex(text), [text])
  const matches = useMemo(() => findMatches(text, query, index), [text, query, index])
  useEffect(() => { const timer = setTimeout(() => setQuery(draft), 250); return () => clearTimeout(timer) }, [draft])
  useEffect(() => { setCurrent(0) }, [query])
  // Desplaza solo el área del texto (no la página) hasta la coincidencia activa.
  useEffect(() => {
    const container = scroll.current
    const mark = container?.querySelector('mark[data-current="true"]')
    if (container && mark) container.scrollTop = Math.max(0, mark.offsetTop - container.clientHeight / 2)
  }, [current, matches])
  function move(step) { if (matches.length) setCurrent((value) => (value + step + matches.length) % matches.length) }
  const searching = Array.from(query.trim()).length >= MIN_SEARCH_LENGTH
  const status = !searching ? '' : matches.length ? `${current + 1} de ${matches.length}${matches.length >= MAX_MATCHES ? '+' : ''}` : 'Sin coincidencias'
  return <div className="viewer-body space-y-3">
    <p className="text-xs text-muted">Texto completo procesado; no reproduce la maquetación original.</p>
    <div className="flex flex-wrap items-end gap-2" role="search" aria-label="Buscar en el texto">
      <div className="field space-y-1"><label htmlFor="viewer-search" className="block text-xs font-medium text-secondary">Buscar en el texto</label><input id="viewer-search" type="search" className="control control-compact w-64 max-w-full" value={draft} maxLength={200} autoComplete="off" aria-describedby="viewer-search-status"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); if (draft !== query) setQuery(draft); else move(event.shiftKey ? -1 : 1) } }} /></div>
      <Button variant="secondary" className="h-8 px-2" aria-label="Coincidencia anterior" disabled={matches.length < 2} onClick={() => move(-1)}><Icon name="up" size={16} /></Button>
      <Button variant="secondary" className="h-8 px-2" aria-label="Coincidencia siguiente" disabled={matches.length < 2} onClick={() => move(1)}><Icon name="down" size={16} /></Button>
      <span id="viewer-search-status" role="status" aria-live="polite" className="pb-2 text-xs tabular-nums text-secondary">{status}</span>
    </div>
    <div ref={scroll} tabIndex={0} role="region" aria-label="Texto completo procesado" className="viewer-scroll relative max-h-[740px] overflow-y-auto whitespace-pre-wrap break-words font-serif text-sm leading-relaxed">
      {matches.length ? segments(text, matches).map((part, key) => part.match === undefined ? <React.Fragment key={key}>{part.text}</React.Fragment> : <mark key={key} data-current={part.match === current} className={part.match === current ? 'search-hit search-hit-current' : 'search-hit'}>{part.text}</mark>) : text}
    </div>
  </div>
}

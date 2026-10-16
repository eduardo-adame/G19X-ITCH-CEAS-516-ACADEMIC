import React, { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Button } from './controls.jsx'
import { Icon } from './Icon.jsx'

const NARROW = '(max-width: 767px)'
// Ancho de móvil: los filtros se pliegan tras el botón «Filtros». Sin matchMedia (pruebas) se asume escritorio.
export function useIsNarrow() {
  const query = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(NARROW).matches
  const [narrow, setNarrow] = useState(query)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined
    const media = window.matchMedia(NARROW)
    const change = () => setNarrow(media.matches)
    media.addEventListener?.('change', change)
    return () => media.removeEventListener?.('change', change)
  }, [])
  return narrow
}

// Agrupa cambios rápidos (flechas del teclado sobre un selector, escritura) en una sola aplicación.
export function useDebouncedCallback(callback, delay) {
  const latest = useRef(callback); latest.current = callback
  const timer = useRef(null)
  useEffect(() => () => clearTimeout(timer.current), [])
  return useCallback((...args) => { clearTimeout(timer.current); timer.current = setTimeout(() => latest.current(...args), delay) }, [delay])
}

// Barra de filtros (DESIGN §19). Escritorio: controles en línea con etiqueta visible a la izquierda, filtros
// secundarios tras «Más filtros». Móvil: botón «Filtros (n)» que despliega un panel con todos los controles.
// En ambos casos los cambios se aplican solos y los filtros activos se muestran como chips con «Limpiar todo».
export function FilterToolbar({ label = 'Filtros', primary, secondary = null, secondaryActive = 0, chips = [], onClearAll }) {
  const narrow = useIsNarrow()
  const [moreOpen, setMoreOpen] = useState(secondaryActive > 0)
  const [panelOpen, setPanelOpen] = useState(false)
  const panelId = useId(); const moreId = useId()
  const toggle = useRef(null)
  const chipRow = chips.length > 0 && <div role="group" aria-label="Filtros activos" className="flex flex-wrap items-center gap-2">
    {chips.map((chip) => <button key={chip.id} type="button" className="filter-chip" aria-label={`Quitar filtro ${chip.label}`} onClick={chip.onRemove}><span>{chip.label}</span><Icon name="close" size={12} /></button>)}
    {onClearAll && <Button variant="ghost" className="h-7 px-2 text-xs" onClick={onClearAll}>Limpiar todo</Button>}
  </div>
  if (narrow) {
    return <section aria-label={label} className="space-y-3">
      <Button ref={toggle} variant="secondary" aria-expanded={panelOpen} aria-controls={panelId} onClick={() => setPanelOpen((open) => !open)}><Icon name="filter" />Filtros{chips.length ? ` (${chips.length})` : ''}</Button>
      {panelOpen && <div id={panelId} className="filter-stack rounded-panel border border-border bg-surface p-4">
        {primary}{secondary}
        <Button onClick={() => { setPanelOpen(false); toggle.current?.focus() }}>Ver resultados</Button>
      </div>}
      {chipRow}
    </section>
  }
  return <section aria-label={label} className="space-y-2">
    <div className="filter-row">
      {primary}
      {secondary && <Button variant="ghost" className="h-8 px-2 text-xs" aria-expanded={moreOpen} aria-controls={moreId} onClick={() => setMoreOpen((open) => !open)}><Icon name={moreOpen ? 'up' : 'down'} size={12} />Más filtros{secondaryActive ? ` (${secondaryActive})` : ''}</Button>}
    </div>
    {secondary && moreOpen && <div id={moreId} className="filter-row rounded-control border border-border bg-surface px-3 py-2">{secondary}</div>}
    {chipRow}
  </section>
}

// Resultado anunciado tras filtrar (lectores de pantalla) sin mover el foco.
export function ResultsSummary({ count, hasMore = false, noun = ['elemento', 'elementos'] }) {
  if (!Number.isInteger(count)) return null
  const text = count === 0 ? 'Sin resultados para estos filtros' : `${count.toLocaleString('es-MX')} ${count === 1 ? noun[0] : noun[1]}${hasMore ? ' · hay más páginas' : ''}`
  return <p role="status" aria-live="polite" className="text-xs text-secondary">{text}</p>
}

// Paginación por cursor con «Página anterior»: guarda los cursores visitados; cambiar un filtro reinicia la pila.
export function useCursorHistory(resetKey) {
  const [stack, setStack] = useState([])
  const [key, setKey] = useState(resetKey)
  if (key !== resetKey) { setKey(resetKey); setStack([]) }
  return {
    canGoBack: stack.length > 0,
    push: (cursor) => setStack((items) => [...items, cursor ?? '']),
    pop: () => { const previous = stack.at(-1); setStack((items) => items.slice(0, -1)); return previous },
  }
}
export function CursorPager({ hasNext, hasPrevious, onNext, onPrevious, onFirst, atDeepLink = false, children }) {
  if (!hasNext && !hasPrevious && !atDeepLink && !children) return null
  return <nav aria-label="Paginación" className="flex flex-wrap items-center justify-between gap-3">
    <div className="flex flex-wrap gap-3">
      {hasPrevious ? <Button variant="secondary" onClick={onPrevious}>Página anterior</Button> : atDeepLink ? <Button variant="secondary" onClick={onFirst}>Primera página</Button> : null}
      {hasNext && <Button variant="secondary" onClick={onNext}>Página siguiente</Button>}
    </div>
    {children}
  </nav>
}

// Botón de refresco único (mismo nombre en todas las vistas), fuera de la barra de filtros.
export function RefreshButton({ onClick, busy = false, label = 'Actualizar' }) {
  return <Button variant="secondary" className="h-8 px-3 text-xs" busy={busy} onClick={onClick}><Icon name="refresh" size={13} />{label}</Button>
}

// Rango de fechas con validación en el propio campo: «Hasta» no puede ser anterior a «Desde» (atributos
// min/max para el calendario y mensaje enlazado). Solo notifica rangos válidos; cada extremo es opcional.
export function DateRangeFields({ fromLabel = 'Desde', toLabel = 'Hasta', from = '', to = '', onChange }) {
  const [draft, setDraft] = useState({ from, to })
  useEffect(() => { setDraft({ from, to }) }, [from, to])
  const inverted = Boolean(draft.from && draft.to && draft.from > draft.to)
  function update(patch) {
    const next = { ...draft, ...patch }
    setDraft(next)
    if (!(next.from && next.to && next.from > next.to)) onChange(next)
  }
  return <>
    <InputField label={fromLabel} sharedPrefix={sharedPrefix(fromLabel, toLabel)} leading value={draft.from} max={draft.to || undefined} onChange={(value) => update({ from: value })} />
    <InputField label={toLabel} sharedPrefix={sharedPrefix(fromLabel, toLabel)} value={draft.to} min={draft.from || undefined} error={inverted ? `Debe ser igual o posterior a «${fromLabel}».` : null} onChange={(value) => update({ to: value })} />
  </>
}
// Palabras iniciales comunes a ambas etiquetas («Retenido desde» / «Retenido hasta» → «Retenido»).
function sharedPrefix(from, to) {
  const a = from.split(' '); const b = to.split(' '); const common = []
  for (let i = 0; i < Math.min(a.length, b.length) - 1 && a[i] === b[i]; i++) common.push(a[i])
  return common.join(' ')
}
function InputField({ label, sharedPrefix: prefix = '', leading = false, value, onChange, ...props }) {
  const id = useId()
  const error = props.error
  // En línea se lee «Retenido [fecha] hasta [fecha]»: la primera etiqueta oculta su final y la segunda su prefijo.
  const visible = !prefix ? label : leading ? <>{prefix}<span className="inline-prefix"> {label.slice(prefix.length + 1)}</span></> : <><span className="inline-prefix">{prefix} </span>{label.slice(prefix.length + 1)}</>
  return <div className="field space-y-1"><label htmlFor={id} className="block text-xs font-medium text-secondary">{visible}</label><input id={id} type="date" className="control control-compact" value={value} min={props.min} max={props.max} aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined} onChange={(event) => onChange(event.target.value)} />{error && <p id={`${id}-error`} role="alert" className="field-error text-xs text-[var(--critical)]">{error}</p>}</div>
}

// Campo de texto que se aplica con Enter o tras una pausa al escribir; un valor inválido se señala en el campo
// y no se consulta. Vaciarlo retira el filtro.
export function SearchField({ label, value = '', validate = () => true, invalidMessage, onApply, maxLength, delay = 400 }) {
  const id = useId()
  const [draft, setDraft] = useState(value)
  const [showError, setShowError] = useState(false)
  useEffect(() => { setDraft(value); setShowError(false) }, [value])
  // El error se muestra al pulsar Enter o tras la pausa, no en cada tecla.
  const commit = (text) => { const clean = text.trim(); if (clean && !validate(clean)) { setShowError(true); return } setShowError(false); if (clean !== value) onApply(clean) }
  const schedule = useDebouncedCallback(commit, delay)
  const error = showError ? invalidMessage : null
  return <div className="field space-y-1"><label htmlFor={id} className="block text-xs font-medium text-secondary">{label}</label><input id={id} type="search" className="control control-compact" value={draft} maxLength={maxLength} aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined}
    onChange={(event) => { setDraft(event.target.value); setShowError(false); schedule(event.target.value) }}
    onKeyDown={(event) => { if (event.key !== 'Enter') return; event.preventDefault(); commit(draft) }} />{error && <p id={`${id}-error`} role="alert" className="field-error text-xs text-[var(--critical)]">{error}</p>}</div>
}

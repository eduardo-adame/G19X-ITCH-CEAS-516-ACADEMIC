import React, { useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge, TechnicalDetails } from '../../components/data.jsx'
import { Icon } from '../../components/Icon.jsx'
import { formatDocumentDate as formatDate } from '../../shared/presentation.js'
import { citationLocation, RAG_STATES } from './adapters.js'

export function RagStateBanner({ state }) {
  const variant = { EVIDENCIA_SUFICIENTE: 'success', EVIDENCIA_INSUFICIENTE: 'warning', SIN_AUTORIZACION: 'critical' }[state]
  const icon = { EVIDENCIA_SUFICIENTE: 'success', EVIDENCIA_INSUFICIENTE: 'warning', SIN_EVIDENCIA: 'help', SIN_AUTORIZACION: 'locked' }[state]
  if (!Object.hasOwn(RAG_STATES, state)) return null
  return <div role="status" aria-live="polite" className="flex items-center gap-2"><Icon name={icon} size={16} /><Badge variant={variant}>{RAG_STATES[state]}</Badge></div>
}
export function ScopeRestrictionNotice({ message }) {
  return <div role="status" aria-live="polite" className="space-y-2 rounded-panel border border-border bg-secondary p-4">
    <div className="flex items-center gap-2"><Icon name="warning" size={16} /><Badge variant="warning">Fuera del alcance del asistente</Badge></div>
    <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed">{message}</p>
    <p className="text-xs text-secondary">El asistente no toma decisiones jurídicas; puede mostrarte la evidencia documental relacionada con tu pregunta.</p>
  </div>
}

// Metadatos de cita (RF-061). Documento, tipo, fecha y procedencia son la lectura principal; los
// identificadores de documento y fragmento se conservan en «Detalle de la cita» (DESIGN §16.6).
export function citationSummary(citation) {
  return [citation.documentType, citation.documentDate === null ? 'Sin fecha declarada' : formatDate(citation.documentDate), citationLocation(citation)].filter(Boolean).join(' · ')
}
export function Citation({ citation }) {
  const location = citationLocation(citation)
  return <dl className="space-y-2 break-words text-[13px] text-secondary">
    <div><dt className="text-xs font-medium">Documento</dt><dd>{citation.documentName}</dd></div>
    <div><dt className="text-xs font-medium">Tipo</dt><dd>{citation.documentType}</dd></div>
    <div><dt className="text-xs font-medium">Fecha del documento</dt><dd>{citation.documentDate === null ? 'No disponible' : formatDate(citation.documentDate)}</dd></div>
    {location && <div><dt className="text-xs font-medium">Procedencia</dt><dd>{location}</dd></div>}
    <div><TechnicalDetails summary="Detalle de la cita"><dl><dt>Identificador del documento</dt><dd className="mono">{citation.documentId}</dd><dt>Identificador del fragmento</dt><dd className="mono">{citation.fragmentId}</dd></dl></TechnicalDetails></div>
  </dl>
}

export const sourceAnchor = (fragmentId) => `fuente-${fragmentId}`
// Documento completo en el visor independiente; en PDF se abre en la página inicial del fragmento.
export function fullDocumentPath(fragment) {
  const query = new URLSearchParams({ document_id: fragment.documentId })
  if (Number.isInteger(fragment.pageStart) && fragment.pageStart > 0) query.set('page', String(fragment.pageStart))
  return `/documentos?${query}`
}

// Fuente compacta: la marca [En] de la respuesta enlaza con esta tarjeta.
export function EvidenceCard({ fragment, handle }) {
  const [expanded, setExpanded] = useState(false)
  const long = fragment.text.length > 420
  const usage = fragment.usage === 'EVIDENCE' ? ['Evidencia', 'success'] : ['Referencia', 'neutral']
  return <article id={sourceAnchor(fragment.fragmentId)} tabIndex={-1} aria-label={`${handle ? `Fuente ${handle}: ` : ''}${fragment.documentName}`} className="min-w-0 space-y-3 rounded-panel border border-border bg-surface p-5 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--text-primary)]">
    <header className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><h3 className="break-words text-sm font-semibold">{handle && <span className="mr-1.5 font-mono text-xs text-secondary">[{handle}]</span>}{fragment.documentName}</h3><p className="mt-1 text-xs text-muted">{citationSummary(fragment)}</p></div><Badge variant={usage[1]}>{usage[0]}</Badge></header>
    <blockquote className={`whitespace-pre-wrap break-words border-l-2 border-[var(--text-muted)] bg-secondary p-3 text-[13px] italic ${long && !expanded ? 'line-clamp-4' : ''}`}>{fragment.text}</blockquote>
    <div className="flex flex-wrap items-center gap-4 text-xs">
      {long && <button type="button" className="font-medium underline" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? 'Ver menos' : 'Ver más'}</button>}
      <Link className="font-medium underline" to={`/documentos?fragment_id=${encodeURIComponent(fragment.fragmentId)}`}>Abrir en el visor</Link>
      <Link className="font-medium underline" to={fullDocumentPath(fragment)}>Abrir documento completo</Link>
    </div>
    <TechnicalDetails summary="Detalle de la cita"><dl><dt>Identificador del documento</dt><dd className="mono">{fragment.documentId}</dd><dt>Identificador del fragmento</dt><dd className="mono">{fragment.fragmentId}</dd></dl></TechnicalDetails>
  </article>
}

// Texto de respuesta con marcas [E1]…[E5] enlazadas a su fuente; solo se enlazan marcas citadas.
export function AnswerText({ text, citations }) {
  const byHandle = new Map(citations.map((citation) => [citation.handle, citation]))
  const parts = text.split(/(\[E[1-5]\])/g)
  // El foco desplaza la vista hasta la fuente y la anuncia a lectores de pantalla.
  const focus = (fragmentId) => document.getElementById(sourceAnchor(fragmentId))?.focus()
  return <p className="whitespace-pre-wrap break-words text-[14px] leading-relaxed">{parts.map((part, index) => {
    const handle = /^\[(E[1-5])\]$/.exec(part)?.[1]
    const citation = handle && byHandle.get(handle)
    if (!citation) return <React.Fragment key={index}>{part}</React.Fragment>
    return <button key={index} type="button" className="mx-0.5 inline-flex items-center rounded-control border border-border bg-secondary px-1 font-mono text-xs font-medium align-baseline hover:bg-[var(--background-selected)]" aria-label={`Ir a la fuente ${handle}: ${citation.documentName}`} onClick={() => focus(citation.fragmentId)}>{part}</button>
  })}</p>
}

export function DocumentViewer({ fragment }) {
  return <div className="grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-12">
    <section className="min-w-0 rounded-panel border border-border bg-surface p-5 lg:col-span-7" aria-label="Texto original del fragmento">
      <h2 className="mb-1 break-words text-base font-semibold">{fragment.documentName}</h2>
      <p className="mb-4 text-xs text-muted">{citationSummary(fragment)}</p>
      <div tabIndex={0} role="region" aria-label="Fragmento documental" className="max-h-[740px] overflow-y-auto whitespace-pre-wrap break-words border-l-2 border-[var(--warning)] bg-[var(--warning-subtle)] p-4 font-serif text-sm leading-relaxed">{fragment.text}</div>
      <Link className="mt-4 inline-block text-xs font-medium underline" to={fullDocumentPath(fragment)}>Abrir documento completo</Link>
    </section>
    <aside className="min-w-0 rounded-panel border border-border bg-surface p-5 lg:col-span-5"><h2 className="mb-4 text-base font-semibold">Metadatos de la cita</h2><Citation citation={fragment} /></aside>
  </div>
}

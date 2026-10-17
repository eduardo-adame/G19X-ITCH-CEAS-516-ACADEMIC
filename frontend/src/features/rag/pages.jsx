import React, { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import { useSession } from '../../auth/SessionProvider.jsx'
import { Button } from '../../components/controls.jsx'
import { PageHeader } from '../../components/layout.jsx'
import { EmptyState, ErrorState, Loading } from '../../components/feedback.jsx'
import { Icon } from '../../components/Icon.jsx'
import { readQuery, writeQuery } from '../../shared/query.js'
import { safeError, ApiError } from '../../api/errors.js'
import { isUuid } from './adapters.js'
import { AnswerText, DocumentViewer, EvidenceCard, RagStateBanner, ScopeRestrictionNotice } from './components.jsx'
import { useRag } from './state.jsx'
import { suggestedQuestions } from './localInteraction.js'
import { DocumentCatalog } from '../documents/DocumentCatalog.jsx'

const resultExplanations = Object.freeze({
  EVIDENCIA_INSUFICIENTE: 'Encontré información relacionada, pero la evidencia disponible no es suficiente para responder esta consulta con certeza. Puedes intentar especificar el documento, una fecha, una cláusula o el asunto que buscas.',
  SIN_EVIDENCIA: 'No encontré evidencia en los documentos a los que tienes acceso que permita responder esta pregunta. Puedes intentar indicar el nombre del documento, una fecha, una cláusula o el asunto que buscas.',
  SIN_AUTORIZACION: 'No puedo proporcionar información para esta consulta con tu nivel de acceso actual.',
})
const QUERY_LIMIT = 4096
const COUNTER_FROM = 3500
const SLOW_AFTER_SECONDS = 20

// Segundos transcurridos mientras la consulta está en curso; no se anuncian a lectores de pantalla.
function useElapsed(active) {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    if (!active) { setSeconds(0); return undefined }
    const started = Date.now()
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [active])
  return seconds
}

// Carga honesta (DESIGN §16.6): actividad y tiempo, sin afirmar etapas que el backend no informa.
function QueryProgress({ seconds, onStop }) {
  return <section aria-label="Consulta en curso" className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p role="status" aria-live="polite" className="inline-flex items-center gap-2 text-[13px] text-secondary"><span aria-hidden="true" className="rag-activity" />Buscando en tus documentos autorizados…</p>
      <div className="flex items-center gap-3">{seconds >= 3 && <span className="font-mono text-xs text-muted" aria-hidden="true">{seconds} s</span>}<Button variant="secondary" onClick={onStop}>Dejar de esperar</Button></div>
    </div>
    {seconds >= SLOW_AFTER_SECONDS && <p role="status" className="text-xs text-secondary">La consulta está tardando más de lo habitual. Puedes seguir esperando o dejar de esperar.</p>}
    <div aria-hidden="true" className="space-y-3 rounded-panel border border-border bg-surface p-5"><div className="skeleton h-3 w-11/12" /><div className="skeleton h-3 w-10/12" /><div className="skeleton h-3 w-7/12" /></div>
    <div aria-hidden="true" className="grid grid-cols-1 gap-4 md:grid-cols-2">{[0, 1].map((index) => <div key={index} className="space-y-3 rounded-panel border border-border bg-surface p-5"><div className="skeleton h-3 w-1/2" /><div className="skeleton h-2.5 w-1/3" /><div className="skeleton h-12 w-full" /></div>)}</div>
  </section>
}

// Reintento junto al error: una falla técnica persistida crea una operación nueva; un resultado
// incierto reutiliza la misma operación (F-14). La espera de Retry-After se muestra como cuenta regresiva.
function RetryAction({ rag }) {
  const [now, setNow] = useState(() => Date.now())
  const remaining = Math.max(0, Math.ceil(((rag.retryNotBefore || 0) - now) / 1000))
  useEffect(() => {
    if (!remaining) return undefined
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [remaining])
  return <div className="flex flex-wrap items-center gap-3">{remaining > 0 && <p className="text-xs text-secondary">El servicio está ocupado. Podrás intentarlo de nuevo en {remaining} s.</p>}<Button variant="secondary" onClick={rag.retry} disabled={remaining > 0}>Intentar de nuevo</Button></div>
}

function TechnicalFailure({ result, rag }) {
  return <section role="alert" className="space-y-3 rounded-panel border border-[var(--critical-border)] bg-[var(--critical-subtle)] p-5">
    <h3 className="text-sm font-semibold">No se pudo completar la consulta</h3>
    <p className="text-[13px] text-secondary">{new ApiError(503).message}</p>
    {result.message && <p className="text-[13px] text-secondary">{result.message}</p>}
    <RetryAction rag={rag} />
  </section>
}

function RequestError({ error, rag }) {
  const safe = safeError(error)
  const retryable = rag.submission && (safe.recoverable || safe.uncertain)
  return <section role="alert" className="space-y-3 rounded-panel border border-[var(--critical-border)] bg-[var(--critical-subtle)] p-5">
    <h3 className="text-sm font-semibold">{safe.status === 403 ? 'Sin autorización' : 'No se pudo completar la consulta'}</h3>
    <p className="text-[13px] text-secondary">{safe.message}</p>
    {retryable && <RetryAction rag={rag} />}
  </section>
}

export function RagQueryPage() {
  const rag = useRag()
  const session = useSession()
  const location = useLocation()
  const [params, setParams] = useSearchParams()
  const [query, setQuery] = useState('')
  const [validationError, setValidationError] = useState(null)
  const [abandoned, setAbandoned] = useState(false)
  const textarea = useRef(null)
  // Fuente señalada desde su marca [En] en la respuesta (se resalta su tarjeta).
  const [highlighted, setHighlighted] = useState(null)
  const context = readQuery(params.toString(), { context_reference_id: isUuid }).context_reference_id ?? null
  // Nombre del hallazgo de origen, recibido solo en memoria de navegación (nunca en la URL).
  const contextLabel = context && typeof location.state?.contextLabel === 'string' ? location.state.contextLabel.slice(0, 200) : null
  const canonicalQuery = writeQuery(context ? { context_reference_id: context } : {}, { context_reference_id: isUuid })
  const seconds = useElapsed(rag.busy)
  useEffect(() => {
    if (canonicalQuery !== params.toString()) setParams(canonicalQuery, { replace: true, state: location.state })
  }, [canonicalQuery, params, setParams, location.state])
  useEffect(() => { setQuery(''); setValidationError(null); setAbandoned(false) }, [session.principal?.id, session.generation])
  async function send() {
    if (rag.busy || rag.accessPending) return
    setValidationError(null); setAbandoned(false)
    try { await rag.submit(query, context) } catch { setValidationError(new ApiError(422)) }
  }
  function submit(event) { event.preventDefault(); send() }
  // Abortar la solicitud no cancela el procesamiento en el servidor (prueba aislada, DESIGN §16.6).
  function stopWaiting() { rag.clear(); setAbandoned(true) }
  // Devuelve al compositor la pregunta enviada para corregirla, con el cursor al final.
  function editQuery() {
    const previous = rag.local?.query ?? rag.submission?.payload.query
    if (typeof previous === 'string') setQuery(previous)
    setValidationError(null)
    setTimeout(() => { const element = textarea.current; if (element) { element.focus(); element.setSelectionRange(element.value.length, element.value.length) } }, 0)
  }
  function newQuery() { rag.clear(); setQuery(''); setValidationError(null); setAbandoned(false); textarea.current?.focus() }
  // No habilitar la consulta mientras la URL todavía contiene parámetros ajenos al contrato RAG.
  if (canonicalQuery !== params.toString()) return <Loading label="Preparando la consulta segura…" />
  const result = rag.result
  const submittedQuery = rag.accessPending ? null : rag.local?.query ?? rag.submission?.payload.query
  const explanation = result?.policyResult || result?.technicalFailure ? null : resultExplanations[result?.state] ?? result?.message
  const length = Array.from(query).length
  const evidence = result ? result.fragments.filter((item) => item.usage === 'EVIDENCE') : []
  const references = result ? result.fragments.filter((item) => item.usage !== 'EVIDENCE') : []
  const handleFor = (fragment) => result.citations.find((citation) => citation.fragmentId === fragment.fragmentId)?.handle
  return <div className="mx-auto max-w-[var(--content-width-rag)] space-y-8">
    <PageHeader title="Consulta documental" description="Pregunta sobre tus documentos autorizados. Las respuestas citan sus fuentes." />
    {context && <section className="flex flex-wrap items-start justify-between gap-3 rounded-control border border-border bg-secondary p-3 text-xs text-secondary"><p>{contextLabel ? <>En relación con: <span className="font-medium text-primary">{contextLabel}</span>. </> : 'Consulta relacionada con un hallazgo del análisis. '}Esta referencia no es evidencia ni selecciona documentos.</p><Button variant="ghost" onClick={() => { rag.clear(); setParams({}, { replace: true }) }}>Quitar referencia</Button></section>}
    <form className="space-y-3" onSubmit={submit}>
      <div className="rounded-panel border border-border bg-surface p-3 focus-within:border-[var(--border-strong)]">
        {/* Nombre accesible del campo; visualmente basta el texto de ejemplo. */}<label htmlFor="rag-query" className="sr-only">Tu consulta</label>
        <textarea ref={textarea} id="rag-query" required minLength={1} rows={3} value={query} placeholder="Pregunta sobre cláusulas, obligaciones, fechas o asuntos de tus documentos" aria-describedby="rag-query-help"
          onChange={(event) => { setQuery(event.target.value); setValidationError(null) }}
          onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); send() } }}
          className="w-full resize-y border-0 bg-transparent p-1 text-[14px] leading-relaxed outline-none placeholder:text-[var(--text-muted)]" disabled={rag.busy || rag.accessPending} />
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
          <p id="rag-query-help" className="text-xs text-muted">Busca solo en los documentos que tienes autorizados. Ctrl + Enter para consultar.{length >= COUNTER_FROM && <span className="ml-2 font-mono">{length.toLocaleString('es-MX')} / {QUERY_LIMIT.toLocaleString('es-MX')}</span>}</p>
          <div className="flex flex-wrap gap-3">{(rag.hasInteraction && !rag.busy) && <Button variant="ghost" onClick={newQuery}>Nueva consulta</Button>}<Button type="submit" busy={rag.busy} disabled={rag.accessPending}><Icon name="search" />Consultar</Button></div>
        </div>
      </div>
      {!rag.hasInteraction && !rag.busy && !rag.accessPending && <section aria-label="Preguntas sugeridas" className="space-y-2"><h2 className="text-xs font-medium text-secondary">Preguntas sugeridas</h2><div className="flex flex-wrap gap-2">{suggestedQuestions.map((suggestion) => <Button key={suggestion} variant="secondary" className="h-auto max-w-full whitespace-normal py-1.5 text-left" onClick={() => { setQuery(suggestion); setValidationError(null) }}>{suggestion}</Button>)}</div><p className="text-xs text-muted">Los resultados se conservan solo en esta sesión.</p></section>}
    </form>
    {validationError && <ErrorState error={validationError} />}
    {abandoned && !rag.busy && !rag.hasInteraction && <p role="status" className="rounded-control border border-border bg-secondary px-3 py-2 text-xs text-secondary">Dejaste de esperar esta consulta. El sistema puede terminar de procesarla y la registrará en la auditoría.</p>}
    {submittedQuery && <section aria-label="Tu consulta enviada" className="space-y-1"><h2 className="text-xs font-medium text-secondary">Tú</h2><p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed">{submittedQuery}</p></section>}
    {rag.accessPending ? <Loading label="Comprobando acceso a la consulta…" /> : rag.busy && <QueryProgress seconds={seconds} onStop={stopWaiting} />}
    {rag.error && <RequestError error={rag.error} rag={rag} />}
    {rag.local && <section role="status" aria-live="polite" aria-label="Respuesta local" className="space-y-3"><h2 className="text-base font-semibold">Respuesta</h2><p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed">{rag.local.message}</p></section>}
    {result && <section className="space-y-5" aria-label="Resultado de la consulta">
      <div className="flex flex-wrap items-center gap-3"><h2 className="text-base font-semibold">Respuesta</h2>{result.policyResult ? null : <RagStateBanner state={result.state} />}</div>
      {result.policyResult && <ScopeRestrictionNotice message={result.message} />}
      {result.technicalFailure && <TechnicalFailure result={result} rag={rag} />}
      {explanation && <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed">{explanation}</p>}
      {!result.technicalFailure && <div><Button variant="secondary" onClick={editQuery}>Editar consulta</Button></div>}
      {result.response && <section aria-label="Respuesta generada" className="space-y-3 rounded-panel border border-border bg-surface p-5"><AnswerText text={result.response} citations={result.citations} onHighlight={setHighlighted} /><p className="text-xs text-muted">La síntesis no sustituye la consulta de las fuentes citadas ni el criterio profesional.</p></section>}
      {evidence.length > 0 && <section aria-label="Fuentes citadas" className="space-y-3"><h2 className="text-base font-semibold">Fuentes citadas ({evidence.length})</h2>{evidence.map((fragment) => <EvidenceCard key={fragment.fragmentId} fragment={fragment} handle={handleFor(fragment)} highlighted={highlighted === fragment.fragmentId} />)}</section>}
      {references.length > 0 && <section aria-label="Fuentes relacionadas" className="space-y-3"><h2 className="text-base font-semibold">Fuentes relacionadas ({references.length})</h2><p className="text-xs text-secondary">Fragmentos autorizados disponibles como referencia; no sustentan una respuesta.</p>{references.map((fragment) => <EvidenceCard key={fragment.fragmentId} fragment={fragment} handle={handleFor(fragment)} />)}</section>}
    </section>}
  </div>
}

export function RagDocumentPage() {
  const rag = useRag()
  const session = useSession()
  const [params, setParams] = useSearchParams()
  const id = readQuery(params.toString(), { fragment_id: isUuid }).fragment_id
  const fragmentMode = params.has('fragment_id')
  const canonicalQuery = fragmentMode ? id ? writeQuery({ fragment_id: id }, { fragment_id: isUuid }) : 'fragment_id=' : params.toString()
  const fragment = rag.result?.fragments.find((item) => item.fragmentId === id)
  useEffect(() => {
    if (params.toString() !== canonicalQuery) setParams(canonicalQuery, { replace: true })
  }, [canonicalQuery, params, setParams])
  if (params.toString() !== canonicalQuery) return <Loading label="Preparando el visor seguro…" />
  if (!fragmentMode) return <DocumentCatalog key={`${session.principal?.id ?? ''}:${session.generation}`} accessPending={rag.accessPending} />
  if (rag.accessPending) return <Loading label="Comprobando acceso al visor…" />
  return <div className="space-y-8"><PageHeader title="Visor documental" description="Fuente citada en tu consulta. Puedes abrir el documento completo para revisar su contexto." actions={<div className="flex flex-wrap gap-3"><Link className="inline-flex items-center gap-1 text-xs underline" to={rag.result?.contextReferenceId ? `/consulta?context_reference_id=${rag.result.contextReferenceId}` : '/consulta'}><Icon name="back" />Volver a la consulta</Link><Link className="text-xs underline" to="/documentos">Ver documentos autorizados</Link></div>} />{fragment ? <DocumentViewer fragment={fragment} /> : <EmptyState title="No hay un fragmento disponible" message="Abre el visor desde una consulta autorizada. La recarga no recupera ni vuelve a ejecutar consultas anteriores." />}</div>
}

import React, { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useSession } from '../../auth/SessionProvider.jsx'
import { Button } from '../../components/controls.jsx'
import { PageHeader } from '../../components/layout.jsx'
import { EmptyState, ErrorState, Loading } from '../../components/feedback.jsx'
import { Icon } from '../../components/Icon.jsx'
import { readQuery, writeQuery } from '../../shared/query.js'
import { ApiError } from '../../api/errors.js'
import { isUuid } from './adapters.js'
import { DocumentViewer, EvidenceCard, RagStateBanner } from './components.jsx'
import { useRag } from './state.jsx'
import { suggestedQuestions } from './localInteraction.js'
import { DocumentCatalog } from '../documents/DocumentCatalog.jsx'

const resultExplanations = Object.freeze({
  EVIDENCIA_INSUFICIENTE: 'Encontré información relacionada, pero la evidencia disponible no es suficiente para responder esta consulta con certeza. Puedes intentar especificar el documento, una fecha, una cláusula o el asunto que buscas.',
  SIN_EVIDENCIA: 'No encontré evidencia en los documentos a los que tienes acceso que permita responder esta pregunta. Puedes intentar indicar el nombre del documento, una fecha, una cláusula o el asunto que buscas.',
  SIN_AUTORIZACION: 'No puedo proporcionar información para esta consulta con tu nivel de acceso actual.',
})

export function RagQueryPage() {
  const rag = useRag()
  const session = useSession()
  const [params, setParams] = useSearchParams()
  const [query, setQuery] = useState('')
  const [validationError, setValidationError] = useState(null)
  const context = readQuery(params.toString(), { context_reference_id: isUuid }).context_reference_id ?? null
  const canonicalQuery = writeQuery(context ? { context_reference_id: context } : {}, { context_reference_id: isUuid })
  useEffect(() => {
    if (canonicalQuery !== params.toString()) setParams(canonicalQuery, { replace: true })
  }, [canonicalQuery, params, setParams])
  useEffect(() => { setQuery(''); setValidationError(null) }, [session.principal?.id, session.generation])
  async function submit(event) {
    event.preventDefault()
    if (rag.busy || rag.accessPending) return
    setValidationError(null)
    try { await rag.submit(query, context) } catch { setValidationError(new ApiError(422)) }
  }
  // No habilitar la consulta mientras la URL todavía contiene parámetros ajenos al contrato RAG.
  if (canonicalQuery !== params.toString()) return <Loading label="Preparando la consulta segura…" />
  const result = rag.result
  const submittedQuery = rag.accessPending ? null : rag.local?.query ?? rag.submission?.payload.query
  const explanation = result?.technicalFailure ? result.message : resultExplanations[result?.state] ?? result?.message
  return <div className="mx-auto max-w-[var(--content-width-rag)] space-y-8">
    <PageHeader title="Consulta documental" description="Consulta las fuentes autorizadas y distingue la evidencia original de la respuesta generada." />
    {context && <section className="rounded-control border border-border bg-secondary p-3 text-xs text-secondary"><p>Referencia contextual de un hallazgo. No constituye evidencia ni selecciona documentos.</p><Button className="mt-2" variant="ghost" onClick={() => { rag.clear(); setParams({}, { replace: true }) }}>Quitar referencia</Button></section>}
    <form className="space-y-3" onSubmit={submit}>
      <label htmlFor="rag-query" className="block text-xs font-medium text-secondary">Consulta en lenguaje natural</label>
      <textarea id="rag-query" required minLength={1} rows={4} value={query} onChange={(event) => { setQuery(event.target.value); setValidationError(null) }} className="w-full resize-y rounded-control border border-border bg-surface p-3 text-[13px]" disabled={rag.busy || rag.accessPending} />
      <div className="flex flex-wrap gap-3"><Button type="submit" busy={rag.busy} disabled={rag.accessPending}><Icon name="search" />Consultar</Button>{rag.submission && !rag.busy && (rag.error || result?.technicalFailure) && <Button variant="secondary" onClick={rag.retry}>Reintentar la misma operación</Button>}{(rag.hasInteraction || rag.busy) && <Button variant="ghost" onClick={() => { rag.clear(); setQuery(''); setValidationError(null) }}>Limpiar consulta</Button>}</div>
    </form>
    {validationError && <ErrorState error={validationError} />}
    {submittedQuery && <section aria-label="Tu consulta enviada" className="space-y-3"><h2 className="text-base font-semibold">Tú</h2><p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed">{submittedQuery}</p></section>}
    {rag.accessPending ? <Loading label="Comprobando acceso a la consulta…" /> : rag.busy && <Loading label="Consultando las fuentes autorizadas…" />}
    {rag.error && <ErrorState error={rag.error} />}
    {rag.local && <section role="status" aria-live="polite" aria-label="Respuesta local" className="space-y-3"><h2 className="text-base font-semibold">Respuesta</h2><p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed">{rag.local.message}</p></section>}
    {result && <section className="space-y-5" aria-label="Resultado de la consulta">
      <h2 className="text-base font-semibold">Respuesta</h2>
      <RagStateBanner state={result.state} />
      {result.technicalFailure && <ErrorState error={new ApiError(503)} />}
      {explanation && <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed">{explanation}</p>}
      {result.response && <section className="rounded-panel border border-border bg-surface p-5"><h3 className="mb-3 text-base font-semibold">Respuesta generada</h3><p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed">{result.response}</p><p className="mt-4 text-xs text-muted">La síntesis no sustituye la consulta de las fuentes citadas ni el criterio profesional.</p></section>}
      {!!result.fragments.length && <section aria-label="Fuentes autorizadas" className="space-y-4"><h2 className="text-base font-semibold">Fuentes</h2><h3 className="text-sm font-semibold">Fragmentos autorizados</h3>{result.fragments.map((fragment) => <EvidenceCard key={fragment.fragmentId} fragment={fragment} handle={result.citations.find((citation) => citation.fragmentId === fragment.fragmentId)?.handle} />)}</section>}
    </section>}
    {!rag.hasInteraction && !rag.busy && !rag.accessPending && <><EmptyState title="Formula una consulta" message="Los resultados y los fragmentos permanecen únicamente en esta sesión de consulta." /><section aria-label="Preguntas sugeridas" className="space-y-3"><h2 className="text-sm font-semibold">Preguntas sugeridas</h2><div className="flex flex-wrap gap-2">{suggestedQuestions.map((suggestion) => <Button key={suggestion} variant="secondary" className="h-auto max-w-full whitespace-normal text-left" onClick={() => { setQuery(suggestion); setValidationError(null) }}>{suggestion}</Button>)}</div></section></>}
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
  return <div className="space-y-8"><PageHeader title="Visor documental" description="Coteja únicamente un fragmento recibido en la consulta actual." actions={<div className="flex flex-wrap gap-3"><Link className="inline-flex items-center gap-1 text-xs underline" to={rag.result?.contextReferenceId ? `/consulta?context_reference_id=${rag.result.contextReferenceId}` : '/consulta'}><Icon name="back" />Volver a consulta</Link><Link className="text-xs underline" to="/documentos">Ver documentos autorizados</Link></div>} />{fragment ? <DocumentViewer fragment={fragment} /> : <EmptyState title="No hay un fragmento disponible" message="Abre el visor desde una consulta autorizada. La recarga no recupera ni vuelve a ejecutar consultas anteriores." />}</div>
}

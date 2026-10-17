import React, { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Button, Input, Select } from '../../components/controls.jsx'
import { FilterToolbar, ResultsSummary, useDebouncedCallback } from '../../components/filters.jsx'
import { DataTable, TechnicalDetails } from '../../components/data.jsx'
import { EmptyState, ErrorState, Loading, TableSkeleton } from '../../components/feedback.jsx'
import { PageHeader } from '../../components/layout.jsx'
import { formatDocumentDate as formatDate } from '../../shared/presentation.js'
import { ApiError } from '../../api/errors.js'
import { isUuid } from '../rag/adapters.js'
import { families, validDocumentId } from './adapters.js'
import { catalogPath, documentPath, readCatalog, readDocument, readOriginal, useViewerRead, useViewerAccess } from './api.js'
import { useSession } from '../../auth/SessionProvider.jsx'
import { PdfOriginal } from './PdfOriginal.jsx'
import { PrintControl } from './printing.jsx'
import { FullscreenButton, SearchableText, useFullscreen, ViewerHelp } from './viewerTools.jsx'

function Metadata({ item }) {
  return <aside className="min-w-0 rounded-panel border border-border bg-surface p-5 lg:col-span-5"><h2 className="mb-4 text-base font-semibold">Metadatos del documento</h2><dl className="space-y-3 break-words text-[13px] text-secondary">{[
    ['Documento', item.name], ['Tipo', item.type], ['Familia', families.find((family) => family.value === item.family)?.label], ['Fecha del documento', item.date === null ? 'No disponible' : formatDate(item.date)],
  ].map(([label, value]) => <div key={label}><dt className="text-xs font-medium">{label}</dt><dd>{value}</dd></div>)}</dl>
    {/* Versión e identificador sirven para trazabilidad, no para la lectura principal (UX-036). */}
    <TechnicalDetails className="mt-4"><dl><dt>Versión vigente</dt><dd>{item.versionNumber}</dd><dt>Identificador del documento</dt><dd className="mono">{item.documentId}</dd><dt>Identificador de la versión</dt><dd className="mono">{item.versionId}</dd></dl></TechnicalDetails></aside>
}
function FullDocument({ id, version, accessPending, initialPage }) {
  const [textMode, setTextMode] = useState(false)
  const panel = useRef(null)
  const fullscreen = useFullscreen(panel)
  const [pdf, setPdf] = useState(null)
  const [currentPage, setCurrentPage] = useState(initialPage)
  const detail = useViewerRead(documentPath(id, version), (client, signal) => readDocument(client, id, version, signal), !accessPending)
  const item = detail.data
  const pdfEnabled = !accessPending && item?.representation === 'PDF_ORIGINAL' && !textMode
  const original = useViewerRead(item ? documentPath(item.documentId, item.versionId, true) : null, (client, signal) => readOriginal(client, item.documentId, item.versionId, signal), pdfEnabled)
  if (accessPending || detail.state === 'loading') return <Loading label="Comprobando acceso al documento…" />
  if (detail.error) return <ErrorState error={detail.error} onRetry={detail.reload} />
  if (!item) return null
  const showText = item.representation === 'CONSOLIDATED_TEXT' || textMode
  return <div className="grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-12"><section ref={panel} className="viewer-panel min-w-0 rounded-panel border border-border bg-surface p-5 lg:col-span-7" aria-label="Documento completo"><h2 className="mb-3 break-words text-base font-semibold">{item.name}</h2>
    <div className="mb-4 flex flex-wrap items-center gap-3">{item.representation === 'PDF_ORIGINAL' && <div role="group" aria-label="Representación del documento" className="segmented"><button type="button" aria-pressed={!textMode} onClick={() => setTextMode(false)}>Archivo original PDF</button>{item.textAvailable && <button type="button" aria-pressed={textMode} onClick={() => setTextMode(true)}>Texto completo procesado</button>}</div>}
      <span aria-hidden="true" className="flex-1" /><FullscreenButton fullscreen={fullscreen} />
      {showText ? <PrintControl key="text" item={item} mode="text" text={item.textAvailable ? item.text : undefined} /> : <PrintControl key="pdf" item={item} mode="pdf" pages={pdf?.pages} renderPage={pdf?.renderPage} currentPage={currentPage} />}
      <ViewerHelp /></div>
    {showText ? item.textAvailable ? <SearchableText text={item.text} /> : <><p className="mb-3 text-xs text-muted">Texto completo procesado; no reproduce la maquetación original.</p><EmptyState title="Texto no disponible" message="No existe texto completo procesado disponible para esta versión." /></> : original.error ? <ErrorState error={original.error} onRetry={original.reload} /> : original.data ? <PdfOriginal blob={original.data} initialPage={currentPage} onReady={setPdf} onPage={setCurrentPage} /> : <Loading label="Cargando el archivo original autorizado…" />}
  </section><Metadata item={item} /></div>
}

// Filtros del catálogo recordados solo en memoria y solo para la misma sesión: al volver de un documento
// se conservan; no se escriben en la URL ni en el almacenamiento del navegador.
let rememberedFilters = null
const EMPTY_FILTERS = Object.freeze({ q: '', source_family: '', document_type: '' })
export function recallFilters(owner) {
  if (rememberedFilters?.owner !== owner) rememberedFilters = null
  return rememberedFilters?.filters ?? EMPTY_FILTERS
}
export function rememberFilters(owner, filters) { rememberedFilters = { owner, filters: { ...filters } } }

export function DocumentCatalog({ accessPending }) {
  const [params, setParams] = useSearchParams()
  const access = useViewerAccess()
  const session = useSession()
  const owner = `${session.principal?.id ?? ''}:${session.generation}`
  const blocked = accessPending || access.pending || !access.allowed
  const id = params.get('document_id')
  const version = params.get('version_id')
  const invalid = id !== null && !validDocumentId(id) || version !== null && (!id || !isUuid(version)) || params.getAll('document_id').length > 1 || params.getAll('version_id').length > 1
  const [draft, setDraft] = useState(() => recallFilters(owner))
  const [filters, setFilters] = useState(draft)
  useEffect(() => { rememberFilters(owner, filters) }, [owner, filters])
  const [cursor, setCursor] = useState('')
  const [previous, setPrevious] = useState([])
  const [validation, setValidation] = useState(null)
  const selected = Boolean(id) && !invalid
  const page = /^[1-9]\d{0,4}$/.test(params.get('page') || '') && params.getAll('page').length === 1 ? params.get('page') : null
  const canonical = new URLSearchParams(selected ? { document_id: id, ...(version ? { version_id: version } : {}), ...(page ? { page } : {}) } : {}).toString()
  const preparing = !invalid && params.toString() !== canonical
  useEffect(() => { if (preparing) setParams(canonical, { replace: true }) }, [preparing, canonical, setParams])
  const path = catalogPath({ ...filters, cursor })
  const catalog = useViewerRead(path, (client, signal) => readCatalog(client, { ...filters, cursor }, signal), !blocked && !preparing && !selected && !invalid)
  // Los selectores aplican al cambiar y la búsqueda tras una pausa breve al escribir (UX-035).
  function applyFilters(next) {
    try { catalogPath(next); setFilters({ ...next }); setCursor(''); setPrevious([]); setValidation(null); return true } catch { setValidation(new ApiError(422)); return false }
  }
  const scheduleFilters = useDebouncedCallback(applyFilters, 250)
  function choose(patch) { const next = { ...draft, ...patch }; setDraft(next); scheduleFilters(next) }
  function clearAll() { const empty = { q: '', source_family: '', document_type: '' }; setDraft(empty); applyFilters(empty) }
  const chips = [
    ...(filters.q ? [{ id: 'q', label: `Nombre: ${filters.q}`, onRemove: () => { const next = { ...draft, q: '' }; setDraft(next); applyFilters(next) } }] : []),
    ...(filters.document_type ? [{ id: 'type', label: `Tipo: ${filters.document_type}`, onRemove: () => choose({ document_type: '' }) }] : []),
    ...(filters.source_family ? [{ id: 'family', label: `Familia: ${families.find((family) => family.value === filters.source_family)?.label ?? filters.source_family}`, onRemove: () => choose({ source_family: '' }) }] : []),
  ]
  function apply(event) { event.preventDefault(); if (applyFilters(draft)) catalog.reload() }
  useEffect(() => {
    if (draft.q === filters.q) return undefined
    const timer = setTimeout(() => applyFilters(draft), 400)
    return () => clearTimeout(timer)
  }, [draft.q])
  const count = catalog.data?.items.length
  if (preparing) return <Loading label="Preparando el visor seguro…" />
  if (!accessPending && !access.pending && !access.allowed) return <ErrorState error={new ApiError(403)} />
  return <div className="space-y-8"><PageHeader title="Visor documental" description="Explora los documentos autorizados y abre su versión vigente sin realizar una consulta." actions={selected || invalid ? <Link to="/documentos" className="text-xs underline">Volver a documentos autorizados</Link> : undefined} />
    {invalid ? <ErrorState error={new ApiError(422)} /> : selected ? <FullDocument key={`${id}:${version ?? ''}`} id={id} version={version} accessPending={blocked} initialPage={page ? Number(page) : 1} /> : <section className="space-y-4" aria-label="Documentos autorizados"><form onSubmit={apply}><FilterToolbar label="Filtros de documentos" chips={chips} onClearAll={clearAll} primary={<><Input label="Buscar por nombre" type="search" compact value={draft.q} onChange={(event) => setDraft({ ...draft, q: event.target.value })} /><Select label="Tipo documental" value={draft.document_type} options={[{ value: '', label: 'Todos' }, { value: 'PDF', label: 'PDF' }, { value: 'DOCX', label: 'DOCX' }]} onChange={(event) => choose({ document_type: event.target.value })} /><Select label="Familia documental" value={draft.source_family} options={[{ value: '', label: 'Todas' }, ...families]} onChange={(event) => choose({ source_family: event.target.value })} /></>} /></form>
      {!blocked && catalog.data && <ResultsSummary count={count} hasMore={Boolean(catalog.data.nextCursor)} noun={['documento', 'documentos']} />}
      {validation && <ErrorState error={validation} />}{blocked || catalog.state === 'loading' ? <TableSkeleton label="Cargando documentos autorizados…" columns={5} /> : catalog.error ? <ErrorState error={catalog.error} onRetry={catalog.reload} /> : catalog.data?.items.length ? <DataTable caption="Documentos autorizados" rowKey="documentId" rows={catalog.data.items} columns={[{ key: 'name', label: 'Documento', wide: true }, { key: 'type', label: 'Tipo' }, { key: 'family', label: 'Familia', render: (item) => families.find((family) => family.value === item.family)?.label }, { key: 'date', label: 'Fecha', nowrap: true, render: (item) => item.date === null ? <span className="text-muted">Sin fecha declarada</span> : formatDate(item.date) }, { key: 'open', label: 'Acción', fit: true, render: (item) => <Link className="text-xs underline" aria-label={`Abrir ${item.name}`} to={`/documentos?${new URLSearchParams({ document_id: item.documentId, version_id: item.versionId })}`}>Abrir</Link> }]} /> : <EmptyState title="Sin documentos disponibles" message="No hay documentos autorizados vigentes para esta selección." />}
      {!blocked && catalog.data && (previous.length > 0 || catalog.data.nextCursor) && <nav aria-label="Paginación de documentos" className="flex flex-wrap gap-3"><Button variant="secondary" disabled={!previous.length} onClick={() => { setCursor(previous.at(-1)); setPrevious(previous.slice(0, -1)) }}>Página anterior</Button><Button variant="secondary" disabled={!catalog.data.nextCursor} onClick={() => { setPrevious([...previous, cursor]); setCursor(catalog.data.nextCursor) }}>Página siguiente</Button></nav>}
    </section>}
  </div>
}

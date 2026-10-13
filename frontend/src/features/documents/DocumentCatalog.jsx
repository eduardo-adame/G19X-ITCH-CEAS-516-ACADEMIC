import React, { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Button, FilterBar, Input, Select } from '../../components/controls.jsx'
import { DataTable } from '../../components/data.jsx'
import { EmptyState, ErrorState, Loading } from '../../components/feedback.jsx'
import { PageHeader } from '../../components/layout.jsx'
import { formatDate } from '../../shared/formatters.js'
import { ApiError } from '../../api/errors.js'
import { isUuid } from '../rag/adapters.js'
import { families, validDocumentId } from './adapters.js'
import { catalogPath, documentPath, readCatalog, readDocument, readOriginal, useViewerRead, useViewerAccess } from './api.js'
import { PdfOriginal } from './PdfOriginal.jsx'

function Metadata({ item }) {
  return <aside className="min-w-0 rounded-panel border border-border bg-surface p-5 lg:col-span-5"><h2 className="mb-4 text-base font-semibold">Metadatos del documento</h2><dl className="space-y-3 break-words text-[13px] text-secondary">{[
    ['Documento', item.name], ['Tipo', item.type], ['Familia', families.find((family) => family.value === item.family)?.label], ['Fecha del documento', item.date === null ? 'No disponible' : formatDate(item.date)], ['Versión vigente', item.versionNumber], ['Identificador del documento', item.documentId],
  ].map(([label, value]) => <div key={label}><dt className="text-xs font-medium">{label}</dt><dd>{value}</dd></div>)}</dl></aside>
}
function FullDocument({ id, version, accessPending }) {
  const [textMode, setTextMode] = useState(false)
  const detail = useViewerRead(documentPath(id, version), (client, signal) => readDocument(client, id, version, signal), !accessPending)
  const item = detail.data
  const pdfEnabled = !accessPending && item?.representation === 'PDF_ORIGINAL' && !textMode
  const original = useViewerRead(item ? documentPath(item.documentId, item.versionId, true) : null, (client, signal) => readOriginal(client, item.documentId, item.versionId, signal), pdfEnabled)
  if (accessPending || detail.state === 'loading') return <Loading label="Comprobando acceso al documento…" />
  if (detail.error) return <ErrorState error={detail.error} onRetry={detail.reload} />
  if (!item) return null
  const showText = item.representation === 'CONSOLIDATED_TEXT' || textMode
  return <div className="grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-12"><section className="min-w-0 rounded-panel border border-border bg-surface p-5 lg:col-span-7" aria-label="Documento completo"><h2 className="mb-3 break-words text-base font-semibold">{item.name}</h2><div className="mb-4 flex flex-wrap gap-3">{item.representation === 'PDF_ORIGINAL' && <Button variant="secondary" disabled={!textMode} onClick={() => setTextMode(false)}>Archivo original PDF</Button>}{item.textAvailable && item.representation === 'PDF_ORIGINAL' && <Button variant="secondary" disabled={textMode} onClick={() => setTextMode(true)}>Ver texto completo procesado</Button>}</div>
    {showText ? <><p className="mb-3 text-xs text-muted">Texto completo procesado; no reproduce la maquetación original.</p>{item.textAvailable ? <div tabIndex={0} role="region" aria-label="Texto completo procesado" className="max-h-[740px] overflow-y-auto whitespace-pre-wrap break-words font-serif text-sm leading-relaxed">{item.text}</div> : <EmptyState title="Texto no disponible" message="No existe texto completo procesado disponible para esta versión." />}</> : original.error ? <ErrorState error={original.error} onRetry={original.reload} /> : original.data ? <PdfOriginal blob={original.data} /> : <Loading label="Cargando el archivo original autorizado…" />}
  </section><Metadata item={item} /></div>
}

export function DocumentCatalog({ accessPending }) {
  const [params, setParams] = useSearchParams()
  const access = useViewerAccess()
  const blocked = accessPending || access.pending || !access.allowed
  const id = params.get('document_id')
  const version = params.get('version_id')
  const invalid = id !== null && !validDocumentId(id) || version !== null && (!id || !isUuid(version)) || params.getAll('document_id').length > 1 || params.getAll('version_id').length > 1
  const [draft, setDraft] = useState({ q: '', source_family: '', document_type: '' })
  const [filters, setFilters] = useState(draft)
  const [cursor, setCursor] = useState('')
  const [previous, setPrevious] = useState([])
  const [validation, setValidation] = useState(null)
  const selected = Boolean(id) && !invalid
  const canonical = new URLSearchParams(selected ? { document_id: id, ...(version ? { version_id: version } : {}) } : {}).toString()
  const preparing = !invalid && params.toString() !== canonical
  useEffect(() => { if (preparing) setParams(canonical, { replace: true }) }, [preparing, canonical, setParams])
  const path = catalogPath({ ...filters, cursor })
  const catalog = useViewerRead(path, (client, signal) => readCatalog(client, { ...filters, cursor }, signal), !blocked && !preparing && !selected && !invalid)
  function apply(event) {
    event.preventDefault()
    try { catalogPath(draft); setFilters({ ...draft }); setCursor(''); setPrevious([]); setValidation(null); catalog.reload() } catch { setValidation(new ApiError(422)) }
  }
  const count = catalog.data?.items.length
  if (preparing) return <Loading label="Preparando el visor seguro…" />
  if (!accessPending && !access.pending && !access.allowed) return <ErrorState error={new ApiError(403)} />
  return <div className="space-y-8"><PageHeader title="Visor documental" description="Explora los documentos autorizados y abre su versión vigente sin realizar una consulta." actions={selected || invalid ? <Link to="/documentos" className="text-xs underline">Volver a documentos autorizados</Link> : undefined} />
    {invalid ? <ErrorState error={new ApiError(422)} /> : selected ? <FullDocument key={`${id}:${version ?? ''}`} id={id} version={version} accessPending={blocked} /> : <section className="space-y-4" aria-label="Documentos autorizados"><form onSubmit={apply}><FilterBar count={count === undefined ? undefined : `${count} documentos en esta página`}><Input label="Buscar por nombre" compact value={draft.q} onChange={(event) => setDraft({ ...draft, q: event.target.value })} /><Select label="Tipo documental" value={draft.document_type} options={[{ value: '', label: 'Todos' }, { value: 'PDF', label: 'PDF' }, { value: 'DOCX', label: 'DOCX' }]} onChange={(event) => setDraft({ ...draft, document_type: event.target.value })} /><Select label="Familia documental" value={draft.source_family} options={[{ value: '', label: 'Todas' }, ...families]} onChange={(event) => setDraft({ ...draft, source_family: event.target.value })} /><Button type="submit" disabled={blocked}>Aplicar filtros</Button></FilterBar></form>
      {validation && <ErrorState error={validation} />}{blocked || catalog.state === 'loading' ? <Loading label="Cargando documentos autorizados…" /> : catalog.error ? <ErrorState error={catalog.error} onRetry={catalog.reload} /> : catalog.data?.items.length ? <DataTable caption="Documentos autorizados" rowKey="documentId" rows={catalog.data.items} columns={[{ key: 'name', label: 'Documento' }, { key: 'type', label: 'Tipo' }, { key: 'family', label: 'Familia', render: (item) => families.find((family) => family.value === item.family)?.label }, { key: 'date', label: 'Fecha', render: (item) => item.date === null ? 'No disponible' : formatDate(item.date) }, { key: 'open', label: 'Acción', render: (item) => <Link className="text-xs underline" aria-label={`Abrir ${item.name}`} to={`/documentos?${new URLSearchParams({ document_id: item.documentId, version_id: item.versionId })}`}>Abrir</Link> }]} /> : <EmptyState title="Sin documentos disponibles" message="No hay documentos autorizados vigentes para esta selección." />}
      {!blocked && catalog.data && (previous.length > 0 || catalog.data.nextCursor) && <nav aria-label="Paginación de documentos" className="flex flex-wrap gap-3"><Button variant="secondary" disabled={!previous.length} onClick={() => { setCursor(previous.at(-1)); setPrevious(previous.slice(0, -1)) }}>Página anterior</Button><Button variant="secondary" disabled={!catalog.data.nextCursor} onClick={() => { setPrevious([...previous, cursor]); setCursor(catalog.data.nextCursor) }}>Página siguiente</Button></nav>}
    </section>}
  </div>
}


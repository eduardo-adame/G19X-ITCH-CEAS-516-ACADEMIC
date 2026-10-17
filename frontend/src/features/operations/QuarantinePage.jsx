import React, { useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useSession } from '../../auth/SessionProvider.jsx'
import { can } from '../../auth/permissions.js'
import { ApiError } from '../../api/errors.js'
import { PageHeader, Modal } from '../../components/layout.jsx'
import { Button, Select, Tabs } from '../../components/controls.jsx'
import { CursorPager, DateRangeFields, FilterToolbar, RefreshButton, ResultsSummary, SearchField, useCursorHistory, useDebouncedCallback } from '../../components/filters.jsx'
import { DataTable, StatusBadge, TechnicalDetails } from '../../components/data.jsx'
import { ActionNotice, ResourceState, ErrorState } from '../../components/feedback.jsx'
import { familyLabel, quarantineCauseLabel } from '../../shared/labels.js'
import { formatDayRange as rangeText, localDayBoundary, localDayOf } from '../../shared/presentation.js'
import { quarantinePage, readFilters, changeFilters, filterQuery, families, quarantineCauses, uuid, pageKey } from './adapters.js'
import { queryPath, useOperationsRead, useOperation } from './api.js'
import { QuarantineEditor } from './QuarantineEditor.jsx'

// Pestañas sobre el filtro de estado existente; «Todos» corresponde a la ausencia del filtro.
const STATE_TABS = Object.freeze([
  { id: 'cuarentena-todos', state: '', label: 'Todos', empty: ['Sin elementos en cuarentena', 'No hay registros ni archivos retenidos para estos filtros.'] },
  { id: 'cuarentena-pendientes', state: 'Pendiente', label: 'Por resolver', empty: ['Nada por resolver', 'No hay elementos pendientes de corrección o descarte para estos filtros.'] },
  { id: 'cuarentena-reinyectados', state: 'Reinyectado', label: 'Reinyectados', empty: ['Sin reinyecciones', 'Ningún elemento se ha reinyectado con estos filtros.'] },
  { id: 'cuarentena-descartados', state: 'Descartado', label: 'Descartados', empty: ['Sin descartes', 'Ningún elemento se ha descartado con estos filtros.'] },
])
const withoutCursor = ({ cursor, ...rest }) => rest
const affected = (row) => [row.cause_description, row.row_number !== null && row.row_number !== undefined ? `fila ${row.row_number}` : null].filter(Boolean).join(' · ')

export function QuarantinePage() {
  const { principal, generation } = useSession()
  if (!can(principal, 'quarantine.read')) return <ErrorState error={new ApiError(403)} />
  return <QuarantineWorkspace key={generation} principal={principal} />
}
function QuarantineWorkspace({ principal }) {
  const [params, setParams] = useSearchParams(); const filters = readFilters(params.toString(), 'quarantine')
  const [editing, setEditing] = useState(null); const [discarding, setDiscarding] = useState(null); const [justification, setJustification] = useState(''); const [notice, setNotice] = useState(null)
  const [filterError, setFilterError] = useState(null)
  // Elementos ya reinyectados en esta sesión: «Corregir siguiente pendiente» no vuelve a ofrecerlos.
  const handled = useRef(new Set())
  const nextPending = (current) => can(principal, 'quarantine.reinject') ? resource.data?.items.find((row) => row.id !== current.id && row.canCorrect && !handled.current.has(row.id)) ?? null : null
  const resource = useOperationsRead(queryPath('quarantine', filters), quarantinePage); const mutation = useOperation()
  const activeTab = STATE_TABS.find((tab) => tab.state === (filters.state || '')) ?? STATE_TABS[0]
  function change(patch) {
    try { setParams(filterQuery(changeFilters(filters, patch), 'quarantine')); setFilterError(null); setEditing(null); setDiscarding(null); setNotice(null) }
    catch (cause) { setFilterError(cause) }
  }
  const schedule = useDebouncedCallback(change, 250)
  // Clave canónica (incluye el límite por defecto) para que pasar de página no reinicie el historial.
  const pages = useCursorHistory(pageKey(withoutCursor(filters), 'quarantine'))
  const from = localDayOf(filters.rejected_from); const to = localDayOf(filters.rejected_to)
  const chips = [
    ...(filters.source_family ? [{ id: 'family', label: `Familia: ${familyLabel(filters.source_family)}`, onRemove: () => change({ source_family: '' }) }] : []),
    ...(filters.cause_code ? [{ id: 'cause', label: `Regla: ${quarantineCauseLabel(filters.cause_code)}`, onRemove: () => change({ cause_code: '' }) }] : []),
    ...(from || to ? [{ id: 'range', label: `Retenido: ${rangeText(from, to)}`, onRemove: () => change({ rejected_from: '', rejected_to: '' }) }] : []),
    ...(filters.ingest_file_id ? [{ id: 'file', label: `Archivo: ${filters.ingest_file_id.slice(0, 8)}…`, onRemove: () => change({ ingest_file_id: '' }) }] : []),
  ]
  async function discard(event) {
    event.preventDefault(); if (mutation.busy || !discarding?.canAct || !justification.trim()) return
    const result = await mutation.execute('quarantine.discard', (api) => api.discard(discarding.id, justification))
    if (result) { setNotice({ title: 'Descarte confirmado.', detail: affected(discarding) }); setDiscarding(null); setJustification(''); resource.reload() }
  }
  return <>
    <PageHeader title="Zona de cuarentena" description="Registros y archivos retenidos por validación. El contenido original no se modifica." actions={<RefreshButton onClick={resource.reload} />} />
    <Tabs label="Estado de los elementos" items={STATE_TABS.map((tab) => ({ id: tab.id, label: tab.label, panelId: 'cuarentena-resultados' }))} active={activeTab.id} onChange={(id) => change({ state: STATE_TABS.find((tab) => tab.id === id).state })} />
    <FilterToolbar label="Filtros de cuarentena" chips={chips} onClearAll={() => change({ source_family: '', cause_code: '', rejected_from: '', rejected_to: '', ingest_file_id: '' })}
      primary={<>
        <Select label="Familia" value={filters.source_family || ''} onChange={(e) => schedule({ source_family: e.target.value })} options={[{ value: '', label: 'Todas' }, ...families.map((v) => ({ value: v, label: familyLabel(v) }))]} />
        <Select label="Regla infringida" value={filters.cause_code || ''} onChange={(e) => schedule({ cause_code: e.target.value })} options={[{ value: '', label: 'Todas' }, ...quarantineCauses.map((v) => ({ value: v, label: quarantineCauseLabel(v) }))]} />
        <DateRangeFields quick fromLabel="Retenido desde" toLabel="Retenido hasta" from={from} to={to} onChange={(range) => change({ rejected_from: localDayBoundary(range.from), rejected_to: localDayBoundary(range.to, { end: true }) })} />
      </>}
      secondary={<SearchField label="Archivo de origen (identificador)" value={filters.ingest_file_id || ''} validate={uuid} invalidMessage="Pega el identificador completo (36 caracteres, p. ej. 1a2b3c4d-…)." onApply={(value) => change({ ingest_file_id: value })} />}
      secondaryActive={filters.ingest_file_id ? 1 : 0} />
    {filterError && <ErrorState error={filterError} />}
    {notice && <ActionNotice title={notice.title} onDismiss={() => setNotice(null)}>{notice.detail}</ActionNotice>}
    {mutation.error && !discarding && <ErrorState error={mutation.error} title={mutation.error.status === 403 ? undefined : 'No se pudo descartar el registro'} />}
    <div id="cuarentena-resultados" role="tabpanel" aria-labelledby={activeTab.id}><ResourceState resource={resource} context="la cuarentena" skeleton="table" empty={{ title: activeTab.empty[0], message: activeTab.empty[1] }}>{(data) => <div className="space-y-4"><ResultsSummary count={data.items.length} hasMore={Boolean(data.next_cursor)} /><DataTable caption="Elementos en cuarentena" rows={data.items} columns={[
      { key: 'cause_description', label: 'Causa', medium: true }, { key: 'source_family', label: 'Familia', render: (row) => familyLabel(row.source_family) ?? '—' }, { key: 'row_number', label: 'Fila', numeric: true },
      { key: 'createdLabel', label: 'Retenido', nowrapWide: true }, { key: 'state', label: 'Estado', render: (row) => <StatusBadge kind="quarantine" value={row.state} /> },
      { key: 'actions', label: 'Acciones', fit: true, sticky: true, render: (row) => <div className="flex flex-wrap items-center gap-2">{row.canCorrect && can(principal, 'quarantine.reinject') && <Button variant="secondary" onClick={() => setEditing(row)}>Corregir</Button>}{row.canAct && can(principal, 'quarantine.discard') && <Button variant="danger" onClick={() => { mutation.clear(); setDiscarding(row); setJustification('') }}>Descartar</Button>}{!row.canAct && <span className="text-xs text-muted">Resuelto</span>}{row.canAct && !row.canCorrect && <span className="text-xs text-muted">Sin registro tabular corregible</span>}</div> },
      { key: 'detail', label: 'Detalle', fit: true, render: (row) => <TechnicalDetails summary="Ver"><dl><dt>Elemento</dt><dd className="mono">{row.id}</dd><dt>Archivo de origen</dt><dd className="mono">{row.ingest_file_id ?? '—'}</dd><dt>Registro fuente</dt><dd className="mono">{row.source_record_id ?? '—'}</dd><dt>Regla</dt><dd className="mono">{row.cause_code}</dd><dt>Retenido</dt><dd className="mono">{row.createdAudit}</dd></dl></TechnicalDetails> },
    ]} /><CursorPager hasNext={Boolean(data.next_cursor)} hasPrevious={pages.canGoBack} atDeepLink={Boolean(filters.cursor) && !pages.canGoBack}
      onNext={() => { pages.push(filters.cursor); setParams(filterQuery({ ...filters, cursor: data.next_cursor }, 'quarantine')) }}
      onPrevious={() => { const previous = pages.pop(); setParams(filterQuery(previous ? { ...withoutCursor(filters), cursor: previous } : withoutCursor(filters), 'quarantine')) }}
      onFirst={() => setParams(filterQuery(withoutCursor(filters), 'quarantine'))} /></div>}</ResourceState></div>
    {editing && !resource.error && <QuarantineEditor key={editing.id} item={editing} onClose={() => setEditing(null)} onConfirmed={(result) => { handled.current.add(editing.id); setNotice({ title: result.message, detail: affected(editing) }); resource.reload() }} nextPending={() => nextPending(editing)} onNext={(row) => setEditing(row)} />}
    <Modal open={Boolean(discarding) && !resource.error} title="Confirmar descarte" onClose={() => { setDiscarding(null); setJustification('') }}><form onSubmit={discard} className="space-y-4"><div className="field space-y-1"><label htmlFor="discard-justification" className="block text-xs font-medium text-secondary">Justificación del descarte</label><textarea id="discard-justification" className="control min-h-24 resize-y py-2" value={justification} required disabled={mutation.busy} aria-describedby="discard-justification-help" onChange={(e) => setJustification(e.target.value)} /><p id="discard-justification-help" className="flex justify-between gap-3 text-xs text-muted"><span>Explica por qué se descarta; queda registrada junto con el descarte.</span><span className="tabular-nums" aria-live="off">{Array.from(justification).length.toLocaleString('es-MX')} caracteres</span></p></div><p className="text-sm text-secondary">El registro se excluirá de futuras reinyecciones. El original se conserva.</p>{mutation.error && <ErrorState error={mutation.error} title={mutation.error.status === 403 ? undefined : 'No se pudo descartar el registro'} />}<Button type="submit" variant="danger" busy={mutation.busy} disabled={!justification.trim() || Boolean(mutation.error)}>Confirmar descarte</Button></form></Modal>
  </>
}

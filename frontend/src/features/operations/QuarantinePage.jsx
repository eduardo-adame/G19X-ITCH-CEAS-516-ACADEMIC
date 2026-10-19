import React, { useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useSession } from '../../auth/SessionProvider.jsx'
import { can } from '../../auth/permissions.js'
import { ApiError } from '../../api/errors.js'
import { PageHeader, Modal } from '../../components/layout.jsx'
import { Button, Select, Tabs } from '../../components/controls.jsx'
import { CursorPager, DateRangeFields, FilterToolbar, RefreshButton, ResultsSummary, SearchField, useCursorHistory, useDebouncedCallback } from '../../components/filters.jsx'
import { DataTable, StatusBadge } from '../../components/data.jsx'
import { DetailButton, DetailField, DetailPanel, DetailSection } from '../../components/detail.jsx'
import { ActionNotice, ResourceState, ErrorState } from '../../components/feedback.jsx'
import { familyLabel, quarantineCauseLabel } from '../../shared/labels.js'
import { formatDayRange as rangeText, localDayBoundary, localDayOf } from '../../shared/presentation.js'
import { conflictComparison, quarantinePage, readFilters, changeFilters, filterQuery, families, quarantineCauses, recordLocation, uuid, pageKey } from './adapters.js'
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
const affected = (row) => [row.cause_description, recordLocation(row) || null].filter(Boolean).join(' · ')
const shownValue = (value) => value === null ? 'Sin valor' : String(value)

// Conflicto de identidad: el dato vigente no cambia; se compara con el recibido para decidir el descarte.
function ConflictComparison({ row }) {
  const fields = conflictComparison(row)
  if (!fields.length) return null
  return <div className="space-y-2"><p className="text-sm">El identificador ya existe con otros datos. El dato vigente no se modifica; el registro recibido no se incorporará.</p>
    <div className="overflow-x-auto"><table className="w-full text-xs"><caption className="sr-only">Dato vigente y dato recibido</caption><thead><tr className="text-left text-secondary"><th scope="col" className="py-1 pr-3 font-medium">Campo</th><th scope="col" className="py-1 pr-3 font-medium">Vigente</th><th scope="col" className="py-1 font-medium">Recibido</th></tr></thead>
      <tbody>{fields.map((item) => <tr key={item.field} className={item.differs ? 'font-medium' : 'text-secondary'}><th scope="row" className="py-1 pr-3 text-left font-mono font-normal">{item.field}</th><td className="py-1 pr-3">{shownValue(item.current)}</td><td className="py-1">{shownValue(item.received)}{item.differs && <span className="ml-1 text-[var(--warning)]">· distinto</span>}</td></tr>)}</tbody></table></div></div>
}

// Acciones de la fila en una sola línea (Corregir a la izquierda, Descartar a la derecha) para no alargar la fila; la
// nota de por qué no se puede corregir va debajo, con ancho acotado para no ensanchar la columna.
function QuarantineActions({ row, canReinject, canDiscard, onCorrect, onDiscard }) {
  if (!row.canAct) return <span className="text-xs text-muted">Resuelto</span>
  const note = !row.canCorrect && (row.isConflict ? 'Conflicto de identidad: solo puede descartarse' : 'Sin registro tabular corregible')
  return <div className="grid gap-1">
    <div className="flex flex-nowrap items-center gap-2">{row.canCorrect && canReinject && <Button variant="secondary" onClick={onCorrect}>Corregir</Button>}{canDiscard && <Button variant="danger" onClick={onDiscard}>Descartar</Button>}</div>
    {note && <span className="block w-max max-w-[13rem] text-xs text-muted">{note}</span>}
  </div>
}
// Detalle del elemento retenido: causa con su regla registrada, ubicación en el archivo y los identificadores
// copiables. Las acciones (corregir, descartar) permanecen en la tabla.
function QuarantineDetailPanel({ row, onClose }) {
  if (!row) return null
  return <DetailPanel title="Detalle del elemento retenido" subtitle={row.cause_description} onClose={onClose}>
    <DetailSection title="Retención">
      <DetailField label="Regla" value={row.cause_description} code={row.cause_code} />
      <DetailField label="Estado" value={<StatusBadge kind="quarantine" value={row.state} />} />
      <DetailField label="Retenido" value={row.createdAudit} mono />
    </DetailSection>
    <DetailSection title="Origen">
      <DetailField label="Familia" value={familyLabel(row.source_family)} />
      <DetailField label="Fila" value={row.row_number} />
      {row.source_sheet && <DetailField label="Hoja" value={row.source_sheet} />}
    </DetailSection>
    <DetailSection title="Identificadores">
      <DetailField label="Elemento" value={row.id} mono copy="Copiar elemento" />
      <DetailField label="Archivo de origen" value={row.ingest_file_id} mono copy="Copiar archivo de origen" />
      <DetailField label="Registro fuente" value={row.source_record_id} mono copy="Copiar registro fuente" />
    </DetailSection>
  </DetailPanel>
}
export function QuarantinePage() {
  const { principal, generation } = useSession()
  if (!can(principal, 'quarantine.read')) return <ErrorState error={new ApiError(403)} />
  return <QuarantineWorkspace key={generation} principal={principal} />
}
function QuarantineWorkspace({ principal }) {
  const [params, setParams] = useSearchParams(); const filters = readFilters(params.toString(), 'quarantine')
  const [editing, setEditing] = useState(null); const [discarding, setDiscarding] = useState(null); const [justification, setJustification] = useState(''); const [notice, setNotice] = useState(null)
  const [filterError, setFilterError] = useState(null); const [detailId, setDetailId] = useState(null)
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
      { key: 'cause_description', label: 'Causa', medium: true }, { key: 'source_family', label: 'Familia', render: (row) => familyLabel(row.source_family) ?? '—' }, { key: 'row_number', label: 'Fila', numeric: true, render: (row) => row.row_number === null || row.row_number === undefined ? '—' : <span>{row.row_number}{row.source_sheet && <span className="block text-xs text-muted">Hoja {row.source_sheet}</span>}</span> },
      { key: 'createdLabel', label: 'Retenido', nowrapWide: true }, { key: 'state', label: 'Estado', render: (row) => <StatusBadge kind="quarantine" value={row.state} /> },
      { key: 'actions', label: 'Acciones', fit: true, sticky: true, render: (row) => <QuarantineActions row={row} canReinject={can(principal, 'quarantine.reinject')} canDiscard={can(principal, 'quarantine.discard')} onCorrect={() => setEditing(row)} onDiscard={() => { mutation.clear(); setDiscarding(row); setJustification('') }} /> },
      { key: 'detail', label: 'Detalle', fit: true, render: (row) => <DetailButton subject={row.row_number === null || row.row_number === undefined ? row.cause_description : `la fila ${row.row_number}`} onClick={() => setDetailId(row.id)} /> },
    ]} selectedKey={detailId} /><QuarantineDetailPanel row={data.items.find((item) => item.id === detailId)} onClose={() => setDetailId(null)} /><CursorPager hasNext={Boolean(data.next_cursor)} hasPrevious={pages.canGoBack} atDeepLink={Boolean(filters.cursor) && !pages.canGoBack}
      onNext={() => { pages.push(filters.cursor); setParams(filterQuery({ ...filters, cursor: data.next_cursor }, 'quarantine')) }}
      onPrevious={() => { const previous = pages.pop(); setParams(filterQuery(previous ? { ...withoutCursor(filters), cursor: previous } : withoutCursor(filters), 'quarantine')) }}
      onFirst={() => setParams(filterQuery(withoutCursor(filters), 'quarantine'))} /></div>}</ResourceState></div>
    {editing && !resource.error && <QuarantineEditor key={editing.id} item={editing} onClose={() => setEditing(null)} onConfirmed={(result) => { handled.current.add(editing.id); setNotice({ title: result.message, detail: affected(editing) }); resource.reload() }} nextPending={() => nextPending(editing)} onNext={(row) => setEditing(row)} />}
    <Modal open={Boolean(discarding) && !resource.error} title="Confirmar descarte" onClose={() => { setDiscarding(null); setJustification('') }}><form onSubmit={discard} className="space-y-4"><div className="field space-y-1"><label htmlFor="discard-justification" className="block text-xs font-medium text-secondary">Justificación del descarte</label><textarea id="discard-justification" className="control min-h-24 resize-y py-2" value={justification} required disabled={mutation.busy} aria-describedby="discard-justification-help" onChange={(e) => setJustification(e.target.value)} /><p id="discard-justification-help" className="flex justify-between gap-3 text-xs text-muted"><span>Explica por qué se descarta; queda registrada junto con el descarte.</span><span className="tabular-nums" aria-live="off">{Array.from(justification).length.toLocaleString('es-MX')} caracteres</span></p></div>{discarding?.isConflict && <ConflictComparison row={discarding} />}<p className="text-sm text-secondary">El registro se excluirá de futuras reinyecciones. El original se conserva.</p>{mutation.error && <ErrorState error={mutation.error} title={mutation.error.status === 403 ? undefined : 'No se pudo descartar el registro'} />}<Button type="submit" variant="danger" busy={mutation.busy} disabled={!justification.trim() || Boolean(mutation.error)}>Confirmar descarte</Button></form></Modal>
  </>
}

import React, { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useSession } from '../../auth/SessionProvider.jsx'
import { can } from '../../auth/permissions.js'
import { ApiError } from '../../api/errors.js'
import { PageHeader, Modal } from '../../components/layout.jsx'
import { Button, Input, Select, FilterBar, Tabs } from '../../components/controls.jsx'
import { DataTable, StatusBadge, TechnicalDetails } from '../../components/data.jsx'
import { ActionNotice, ResourceState, ErrorState } from '../../components/feedback.jsx'
import { familyLabel, quarantineCauseLabel } from '../../shared/labels.js'
import { localDayBoundary, localDayOf } from '../../shared/presentation.js'
import { quarantinePage, readFilters, changeFilters, filterQuery, families, quarantineCauses } from './adapters.js'
import { queryPath, useOperationsRead, useOperation } from './api.js'
import { QuarantineEditor } from './QuarantineEditor.jsx'

// Pestañas sobre el filtro de estado existente; «Todos» corresponde a la ausencia del filtro.
const STATE_TABS = Object.freeze([
  { id: 'cuarentena-todos', state: '', label: 'Todos', empty: ['Sin elementos en cuarentena', 'No hay registros ni archivos retenidos para estos filtros.'] },
  { id: 'cuarentena-pendientes', state: 'Pendiente', label: 'Por resolver', empty: ['Nada por resolver', 'No hay elementos pendientes de corrección o descarte para estos filtros.'] },
  { id: 'cuarentena-reinyectados', state: 'Reinyectado', label: 'Reinyectados', empty: ['Sin reinyecciones', 'Ningún elemento se ha reinyectado con estos filtros.'] },
  { id: 'cuarentena-descartados', state: 'Descartado', label: 'Descartados', empty: ['Sin descartes', 'Ningún elemento se ha descartado con estos filtros.'] },
])
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
  const resource = useOperationsRead(queryPath('quarantine', filters), quarantinePage); const mutation = useOperation()
  const activeTab = STATE_TABS.find((tab) => tab.state === (filters.state || '')) ?? STATE_TABS[0]
  function change(patch) {
    try { setParams(filterQuery(changeFilters(filters, patch), 'quarantine')); setFilterError(null); setEditing(null); setDiscarding(null); setNotice(null) }
    catch (cause) { setFilterError(cause) }
  }
  async function discard(event) {
    event.preventDefault(); if (mutation.busy || !discarding?.canAct || !justification.trim()) return
    const result = await mutation.execute('quarantine.discard', (api) => api.discard(discarding.id, justification))
    if (result) { setNotice({ title: 'Descarte confirmado.', detail: affected(discarding) }); setDiscarding(null); setJustification(''); resource.reload() }
  }
  return <>
    <PageHeader title="Zona de cuarentena" description="Registros y archivos retenidos por validación. El contenido original no se modifica." />
    <Tabs label="Estado de los elementos" items={STATE_TABS.map((tab) => ({ id: tab.id, label: tab.label, panelId: 'cuarentena-resultados' }))} active={activeTab.id} onChange={(id) => change({ state: STATE_TABS.find((tab) => tab.id === id).state })} />
    <FilterBar>
      <Select label="Familia" value={filters.source_family || ''} onChange={(e) => change({ source_family: e.target.value })} options={[{ value: '', label: 'Todas' }, ...families.map((v) => ({ value: v, label: familyLabel(v) }))]} />
      <Select label="Regla infringida" value={filters.cause_code || ''} onChange={(e) => change({ cause_code: e.target.value })} options={[{ value: '', label: 'Todas' }, ...quarantineCauses.map((v) => ({ value: v, label: quarantineCauseLabel(v) }))]} />
      <Input key={`from-${filters.rejected_from || ''}`} label="Retenido desde" type="date" compact defaultValue={localDayOf(filters.rejected_from)} onChange={(e) => change({ rejected_from: localDayBoundary(e.target.value) })} />
      <Input key={`to-${filters.rejected_to || ''}`} label="Retenido hasta" type="date" compact defaultValue={localDayOf(filters.rejected_to)} onChange={(e) => change({ rejected_to: localDayBoundary(e.target.value, { end: true }) })} />
      <Button variant="secondary" onClick={resource.reload}>Actualizar estado</Button>
    </FilterBar>
    {filters.ingest_file_id && <p className="flex flex-wrap items-center gap-2 text-xs text-secondary">Mostrando solo el archivo recibido <span className="font-mono">{filters.ingest_file_id.slice(0, 8)}…</span><Button variant="ghost" onClick={() => change({ ingest_file_id: '' })}>Quitar filtro de archivo</Button></p>}
    <details className="text-xs text-secondary" open={Boolean(filters.ingest_file_id)}><summary className="cursor-pointer w-fit">Filtros avanzados</summary><div className="mt-2 max-w-md"><Input key={`file-${filters.ingest_file_id || ''}`} label="Archivo de origen (identificador)" compact defaultValue={filters.ingest_file_id || ''} onBlur={(e) => change({ ingest_file_id: e.target.value })} /></div></details>
    {filterError && <ErrorState error={filterError} />}
    {notice && <ActionNotice title={notice.title} onDismiss={() => setNotice(null)}>{notice.detail}</ActionNotice>}
    {mutation.error && !discarding && <ErrorState error={mutation.error} title={mutation.error.status === 403 ? undefined : 'No se pudo descartar el registro'} />}
    <div id="cuarentena-resultados" role="tabpanel" aria-labelledby={activeTab.id}><ResourceState resource={resource} context="la cuarentena" skeleton="table" empty={{ title: activeTab.empty[0], message: activeTab.empty[1] }}>{(data) => <div className="space-y-4"><DataTable caption="Elementos en cuarentena" rows={data.items} columns={[
      { key: 'cause_description', label: 'Causa' }, { key: 'source_family', label: 'Familia', render: (row) => familyLabel(row.source_family) ?? '—' }, { key: 'row_number', label: 'Fila' },
      { key: 'createdLabel', label: 'Retenido' }, { key: 'state', label: 'Estado', render: (row) => <StatusBadge kind="quarantine" value={row.state} /> },
      { key: 'actions', label: 'Acciones', render: (row) => <div className="flex flex-wrap items-center gap-2">{row.canCorrect && can(principal, 'quarantine.reinject') && <Button variant="secondary" onClick={() => setEditing(row)}>Corregir</Button>}{row.canAct && can(principal, 'quarantine.discard') && <Button variant="danger" onClick={() => { mutation.clear(); setDiscarding(row); setJustification('') }}>Descartar</Button>}{!row.canAct && <span className="text-xs text-muted">Resuelto</span>}{row.canAct && !row.canCorrect && <span className="text-xs text-muted">Sin registro tabular corregible</span>}</div> },
      { key: 'detail', label: 'Detalle', render: (row) => <TechnicalDetails summary="Ver"><dl><dt>Elemento</dt><dd className="mono">{row.id}</dd><dt>Archivo de origen</dt><dd className="mono">{row.ingest_file_id ?? '—'}</dd><dt>Registro fuente</dt><dd className="mono">{row.source_record_id ?? '—'}</dd><dt>Regla</dt><dd className="mono">{row.cause_code}</dd><dt>Retenido</dt><dd className="mono">{row.createdAudit}</dd></dl></TechnicalDetails> },
    ]} />{data.next_cursor && <Button variant="secondary" onClick={() => setParams(filterQuery({ ...filters, cursor: data.next_cursor }, 'quarantine'))}>Página siguiente</Button>}</div>}</ResourceState></div>
    {editing && !resource.error && <QuarantineEditor key={editing.id} item={editing} onClose={() => setEditing(null)} onConfirmed={(result) => { setNotice({ title: result.message, detail: affected(editing) }); resource.reload() }} />}
    <Modal open={Boolean(discarding) && !resource.error} title="Confirmar descarte" onClose={() => { setDiscarding(null); setJustification('') }}><form onSubmit={discard} className="space-y-4"><Input label="Justificación del descarte" value={justification} required disabled={mutation.busy} onChange={(e) => setJustification(e.target.value)} /><p className="text-sm text-secondary">El registro se excluirá de futuras reinyecciones. El original se conserva.</p>{mutation.error && <ErrorState error={mutation.error} title={mutation.error.status === 403 ? undefined : 'No se pudo descartar el registro'} />}<Button type="submit" variant="danger" busy={mutation.busy} disabled={!justification.trim() || Boolean(mutation.error)}>Confirmar descarte</Button></form></Modal>
  </>
}

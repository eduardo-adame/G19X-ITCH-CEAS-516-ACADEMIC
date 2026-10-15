import React, { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useSession } from '../../auth/SessionProvider.jsx'
import { can } from '../../auth/permissions.js'
import { ApiError } from '../../api/errors.js'
import { PageHeader } from '../../components/layout.jsx'
import { Button, Input, FilterBar, Select } from '../../components/controls.jsx'
import { DataTable, StatusBadge, TechnicalDetails } from '../../components/data.jsx'
import { ResourceState, ErrorState } from '../../components/feedback.jsx'
import { actorTypeLabel, AUDIT_ACTION_LABELS, auditActionLabel } from '../../shared/labels.js'
import { localDayBoundary, localDayOf } from '../../shared/presentation.js'
import { auditPage, readFilters, filterQuery } from './adapters.js'
import { queryPath, useOperationsRead } from './api.js'

export function AuditPage() {
  const { principal, generation } = useSession()
  if (!can(principal, 'audit.read.own')) return <ErrorState error={new ApiError(403)} />
  return <AuditWorkspace key={generation} principal={principal} />
}
const actionOptions = (current) => {
  const known = Object.entries(AUDIT_ACTION_LABELS).map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label, 'es'))
  return [{ value: '', label: 'Todas' }, ...(current && !Object.hasOwn(AUDIT_ACTION_LABELS, current) ? [{ value: current, label: current }] : []), ...known]
}
// Resumen humano de cada evento con todos los campos de RF-079 conservados en el detalle de la fila.
function AuditDetail({ row }) {
  return <TechnicalDetails summary="Ver"><dl>
    <dt>Acción</dt><dd className="mono">{row.action}</dd><dt>Resultado</dt><dd className="mono">{row.result}</dd>
    <dt>Tipo de actor</dt><dd className="mono">{row.actor_type}</dd><dt>Tipo de recurso</dt><dd className="mono">{row.resource_type}</dd>
    <dt>Recurso</dt><dd className="mono">{row.resource_identifier ?? '—'}</dd><dt>Causa segura</dt><dd className="mono">{row.safe_cause_code ?? '—'}</dd>
    <dt>Operación</dt><dd className="mono">{row.operation_id}</dd><dt>Correlación</dt><dd className="mono">{row.correlation_id}</dd>
    {row.resources.length > 0 && <><dt>Referencias</dt><dd className="mono"><ul>{row.resources.map((item, index) => <li key={index}>{item.resource_type}: {item.resource_identifier}{item.id_documento && ` · ${item.id_documento}`}{item.fragment_id && ` · ${item.fragment_id}`}</li>)}</ul></dd></>}
  </dl></TechnicalDetails>
}
function AuditWorkspace({ principal }) {
  const [params, setParams] = useSearchParams(); const filters = readFilters(params.toString(), 'audit')
  const [error, setError] = useState(null); const resource = useOperationsRead(queryPath('audit', filters), auditPage)
  function submit(event) {
    event.preventDefault(); const data = new FormData(event.currentTarget); const next = {}
    for (const [key, value] of data) if (value) next[key] = value
    if (next.occurred_from) next.occurred_from = localDayBoundary(next.occurred_from)
    if (next.occurred_to) next.occurred_to = localDayBoundary(next.occurred_to, { end: true })
    try { setParams(filterQuery(next, 'audit')); setError(null) } catch (cause) { setError(cause) }
  }
  return <>
    <PageHeader title="Auditoría" description={can(principal, 'audit.read.all') ? 'Bitácora de eventos del sistema. Solo lectura.' : 'Tus eventos de ingesta y cuarentena. Solo lectura.'} />
    <form key={params.toString()} onSubmit={submit} className="space-y-2"><FilterBar>
      <Input compact label="Desde" type="date" name="occurred_from" defaultValue={localDayOf(filters.occurred_from)} />
      <Input compact label="Hasta" type="date" name="occurred_to" defaultValue={localDayOf(filters.occurred_to)} />
      <Select label="Evento" name="action" defaultValue={filters.action || ''} options={actionOptions(filters.action)} />
      <Select label="Filas por página" name="limit" defaultValue={filters.limit || '25'} options={['25', '50', '100'].map((value) => ({ value, label: value }))} />
      <Button type="submit">Aplicar filtros</Button><Button variant="secondary" onClick={resource.reload}>Actualizar</Button>
    </FilterBar>
    <details className="text-xs text-secondary" open={Boolean(filters.resource_type || filters.correlation_id)}><summary className="w-fit cursor-pointer">Filtros avanzados</summary><div className="mt-2 grid max-w-2xl grid-cols-1 gap-3 sm:grid-cols-2">
      <Input compact label="Tipo de recurso" name="resource_type" maxLength={128} defaultValue={filters.resource_type || ''} />
      <Input compact label="Correlación (identificador)" name="correlation_id" defaultValue={filters.correlation_id || ''} />
    </div></details></form>
    {error && <ErrorState error={error} />}
    <ResourceState resource={resource} context="la auditoría">{(data) => <div className="space-y-4"><DataTable caption="Eventos de auditoría" rows={data.items} columns={[
      { key: 'occurredLabel', label: 'Fecha y hora', render: (row) => <span className="whitespace-nowrap font-mono text-xs">{row.occurredLabel}</span> },
      { key: 'actor_identifier', label: 'Actor', render: (row) => <span>{row.actor_identifier}{row.actor_type !== 'HUMAN' && <span className="block text-xs text-muted">{actorTypeLabel(row.actor_type)}</span>}</span> },
      { key: 'action', label: 'Evento', render: (row) => auditActionLabel(row.action) },
      { key: 'result', label: 'Resultado', render: (row) => <StatusBadge kind="audit" value={row.result} /> },
      { key: 'detail', label: 'Detalle', render: (row) => <AuditDetail row={row} /> },
    ]} />{data.next_cursor && <Button variant="secondary" onClick={() => setParams(filterQuery({ ...filters, cursor: data.next_cursor }, 'audit'))}>Página siguiente</Button>}</div>}</ResourceState>
  </>
}

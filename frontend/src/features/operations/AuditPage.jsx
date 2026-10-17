import React, { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useSession } from '../../auth/SessionProvider.jsx'
import { can } from '../../auth/permissions.js'
import { ApiError } from '../../api/errors.js'
import { PageHeader } from '../../components/layout.jsx'
import { Button, CopyButton, Select } from '../../components/controls.jsx'
import { CursorPager, DateRangeFields, FilterToolbar, RefreshButton, ResultsSummary, SearchField, useCursorHistory, useDebouncedCallback } from '../../components/filters.jsx'
import { DataTable, StatusBadge, TechnicalDetails } from '../../components/data.jsx'
import { ResourceState, ErrorState } from '../../components/feedback.jsx'
import { actorTypeLabel, AUDIT_ACTION_LABELS, auditActionLabel } from '../../shared/labels.js'
import { formatDayRange as rangeText, localDayBoundary, localDayOf } from '../../shared/presentation.js'
import { auditPage, readFilters, filterQuery, changeFilters, uuid, pageKey } from './adapters.js'
import { queryPath, useOperationsRead } from './api.js'

export function AuditPage() {
  const { principal, generation } = useSession()
  if (!can(principal, 'audit.read.own')) return <ErrorState error={new ApiError(403)} />
  return <AuditWorkspace key={generation} principal={principal} />
}
const withoutCursor = ({ cursor, ...rest }) => rest
const actionOptions = (current) => {
  const known = Object.entries(AUDIT_ACTION_LABELS).map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label, 'es'))
  return [{ value: '', label: 'Todas' }, ...(current && !Object.hasOwn(AUDIT_ACTION_LABELS, current) ? [{ value: current, label: current }] : []), ...known]
}
// Resumen humano de cada evento con todos los campos de RF-079 conservados en el detalle de la fila; los
// identificadores se pueden copiar y la correlación filtra los eventos de la misma operación.
const Identifier = ({ value, label }) => value ? <><span>{value}</span> <CopyButton value={value} label={label} /></> : '—'
function AuditDetail({ row, onCorrelation }) {
  return <TechnicalDetails summary="Ver"><dl>
    <dt>Acción</dt><dd className="mono">{row.action}</dd><dt>Resultado</dt><dd className="mono">{row.result}</dd>
    <dt>Tipo de actor</dt><dd className="mono">{row.actor_type}</dd><dt>Tipo de recurso</dt><dd className="mono">{row.resource_type}</dd>
    <dt>Recurso</dt><dd className="mono"><Identifier value={row.resource_identifier} label="Copiar recurso" /></dd><dt>Causa segura</dt><dd className="mono">{row.safe_cause_code ?? '—'}</dd>
    <dt>Operación</dt><dd className="mono"><Identifier value={row.operation_id} label="Copiar operación" /></dd><dt>Correlación</dt><dd className="mono"><Identifier value={row.correlation_id} label="Copiar correlación" /></dd>
    {row.resources.length > 0 && <><dt>Referencias</dt><dd className="mono"><ul>{row.resources.map((item, index) => <li key={index}>{item.resource_type}: {item.resource_identifier}{item.id_documento && ` · ${item.id_documento}`}{item.fragment_id && ` · ${item.fragment_id}`}</li>)}</ul></dd></>}
  </dl>{onCorrelation && <Button variant="secondary" className="mt-3 h-8" onClick={() => onCorrelation(row.correlation_id)}>Ver eventos de esta operación</Button>}</TechnicalDetails>
}
function AuditWorkspace({ principal }) {
  const [params, setParams] = useSearchParams(); const filters = readFilters(params.toString(), 'audit')
  const [error, setError] = useState(null); const resource = useOperationsRead(queryPath('audit', filters), auditPage)
  // Filtros automáticos (DESIGN §19): sin botón «Aplicar»; cambiar un filtro vuelve a la primera página.
  function change(patch) { try { setParams(filterQuery(changeFilters(filters, patch), 'audit')); setError(null) } catch (cause) { setError(cause) } }
  const schedule = useDebouncedCallback(change, 250)
  // Clave canónica (incluye el límite por defecto) para que pasar de página no reinicie el historial.
  const pages = useCursorHistory(pageKey(withoutCursor(filters), 'audit'))
  const from = localDayOf(filters.occurred_from); const to = localDayOf(filters.occurred_to)
  const chips = [
    ...(from || to ? [{ id: 'range', label: `Fecha: ${rangeText(from, to)}`, onRemove: () => change({ occurred_from: '', occurred_to: '' }) }] : []),
    ...(filters.action ? [{ id: 'action', label: `Evento: ${auditActionLabel(filters.action)}`, onRemove: () => change({ action: '' }) }] : []),
    ...(filters.resource_type ? [{ id: 'resource', label: `Recurso: ${filters.resource_type}`, onRemove: () => change({ resource_type: '' }) }] : []),
    ...(filters.correlation_id ? [{ id: 'correlation', label: `Correlación: ${filters.correlation_id.slice(0, 8)}…`, onRemove: () => change({ correlation_id: '' }) }] : []),
  ]
  const secondaryActive = (filters.resource_type ? 1 : 0) + (filters.correlation_id ? 1 : 0)
  return <>
    <PageHeader title="Auditoría" description={can(principal, 'audit.read.all') ? 'Bitácora de eventos del sistema. Solo lectura.' : 'Tus eventos de ingesta y cuarentena. Solo lectura.'} actions={<RefreshButton onClick={resource.reload} />} />
    <FilterToolbar label="Filtros de auditoría" chips={chips} onClearAll={() => change({ occurred_from: '', occurred_to: '', action: '', resource_type: '', correlation_id: '' })} secondaryActive={secondaryActive}
      primary={<>
        <DateRangeFields quick from={from} to={to} onChange={(range) => change({ occurred_from: localDayBoundary(range.from), occurred_to: localDayBoundary(range.to, { end: true }) })} />
        <Select label="Evento" value={filters.action || ''} options={actionOptions(filters.action)} onChange={(event) => schedule({ action: event.target.value })} />
      </>}
      secondary={<>
        <SearchField label="Tipo de recurso" value={filters.resource_type || ''} maxLength={128} onApply={(value) => change({ resource_type: value })} />
        <SearchField label="Correlación (identificador)" value={filters.correlation_id || ''} validate={uuid} invalidMessage="Pega el identificador completo (36 caracteres, p. ej. 1a2b3c4d-…)." onApply={(value) => change({ correlation_id: value })} />
      </>} />
    {error && <ErrorState error={error} />}
    <ResourceState resource={resource} context="la auditoría" skeleton="table" empty={{ title: 'Sin eventos para estos filtros', message: 'Prueba con otro rango de fechas o retira algún filtro.' }}>{(data) => <div className="space-y-4"><ResultsSummary count={data.items.length} hasMore={Boolean(data.next_cursor)} noun={['evento', 'eventos']} /><DataTable caption="Eventos de auditoría" rows={data.items} columns={[
      { key: 'occurredLabel', label: 'Fecha y hora', render: (row) => <span className="whitespace-nowrap font-mono text-xs">{row.occurredLabel}</span> },
      { key: 'actor_identifier', label: 'Actor', render: (row) => <span>{row.actor_identifier}{row.actor_type !== 'HUMAN' && <span className="block text-xs text-muted">{actorTypeLabel(row.actor_type)}</span>}</span> },
      { key: 'action', label: 'Evento', render: (row) => auditActionLabel(row.action) },
      { key: 'result', label: 'Resultado', render: (row) => <StatusBadge kind="audit" value={row.result} /> },
      { key: 'detail', label: 'Detalle', fit: true, render: (row) => <AuditDetail row={row} onCorrelation={filters.correlation_id === row.correlation_id ? null : (value) => change({ correlation_id: value })} /> },
    ]} /><CursorPager hasNext={Boolean(data.next_cursor)} hasPrevious={pages.canGoBack} atDeepLink={Boolean(filters.cursor) && !pages.canGoBack}
      onNext={() => { pages.push(filters.cursor); setParams(filterQuery({ ...filters, cursor: data.next_cursor }, 'audit')) }}
      onPrevious={() => { const previous = pages.pop(); setParams(filterQuery(previous ? { ...withoutCursor(filters), cursor: previous } : withoutCursor(filters), 'audit')) }}
      onFirst={() => setParams(filterQuery(withoutCursor(filters), 'audit'))}>
      <div className="filter-row"><Select label="Filas por página" value={filters.limit || '25'} options={['25', '50', '100'].map((value) => ({ value, label: value }))} onChange={(event) => change({ limit: event.target.value })} /></div>
    </CursorPager></div>}</ResourceState>
  </>
}

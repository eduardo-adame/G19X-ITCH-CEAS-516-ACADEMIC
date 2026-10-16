import React, { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useSession } from '../../auth/SessionProvider.jsx'
import { can } from '../../auth/permissions.js'
import { useResource } from '../../api/useResource.js'
import { ApiError } from '../../api/errors.js'
import { PageHeader } from '../../components/layout.jsx'
import { Button, FilterBar, Input, Select } from '../../components/controls.jsx'
import { Badge, DataTable, KpiMetric, KpiRow, RiskBadge, TechnicalDetails } from '../../components/data.jsx'
import { EmptyState, ErrorState, ResourceState } from '../../components/feedback.jsx'
import { Icon } from '../../components/Icon.jsx'
import { validDate } from '../../shared/formatters.js'
import { formatAuditTimestamp, formatMonth, formatPeriodRange, formatQuantity, formatUserTimestamp } from '../../shared/presentation.js'
import { writeQuery } from '../../shared/query.js'
import { analyticsFilters, analyticsPaths, FILTER_VALIDATORS, PERIODS, RISKS } from './api.js'
import { adaptAnalysis, adaptKpis, alertCountLabel, KPI_CATALOG, ruleLabel } from './adapters.js'
import { AlertsSkeleton, ChartLoadingState, ExposureEvolutionChart, IncidentsByAreaChart, LitigationExposureChart, MatterVolumeTable, ObservationTable, SeverityChart, TemporalChart } from './charts.jsx'
import { matterVolumePivot } from './viewModels.js'
import { resolveDomainKpis, resolveExecutiveKpis } from './executiveKpis.js'
import { describeFinding, evaluatedMonth } from './findingNarrative.js'

const configs = {
  summary: { title: 'Resumen ejecutivo', risk: 'all', description: 'Estado del riesgo legal y alertas del periodo.' },
  contracts: { title: 'Riesgo contractual', risk: 'contractual', description: 'Contratos que requieren revisión y tiempo de formalización.' },
  litigation: { title: 'Gestión de litigios', risk: 'litigation', description: 'Exposición por litigios activos y nuevos litigios.' },
  trends: { title: 'Tendencias y riesgos', risk: 'all', description: 'Alertas detectadas al comparar cada indicador con meses anteriores.' },
}
// Vista de dominio de cada indicador, para navegar desde una alerta.
const DOMAIN_ROUTES = Object.freeze({ 'KPI-RC-03': '/contratos', 'KPI-RC-01': '/contratos', 'KPI-LI-01': '/litigios', 'KPI-LI-05': '/litigios' })
const RISK_NOUNS = Object.freeze({ contractual: 'riesgo contractual', litigation: 'riesgo de litigio', compliance: 'riesgo de cumplimiento normativo' })

function ValidatedResource({ resource, adapt, children, loading, context }) {
  if (resource.state === 'loading') return loading || <ChartLoadingState />
  return <ResourceState resource={resource} context={context}>{(data) => {
    try { return children(adapt(data)) } catch { return <ErrorState error={new ApiError(503)} onRetry={resource.reload} context={context} /> }
  }}</ResourceState>
}

// Los selectores se aplican al cambiar (RF-074); el rango personalizado espera a tener ambas fechas.
function Filters({ filters, entities, setParams, showAnalysis }) {
  const [draft, setDraft] = useState({ ...filters.raw, period: filters.period, risk_type: filters.risk_type, mode: filters.analysisMode })
  const [error, setError] = useState(false)
  useEffect(() => { setDraft({ ...filters.raw, period: filters.period, risk_type: filters.risk_type, mode: filters.analysisMode }); setError(false) }, [filters.canonical, filters.risk_type])
  function apply(values) {
    if (values.period === 'custom' && (!validDate(values.period_start) || !validDate(values.period_end) || values.period_start > values.period_end)) { setError(true); return }
    const next = { risk_type: values.risk_type, entity: values.entity, period: values.period, ...(showAnalysis ? { analysis_mode: values.mode } : {}) }
    if (showAnalysis && values.mode === 'historical') next.analytic_run_id = values.analytic_run_id
    if (values.period === 'custom') { next.period_start = values.period_start; next.period_end = values.period_end }
    setError(false); setParams(writeQuery(next, FILTER_VALIDATORS))
  }
  const choose = (key) => (event) => {
    const values = { ...draft, [key]: event.target.value }
    setDraft(values)
    if (values.period !== 'custom') apply(values)
  }
  const type = (key) => (event) => setDraft((value) => ({ ...value, [key]: event.target.value }))
  return <form onSubmit={(event) => { event.preventDefault(); apply(draft) }}><FilterBar>
    {showAnalysis && <Select label="Análisis" value={draft.mode} onChange={choose('mode')} options={[{ value: 'current', label: 'Vigente' }, { value: 'historical', label: 'Histórico' }]} />}
    <Select label="Periodo" value={draft.period} onChange={choose('period')} options={PERIODS} />
    <Select label="Tipo de riesgo" value={draft.risk_type} onChange={choose('risk_type')} options={RISKS} />
    {entities.length
      ? <Select label="Entidad" value={draft.entity || ''} onChange={choose('entity')} options={[{ value: '', label: 'Todas las aplicables' }, ...entities.map((value) => ({ value, label: value }))]} />
      : <p className="self-end pb-2 text-xs text-secondary" data-testid="entity-not-applicable">Entidad: No aplicable</p>}
    {draft.entity && !entities.includes(draft.entity) && <p className="text-xs text-secondary">Entidad seleccionada: {draft.entity}. Sin opciones disponibles en esta lectura.</p>}
    {draft.period === 'custom' && <><Input compact label="Desde" type="date" value={draft.period_start || ''} onChange={type('period_start')} /><Input compact label="Hasta" type="date" value={draft.period_end || ''} onChange={type('period_end')} /><Button type="submit" variant="secondary">Aplicar rango</Button></>}
    {showAnalysis && draft.analytic_run_id && draft.mode === 'historical' && <Button variant="ghost" onClick={() => apply({ ...draft, analytic_run_id: undefined })}>Quitar selección de ejecución</Button>}
  </FilterBar>{error && <p role="alert" className="mt-2 text-xs text-[var(--critical)]">El rango personalizado requiere fechas válidas y ordenadas.</p>}</form>
}

// Dónde se lee hoy el desglose de un KPI dimensional (las tarjetas no suman en el frontend, D-UX-7).
const DIMENSIONAL_HINTS = Object.freeze({ 'KPI-LI-01': 'Desglose por severidad en gráfica y tabla', 'KPI-CN-03': 'Ver «Incidentes por área»' })
const attentionKey = (code, month) => `${code}|${month}`
function attentionFor(slot, attention) {
  const month = slot.rows?.[0]?.period_start?.slice(0, 7)
  return Boolean(month && attention.has(attentionKey(slot.code, month)))
}
function slotDelta(slot, attention) {
  if (attentionFor(slot, attention)) return <span className="inline-flex items-center gap-1 font-medium text-[var(--warning)]"><Icon name="warning" size={12} />Requiere atención</span>
  if (slot.dimensional) return <span className="truncate text-muted">{DIMENSIONAL_HINTS[slot.code] || 'Desglose en la tabla de datos'}</span>
  return <span className="text-muted" />
}

function MetricSlots({ slots, enter = false, attention }) {
  return <section aria-label="Indicadores principales"><KpiRow>{slots.map((slot, index) => <KpiMetric key={slot.code} label={slot.name} displayValue={slot.displayValue} accessibleValue={slot.accessibleValue} valueKind={slot.valueKind} state={slot.state} entryIndex={enter ? index : undefined} shortContext={slot.shortContext} previousContext={slot.previousContext} delta={slotDelta(slot, attention)} />)}</KpiRow></section>
}

function DomainMetricGroup({ data, view, riskType, attention }) {
  const slots = resolveDomainKpis({ view, items: data.items, riskType }).filter((slot) => slot.state !== 'NOT_APPLICABLE')
  return <MetricSlots slots={slots} attention={attention} />
}

function ExecutiveMetricGroup({ data, riskType, entryIdentity, entryLedger, attention }) {
  // La decisión permanece estable durante el montaje; el refetch conserva el registro del padre.
  const [enter] = useState(() => entryLedger.current !== entryIdentity)
  useEffect(() => { entryLedger.current = entryIdentity }, [entryIdentity, entryLedger])
  const slots = resolveExecutiveKpis({ items: data.items, riskType }).filter((slot) => slot.state !== 'NOT_APPLICABLE')
  return <MetricSlots slots={slots} enter={enter} attention={attention} />
}

// Hallazgo humanizado (DESIGN §16.1): titular y frase desde campos estructurados; texto registrado, regla,
// periodo exacto y fecha de generación en el Detalle técnico.
function HumanizedFinding({ finding, evaluations, principal }) {
  const view = describeFinding(finding, evaluations)
  const risk = finding.severity ? { alto: 'Alto', medio: 'Medio', bajo: 'Bajo' }[finding.severity] : null
  const domain = DOMAIN_ROUTES[finding.kpi_code]
  return <article className="space-y-4 rounded-panel border border-border bg-surface p-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0 space-y-1"><p className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--warning)]"><Icon name="warning" size={12} />Requiere atención</p><h3 className="text-sm font-semibold">{view.title}</h3><p className="text-xs text-secondary">{[view.name, view.scope].filter(Boolean).join(' · ')}</p></div>{risk && <RiskBadge level={risk} />}</div>
    {view.sentence && <p className="text-[13px] leading-relaxed">{view.sentence}</p>}
    <dl className="grid grid-cols-2 gap-3 rounded-control bg-secondary p-3 text-xs sm:grid-cols-4"><div><dt className="text-muted">Mes evaluado</dt><dd className="mt-0.5 font-medium">{view.monthText}</dd></div><div><dt className="text-muted">Actual</dt><dd className="mt-0.5 font-mono tabular-nums">{view.values.current}</dd></div><div><dt className="text-muted">Referencia del análisis</dt><dd className="mt-0.5 font-mono tabular-nums">{view.values.reference}</dd></div><div><dt className="text-muted">Variación</dt><dd className="mt-0.5 font-mono font-semibold tabular-nums">{view.values.variation}</dd></div></dl>
    {view.recurrence && <p className="text-xs text-secondary">{view.recurrence}</p>}
    <div className="flex flex-wrap items-center gap-4 text-xs">{domain && <Link className="font-medium underline" to={`${domain}?${new URLSearchParams({ period: 'custom', period_start: finding.period_start, period_end: finding.period_end, analysis_mode: 'current' })}`}>Ver indicador</Link>}{finding.contextReferenceId && can(principal, 'document.query') && <Link className="font-medium underline" to={`/consulta?context_reference_id=${encodeURIComponent(finding.contextReferenceId)}`} state={{ contextLabel: `${view.name} — ${view.monthText}` }}>Verificar evidencia documental</Link>}</div>
    <TechnicalDetails><dl>
      <dt>Texto registrado</dt><dd>{finding.description}</dd>
      <dt>Regla aplicada</dt><dd>{finding.ruleText} <span className="mono">({finding.triggered_rule})</span></dd>
      <dt>Periodo analizado</dt><dd>{formatPeriodRange(finding.period_start, finding.period_end)}</dd>
      {finding.recurrent_pattern && !view.recurrence && <><dt>Patrón recurrente registrado</dt><dd className="mono">{finding.recurrent_pattern}</dd></>}
      <dt>Generado</dt><dd className="mono">{formatAuditTimestamp(finding.created_at)}</dd>
    </dl></TechnicalDetails>
  </article>
}

// Sin hallazgos: con filtro de riesgo no se afirma nada sobre la ejecución completa (UX-052).
function NoFindings({ riskType }) {
  if (riskType && riskType !== 'all') return <EmptyState title={`Sin alertas de ${RISK_NOUNS[riskType] || 'este tipo de riesgo'} en el análisis`} message="Las alertas de otros tipos de riesgo se consultan en el Resumen ejecutivo." action={<Link className="text-xs font-medium underline" to="/">Ver todas las alertas</Link>} />
  return <EmptyState title="Sin alertas en el análisis" message="El análisis no generó alertas con las reglas y el historial disponibles." />
}

function evaluationResult(row) {
  if (row.outcome === 'INSUFFICIENT_HISTORY') return 'Historial insuficiente'
  if (row.signal_detected) return row.recurrence_month_count >= 3 ? `Requiere atención · ${row.recurrence_month_count} de 4 meses` : 'Requiere atención'
  return 'Sin alerta'
}

// Detalle del análisis visible: ejecución, ventana y evaluaciones por indicador. El texto registrado por el
// análisis se conserva sin modificar solo en «Detalle técnico» (D-UX-1): puede venir en formato antiguo.
function AnalysisRunDetail({ run }) {
  return <div className="space-y-4 rounded-panel border border-border bg-surface p-5">
    <dl className="grid grid-cols-1 gap-3 text-xs sm:grid-cols-3"><div><dt className="text-muted">Ejecución</dt><dd className="mt-0.5">{formatUserTimestamp(run.completed_at)}</dd></div><div><dt className="text-muted">Ventana de datos</dt><dd className="mt-0.5">{formatPeriodRange(run.window_start.slice(0, 10), run.window_end.slice(0, 10))}</dd></div></dl>
    <DataTable caption="Evaluaciones del análisis" rows={run.evaluations} columns={[
      { key: 'name', label: 'Indicador' },
      ...(run.evaluations.some((row) => row.dimensionsText) ? [{ key: 'dimensionsText', label: 'Ámbito', render: (row) => row.dimensionsText || '—' }] : []),
      { key: 'evaluation_period', label: 'Mes', render: (row) => formatMonth(row.evaluation_period) },
      { key: 'currentText', label: 'Actual', numeric: true, render: (row) => formatQuantity(row.current_value, row.unit) },
      { key: 'referenceText', label: 'Referencia', numeric: true, render: (row) => formatQuantity(row.reference_value, row.unit) },
      { key: 'absoluteText', label: 'Variación', numeric: true, render: (row) => formatQuantity(row.absolute_variation, row.unit, { signed: true }) },
      { key: 'result', label: 'Resultado', render: evaluationResult },
      { key: 'rules_applied', label: 'Reglas', render: (row) => row.rules_applied.map(ruleLabel).join(' · ') },
    ]} />
    <TechnicalDetails><dl><dt>Ejecución</dt><dd className="mono">{formatAuditTimestamp(run.completed_at)}</dd><dt>Ventana de datos</dt><dd className="mono">{formatAuditTimestamp(run.window_start)} – {formatAuditTimestamp(run.window_end)}</dd><dt>Texto registrado</dt><dd className="whitespace-pre-wrap">{run.executive_summary}</dd></dl></TechnicalDetails>
  </div>
}
function AnalysisEvaluations({ data }) {
  if (!data.items.length) return null
  return <section className="space-y-3" aria-label="Evaluaciones del análisis"><SectionTitle>Evaluaciones del análisis</SectionTitle><p className="text-xs text-secondary">Comparación de cada indicador con meses anteriores en el último análisis completado.</p>{data.items.map((run) => <AnalysisRunDetail key={run.analytic_run_id} run={run} />)}</section>
}

function AnalysisContent({ data, mode, principal, selectRun, riskType, heading, showDetail = true }) {
  return <section className="space-y-5" aria-label="Análisis persistido">
    <div className="flex flex-wrap items-center gap-3"><h2 className="text-base font-semibold">{heading || (mode === 'current' ? 'Análisis vigente' : 'Análisis histórico')}</h2><Badge variant={data.alert_count ? 'warning' : 'neutral'}>{alertCountLabel(data.alert_count)}</Badge></div>
    <p className="text-xs text-secondary">Las alertas se generan automáticamente al comparar cada indicador con meses anteriores. No son predicciones ni asesoría jurídica.</p>
    {!data.items.length && <EmptyState title="Sin análisis completados" message="Aún no hay un análisis completado para esta selección." />}
    {data.items.map((run) => <section key={run.analytic_run_id} className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-secondary"><p>Análisis del {formatUserTimestamp(run.completed_at)} · {alertCountLabel(run.findings.length)}</p>{mode === 'historical' && <Button variant="ghost" onClick={() => selectRun(run.analytic_run_id)}>Seleccionar ejecución</Button>}</div>
      {run.findings.length ? <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">{run.findings.map((finding) => <HumanizedFinding key={finding.id} finding={finding} evaluations={run.evaluations} principal={principal} />)}</div> : <NoFindings riskType={riskType} />}
      {showDetail && <AnalysisRunDetail run={run} />}
    </section>)}
  </section>
}

// Datos visibles sin desplegables (DESIGN §16.9); el contexto se filtra por dominio.
const DOMAIN_CONTEXT = Object.freeze({
  contracts: (row) => row.kpi_code === 'KPI-RC-01' || (row.kpi_code === 'KPI-EO-01' && row.dimensions.tipo_asunto === 'Contrato'),
  litigation: (row) => row.kpi_code === 'KPI-EO-01' && row.dimensions.tipo_asunto === 'Litigio',
})
function ObservationSections({ data, view }) {
  const core = data.items.filter((row) => KPI_CATALOG[row.kpi_code].core)
  const context = data.items.filter((row) => !KPI_CATALOG[row.kpi_code].core && (DOMAIN_CONTEXT[view] ? DOMAIN_CONTEXT[view](row) : true))
  // La tabla Tipo × Estado sustituye a las filas de volumen de su mismo periodo; el resto se lista debajo.
  const pivot = matterVolumePivot(context)
  const rest = pivot ? context.filter((row) => !(row.kpi_code === 'KPI-EO-01' && row.period_start === pivot.periodStart)) : context
  return <>
    <section className="space-y-3" aria-label="Datos de los indicadores"><SectionTitle>Datos de los indicadores ({core.length})</SectionTitle><ObservationTable items={core} /></section>
    {context.length > 0 && <section className="space-y-3" aria-label="Contexto operativo"><SectionTitle>Contexto operativo</SectionTitle><p className="text-xs text-secondary">Indicadores complementarios: dan contexto y no generan alertas.</p><MatterVolumeTable model={pivot} />{rest.length > 0 && <ObservationTable items={rest} caption="Datos del contexto operativo" />}</section>}
  </>
}

// Regla de los indicadores contractuales en lenguaje llano (SRS RF-031 y RF-030).
function ContractDefinitions() {
  return <dl className="grid grid-cols-1 gap-3 rounded-control bg-secondary p-4 text-xs sm:grid-cols-2" aria-label="Cómo se calculan los indicadores contractuales">
    <div><dt className="font-medium">Contratos próximos a vencimiento sin revisión</dt><dd className="mt-1 text-secondary">Contratos cuya revisión no ha iniciado y que vencen entre hoy y los próximos 60 días.</dd></div>
    <div><dt className="font-medium">Tiempo de ciclo del contrato</dt><dd className="mt-1 text-secondary">Promedio de días entre la solicitud y la firma, para contratos con ambas fechas válidas.</dd></div>
  </dl>
}

function SectionTitle({ children }) { return <h2 className="text-base font-semibold">{children}</h2> }

// Ventana propia de la sección Evolución (DESIGN §16.9): la consulta la calcula el backend con los mismos
// filtros de riesgo y entidad; el selector «Periodo» solo gobierna los indicadores.
export const EVOLUTION_WINDOWS = Object.freeze([{ value: 'last_6_months', label: '6 meses' }, { value: 'last_12_months', label: '12 meses' }])
function EvolutionSection({ resource, window, onWindow, children }) {
  let range = null
  if (resource.state === 'success' && validDate(resource.data?.period_start) && validDate(resource.data?.period_end)) range = formatPeriodRange(resource.data.period_start, resource.data.period_end)
  return <section className="space-y-4" aria-label="Evolución">
    <div className="flex flex-wrap items-end justify-between gap-3"><div className="space-y-1"><SectionTitle>Evolución</SectionTitle><p className="h-4 text-xs text-secondary">{range ? `Meses cerrados: ${range}` : resource.state === 'loading' ? 'Cargando la evolución…' : ''}</p></div>
      <div role="group" aria-label="Ventana de la evolución" className="inline-flex rounded-control border border-border bg-surface p-0.5">{EVOLUTION_WINDOWS.map((item) => <button key={item.value} type="button" aria-pressed={window === item.value} onClick={() => onWindow(item.value)} className={`rounded-[calc(var(--radius-small)-2px)] px-3 py-1.5 text-xs ${window === item.value ? 'bg-[var(--background-selected)] font-medium text-primary' : 'text-secondary hover:text-primary'}`}>Últimos {item.label}</button>)}</div></div>
    <ValidatedResource resource={resource} adapt={adaptKpis} context="la evolución" loading={<div aria-hidden="true" className="h-[360px] rounded-panel border border-border bg-surface p-5"><div className="skeleton h-3 w-1/3" /><div className="skeleton mt-6 h-[260px] w-full opacity-60" /></div>}>{children}</ValidatedResource>
  </section>
}

function KpiVisuals({ data, view, riskType, entryIdentity, entryLedger, attention, alerts, evolution }) {
  if (view === 'summary') return <>
    <ExecutiveMetricGroup key={entryIdentity} data={data} riskType={riskType} entryIdentity={entryIdentity} entryLedger={entryLedger} attention={attention} />
    {alerts}
    <section className="space-y-4" aria-label="Dónde se concentra"><SectionTitle>Dónde se concentra</SectionTitle><div className="grid grid-cols-1 gap-8 xl:grid-cols-2"><div className="min-w-0"><SeverityChart items={data.items} /></div><div className="min-w-0"><IncidentsByAreaChart items={data.items} /></div></div></section>
    {evolution}
  </>
  if (view === 'contracts') return <>
    <DomainMetricGroup data={data} view={view} riskType={riskType} attention={attention} />
    <ContractDefinitions />
    {alerts}
    {evolution}
  </>
  if (view === 'litigation') return <>
    <DomainMetricGroup data={data} view={view} riskType={riskType} attention={attention} />
    {alerts}
    <SeverityChart items={data.items} />
    {evolution}
  </>
  return null
}
// Gráficas de evolución por vista sobre la ventana propia de la sección.
function evolutionCharts(view, items, historyAction) {
  if (view === 'summary') return <ExposureEvolutionChart items={items} historyAction={historyAction} />
  if (view === 'contracts') return <TemporalChart items={items} kpiCode="KPI-RC-01" title="Tiempo de ciclo del contrato" subtitle="Días promedio entre la solicitud y la firma, por mes. No se completan meses sin datos." unit="días" emptyMessage="No existen observaciones contractuales para los filtros seleccionados." historyAction={historyAction} />
  return <div className="space-y-8"><LitigationExposureChart items={items} historyAction={historyAction} /><TemporalChart items={items} kpiCode="KPI-LI-05" title="Nuevos litigios por periodo" subtitle="Litigios abiertos en cada mes. No se completan meses sin datos." unit="litigios" emptyMessage="Aún no existen observaciones para los filtros seleccionados." historyAction={historyAction} /></div>
}

// Alertas del análisis por indicador y mes evaluado, para señalar la tarjeta del mismo mes.
function attentionSet(analysisData) {
  const keys = new Set()
  if (!analysisData) return keys
  try {
    for (const run of adaptAnalysis(analysisData).items) for (const finding of run.findings) keys.add(attentionKey(finding.kpi_code, evaluatedMonth(finding, run.evaluations)))
  } catch { /* El bloque de análisis informa el contrato inválido; las tarjetas no muestran señal. */ }
  return keys
}

function latestCalculation(kpisData) {
  try { return adaptKpis(kpisData).items.reduce((latest, row) => !latest || row.calculated_at > latest ? row.calculated_at : latest, null) } catch { return null }
}


export function AnalyticsPage({ view = 'summary' }) {
  const config = configs[view]
  const [params, setParams] = useSearchParams(); const { principal } = useSession()
  const trends = view === 'trends'
  const parsed = analyticsFilters(params.toString(), config.risk, trends ? 'last_6_months' : 'current_month')
  // Fuera de Tendencias las alertas son siempre las del último análisis completado (DESIGN §16.7).
  const filters = trends ? parsed : { ...parsed, analysisMode: 'current', raw: { ...parsed.raw, analytic_run_id: undefined } }
  const paths = analyticsPaths(filters)
  const entryLedger = useRef(null)
  const entryIdentity = `${view}:${paths.kpis}`
  useEffect(() => { if (view !== 'summary') entryLedger.current = null }, [view])
  const kpis = useResource(trends ? null : paths.kpis); const analysis = useResource(paths.analysis)
  const [evolutionWindow, setEvolutionWindow] = useState('last_6_months')
  const evolutionPath = analyticsPaths({ ...filters, period: evolutionWindow }).kpis
  // Si la selección coincide con la ventana de evolución se reutiliza la misma lectura.
  const sameEvolution = evolutionPath === paths.kpis
  const evolutionRead = useResource(trends || sameEvolution ? null : evolutionPath)
  const evolutionResource = sameEvolution ? kpis : evolutionRead
  const [corrected, setCorrected] = useState(false)
  useEffect(() => { if (parsed.corrected) { setCorrected(true); setParams(parsed.canonical, { replace: true }) } }, [parsed.canonical, parsed.corrected, setParams])
  let entities = []
  let kpisValid = false
  try { if (kpis.data) { entities = [...new Set(adaptKpis(kpis.data).items.filter((row) => row.entity_filter_applicable && typeof row.dimensions.entity === 'string').map((row) => row.dimensions.entity))].sort(); kpisValid = kpis.state === 'success' } } catch { /* El estado de lectura informa el contrato inválido sin exponer el payload. */ }
  const attention = attentionSet(analysis.data)
  const changeRun = (id) => setParams(writeQuery({ ...filters.raw, analytic_run_id: id }, FILTER_VALIDATORS))
  const requestPeriod = (period) => setParams(writeQuery({ ...filters.raw, period, period_start: undefined, period_end: undefined, analytic_run_id: undefined, analysis_mode: undefined }, FILTER_VALIDATORS))
  // Con historia insuficiente en 6 meses, la propia gráfica ofrece ampliar la ventana a 12.
  const historyAction = evolutionWindow === 'last_6_months' ? { label: 'Ver últimos 12 meses', onClick: () => setEvolutionWindow('last_12_months') } : null
  // Evaluaciones visibles al final de las vistas de dominio; en Tendencias van dentro de cada ejecución.
  const evaluationsBlock = trends || analysis.state !== 'success' ? null : <ValidatedResource resource={analysis} adapt={adaptAnalysis} context="el análisis">{(data) => <AnalysisEvaluations data={data} />}</ValidatedResource>
  const evolutionBlock = trends ? null : <EvolutionSection resource={evolutionResource} window={evolutionWindow} onWindow={setEvolutionWindow}>{(data) => evolutionCharts(view, data.items, historyAction)}</EvolutionSection>
  const filterBlock = <div className="space-y-3"><Filters filters={filters} entities={entities} setParams={setParams} showAnalysis={trends} /><p className="text-xs text-secondary">{!trends ? 'Las alertas corresponden al último análisis completado; el periodo solo cambia los indicadores.' : filters.analysisMode === 'current' ? 'Se muestran las alertas del último análisis completado.' : 'Se muestran los análisis completados dentro del periodo seleccionado.'}</p>{filters.period !== 'current_month' && !trends && <div className="flex flex-wrap items-center gap-3"><p className="text-xs text-secondary">Este rango incluye solo meses cerrados.</p><Button variant="secondary" onClick={() => requestPeriod('current_month')}>Ver periodo en curso</Button></div>}</div>
  const analysisBlock = <ValidatedResource resource={analysis} adapt={adaptAnalysis} context="el análisis" loading={<AlertsSkeleton />}>{(data) => <AnalysisContent data={data} mode={filters.analysisMode} principal={principal} selectRun={changeRun} riskType={filters.risk_type} heading={trends ? null : 'Requiere atención'} showDetail={trends} />}</ValidatedResource>
  const loadingSlots = trends ? undefined : (view === 'summary' ? resolveExecutiveKpis : resolveDomainKpis)({ view, riskType: filters.risk_type, resourceState: 'LOADING' }).filter((slot) => slot.state !== 'NOT_APPLICABLE')
  const updated = kpis.data ? latestCalculation(kpis.data) : null
  const periodLabel = kpis.state === 'loading' ? 'Cargando periodo de indicadores…' : kpis.error ? 'Periodo de indicadores no disponible.' : validDate(kpis.data?.period_start) && validDate(kpis.data?.period_end) ? `Periodo de los indicadores: ${formatPeriodRange(kpis.data.period_start, kpis.data.period_end)}${updated ? ` · Actualizado el ${formatUserTimestamp(updated)}` : ''}` : 'Sin periodo completo disponible para esta selección.'
  // Las alertas se insertan bajo los KPI cuando los indicadores son legibles; si no, siguen al bloque de lectura.
  // Mientras cargan los KPI, el bloque de alertas ya ocupa su posición final (sin saltos al llegar los datos).
  const alertsInside = can(principal, 'dashboard.read') && (kpisValid || kpis.state === 'loading')
  // El rango tiene el mismo espacio al cargar y al recibir la API para que
  // las métricas no se desplacen al sustituir los skeletons por resultados.
  const kpiBlock = !can(principal, 'dashboard.read') ? <ErrorState error={new ApiError(403)} /> : <div className="space-y-8"><p className="h-9 text-xs leading-[18px] text-secondary">{periodLabel}</p><ValidatedResource resource={kpis} adapt={adaptKpis} context="los indicadores" loading={<ChartLoadingState label="Cargando…" charts={view === 'summary' || view === 'litigation' ? 2 : 1} showKpis kpiSlots={loadingSlots} beforeAlerts={view === 'contracts' ? <ContractDefinitions /> : null} alerts={alertsInside ? analysisBlock : null} />}>{(data) => <div className="space-y-8"><KpiVisuals data={data} view={view} riskType={filters.risk_type} entryIdentity={entryIdentity} entryLedger={entryLedger} attention={attention} alerts={alertsInside ? analysisBlock : null} evolution={evolutionBlock} /><ObservationSections data={data} view={view} />{evaluationsBlock}</div>}</ValidatedResource></div>
  return <div className="space-y-8"><PageHeader title={config.title} description={config.description} />{corrected && <p role="status" className="text-xs text-secondary">Se retiraron filtros no válidos de la dirección.</p>}{filterBlock}{trends ? analysisBlock : <>{kpiBlock}{!alertsInside && analysisBlock}</>}</div>
}

export const SummaryPage = () => <AnalyticsPage view="summary" />
export const ContractsPage = () => <AnalyticsPage view="contracts" />
export const LitigationPage = () => <AnalyticsPage view="litigation" />
export const TrendsPage = () => <AnalyticsPage view="trends" />

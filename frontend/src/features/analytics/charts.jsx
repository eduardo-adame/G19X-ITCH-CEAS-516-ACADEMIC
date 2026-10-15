import React from 'react'
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { DataTable, KpiRow, KpiSkeleton, TechnicalDetails } from '../../components/data.jsx'
import { Button } from '../../components/controls.jsx'
import { formatAuditTimestamp, formatDocumentDate } from '../../shared/presentation.js'
import {
  exposureEvolutionViewModel,
  formatCompactCurrencyMXN,
  formatCount,
  formatDays,
  incidentsByAreaViewModel,
  SEVERITIES,
  litigationExposureViewModel,
  severityCompositionViewModel,
  temporalSeriesViewModel,
} from './viewModels.js'
import { AXIS_UNITS, chartAxisConfig, monthTick } from './chartAxes.js'
import { KPI_CATALOG } from './adapters.js'

const AXIS_TICK = Object.freeze({ fill: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 11 })
const axisProps = Object.freeze({ axisLine: { stroke: 'var(--border-default)' }, tickLine: false, tick: AXIS_TICK })

function monthDistance(value) {
  return Number(value.slice(0, 4)) * 12 + Number(value.slice(5, 7))
}

function segmentedLines(rows, dataKey) {
  let segment = 0
  let previous = null
  const data = rows.map((row) => {
    const month = monthDistance(row.month)
    if (row[dataKey] === undefined || row[dataKey] === null) return { ...row }
    if (previous !== null && month !== previous + 1) segment++
    previous = month
    return { ...row, [`${dataKey}${segment}`]: row[dataKey] }
  })
  return { data, keys: Array.from({ length: segment + 1 }, (_, index) => `${dataKey}${index}`) }
}

function mergeSegmented(baseRows, definitions) {
  let data = baseRows
  const keys = {}
  for (const definition of definitions) {
    const result = segmentedLines(baseRows, definition.key)
    data = data.map((row, index) => ({ ...row, ...result.data[index] }))
    keys[definition.key] = result.keys
  }
  return { data, keys }
}

function TooltipSurface({ title, rows }) {
  return <div className="min-w-[160px] rounded-control border border-border bg-surface p-3 text-xs shadow-subtle"><p className="mb-2 font-medium text-primary">{title}</p><dl className="space-y-1">{rows.map((row) => <div key={row.label} className="flex items-center justify-between gap-4"><dt className="text-secondary">{row.label}</dt><dd className="font-mono tabular-nums text-primary">{row.value}</dd></div>)}</dl></div>
}

function SeriesTooltip({ active, payload, series, valueText = (row, key) => row[`${key}Text`] || 'No disponible' }) {
  const row = payload?.find((item) => item.payload)?.payload
  if (!active || !row) return null
  const visible = series.filter(({ key }) => row[key] !== undefined && row[key] !== null)
  return <TooltipSurface title={row.periodText || row.month} rows={visible.map(({ key, label }) => ({ label, value: valueText(row, key) }))} />
}

export function TemporalTooltip({ active, payload, label, rows = [], unit }) {
  const row = payload?.find((item) => item.payload)?.payload || rows.find((item) => item.month === label)
  if (!active || !row) return null
  const value = row.availability === 'NO_OBSERVATION' ? 'Sin observación'
    : row.availability === 'NO_DISPONIBLE' ? 'No disponible'
      : unit === 'días' ? formatDays(row.rawValue) : formatCount(row.rawValue?.replace(/\.0+$/, ''), unit)
  return <TooltipSurface title={row.periodText || row.month} rows={[{ label: unit === 'días' ? 'Tiempo de ciclo' : 'Nuevos litigios', value }]} />
}

export function ExposureTooltip({ active, payload }) {
  const row = payload?.find((item) => item.payload)?.payload
  if (!active || !row) return null
  const values = SEVERITIES.filter(({ key }) => row[`${key}Availability`] !== undefined).map(({ key, label }) => ({ label, value: row[`${key}Text`] }))
  if (row.complete) values.unshift({ label: 'Total', value: row.totalText })
  if (row.contextKey && row.contextKey !== '[]') values.unshift({ label: 'Contexto', value: row.contextText })
  return <TooltipSurface title={row.periodText || row.month} rows={values.length ? values : [{ label: 'Disponibilidad', value: 'Sin observación' }]} />
}

function CompositionTooltip({ active, payload }) {
  const row = payload?.[0]?.payload
  if (!active || !row) return null
  return <TooltipSurface title={row.name} rows={[{ label: 'Importe', value: row.valueText }, { label: 'Porcentaje', value: row.percentageText }]} />
}

export function ChartLegend({ items }) {
  return <ul aria-label="Leyenda" className="flex flex-wrap gap-x-5 gap-y-2 text-xs">{items.map((item) => <li key={item.key} className="inline-flex items-center gap-2"><span aria-hidden="true" className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: item.color }} /><span className="text-secondary">{item.label}</span></li>)}</ul>
}

export function ChartContainer({ title, subtitle, footer, children, className = '' }) {
  return <figure className={`min-w-0 space-y-3 rounded-panel border border-border bg-surface p-5 ${className}`}><figcaption className="text-sm font-semibold">{title}</figcaption>{subtitle && <p className="text-xs text-secondary">{subtitle}</p>}{children}{footer}</figure>
}

export function EmptyChartState({ chartTitle = '', title = 'Sin datos disponibles', message = 'Aún no existen observaciones para los filtros seleccionados.', className = '' }) {
  const ariaLabel = chartTitle ? `${chartTitle}: ${title.toLowerCase()}` : title
  return <div role="region" aria-label={ariaLabel} className={`flex h-[260px] min-w-0 flex-col items-center justify-center rounded-panel border border-dashed border-border bg-secondary/30 p-6 text-center ${className}`}><p className="text-sm font-medium text-secondary">{title}</p>{message && <p className="mt-1 max-w-sm text-xs text-muted">{message}</p>}</div>
}

// Con un solo periodo con valor no se dibuja una «evolución»: se informa el periodo disponible y, si la
// selección lo permite, se ofrece ampliarla. La tabla de datos de la gráfica se conserva.
export function InsufficientHistoryState({ chartTitle, periodText, detail, action }) {
  return <div role="region" aria-label={`${chartTitle}: historia insuficiente`} className="flex min-w-0 flex-col items-start gap-2 rounded-panel border border-dashed border-border bg-secondary/30 p-5">
    <p className="text-sm font-medium text-secondary">Historia insuficiente para mostrar una evolución</p>
    <p className="text-xs text-muted">Solo hay datos de {periodText}{detail ? `: ${detail}` : ''}.</p>
    {action ? <Button variant="secondary" onClick={action.onClick}>{action.label}</Button> : <p className="text-xs text-muted">No hay más meses con datos dentro de la selección.</p>}
  </div>
}

export function ChartLoadingState({ label = 'Cargando…', charts = 1, showKpis = false, kpiSlots = Array.from({ length: 5 }, (_, index) => ({ code: index })) }) {
  return <section role="status" aria-live="polite" aria-label={label}><span className={showKpis ? 'sr-only' : 'text-xs text-secondary'}>{label}</span>{showKpis && <KpiRow>{kpiSlots.map((slot) => <KpiSkeleton key={slot.code} label={slot.name} />)}</KpiRow>}<div className="space-y-6">{Array.from({ length: charts }, (_, index) => <div key={index} aria-hidden="true" className="h-[360px] rounded-panel border border-border bg-secondary" />)}</div></section>
}

export function ExposureEvolutionChart({ items = [], historyAction = null }) {
  const model = exposureEvolutionViewModel(items)
  const title = 'Evolución de exposición acumulada'
  if (!model.rows.length) return <ChartContainer title={title} subtitle="Importes por severidad y periodo; no se imputan meses ni valores."><EmptyChartState chartTitle={title} /></ChartContainer>
  const columns = [{ key: 'periodText', label: 'Periodo' }, ...model.series.map(({ key, label }) => ({ key: `${key}Text`, label, numeric: true }))]
  if (model.rows.length === 1) return <ChartContainer title={title} subtitle="Importes por severidad y periodo; no se imputan meses ni valores." footer={<DataTable caption={`Datos de ${title}`} columns={columns} rows={model.rows} />}><InsufficientHistoryState chartTitle={title} periodText={model.rows[0].periodText} action={historyAction} /></ChartContainer>
  return <ChartContainer title={title} subtitle="Importes por severidad y periodo; no se imputan meses ni valores." footer={<DataTable caption={`Datos de ${title}`} columns={columns} rows={model.rows} />}>
    <ChartLegend items={model.series} />
    <div className="h-[260px] min-w-0" aria-hidden="true"><ResponsiveContainer width="100%" height="100%" minWidth={0}><BarChart data={model.rows} margin={{ left: 10, right: 8 }}><CartesianGrid vertical={false} stroke="var(--border-subtle)" /><XAxis dataKey="month" {...axisProps} tickFormatter={monthTick} /><YAxis {...axisProps} tickFormatter={formatCompactCurrencyMXN} width={62} /><Tooltip content={<SeriesTooltip series={model.series} />} />{model.series.map((series) => <Bar key={series.key} dataKey={series.key} name={series.label} stackId="exposure" fill={series.color} barSize={32} isAnimationActive={false} />)}</BarChart></ResponsiveContainer></div>
  </ChartContainer>
}

export function SeverityChart({ items = [] }) {
  const model = severityCompositionViewModel(items)
  const title = 'Composición por severidad'
  if (!model.rows.length) return <ChartContainer title={title} subtitle="Composición del último periodo disponible dentro de la selección."><EmptyChartState chartTitle={title} message={model.unavailable ? 'No disponible: las observaciones de severidad del último periodo no tienen valor disponible.' : 'Sin observaciones de severidad para los filtros activos.'} /></ChartContainer>
  return <ChartContainer title={title} subtitle={`Periodo: ${model.periodText}. No se acumulan periodos históricos.`} footer={<DataTable caption={`Datos de ${title}`} columns={[{ key: 'name', label: 'Nivel' }, { key: 'valueText', label: 'Importe', numeric: true }, { key: 'percentageText', label: 'Porcentaje', numeric: true }]} rows={model.rows} />}>
    <div className="relative h-[190px] min-w-0" aria-hidden="true"><ResponsiveContainer width="100%" height="100%" minWidth={0}><PieChart><Tooltip content={<CompositionTooltip />} /><Pie data={model.rows} dataKey="value" nameKey="name" innerRadius={46} outerRadius={66} paddingAngle={2} isAnimationActive={false}>{model.rows.map((entry) => <Cell key={entry.id} fill={entry.color} />)}</Pie></PieChart></ResponsiveContainer><div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center"><span className="text-[10px] text-muted">TOTAL</span><span className="font-mono text-[11px] font-semibold tabular-nums text-primary">{model.totalText}</span></div></div>
    <ul aria-label="Detalle de composición" className="space-y-2 text-xs">{model.rows.map((row) => <li key={row.id} className="grid grid-cols-[auto_1fr_auto] items-center gap-2"><span aria-hidden="true" className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: row.color }} /><span className="text-secondary">{row.name}</span><span className="font-mono tabular-nums">{row.valueText} · {row.percentageText}</span></li>)}</ul>
  </ChartContainer>
}

export function TemporalChart({ items = [], kpiCode, title, subtitle, unit, emptyMessage, historyAction = null }) {
  const rows = temporalSeriesViewModel(items, kpiCode)
  if (!rows.length) return <ChartContainer title={title} subtitle={subtitle}><EmptyChartState chartTitle={title} message={emptyMessage} /></ChartContainer>
  const table = <DataTable caption={`Datos de ${title}`} columns={[{ key: 'periodText', label: 'Periodo' }, { key: 'valueText', label: 'Valor', numeric: true }]} rows={rows} />
  const withValue = rows.filter((row) => row.availability === 'DISPONIBLE' && row.value !== null)
  if (!withValue.length) return <ChartContainer title={title} subtitle={subtitle} footer={table}><EmptyChartState chartTitle={title} title={rows.some((row) => row.availability === 'NO_DISPONIBLE') ? 'No disponible' : 'Sin datos disponibles'} message="Ningún periodo de la selección tiene un valor que representar." /></ChartContainer>
  if (withValue.length === 1) return <ChartContainer title={title} subtitle={subtitle} footer={table}><InsufficientHistoryState chartTitle={title} periodText={withValue[0].periodText} detail={withValue[0].valueText} action={historyAction} /></ChartContainer>
  const { data, keys } = segmentedLines(rows, 'value')
  const count = kpiCode === 'KPI-LI-05'
  const Graph = count ? BarChart : LineChart
  const axis = chartAxisConfig(count ? AXIS_UNITS.COUNT : AXIS_UNITS.DAYS, rows.map((row) => row.value))
  const gaps = rows.filter((row) => row.availability === 'NO_OBSERVATION')
  return <ChartContainer title={title} subtitle={subtitle} footer={table}>
    {gaps.length > 0 && <p className="text-xs text-secondary">Periodos sin observación: {gaps.map((row) => row.periodText).join('; ')}. {count ? 'Estos periodos no generan una barra.' : 'La línea se interrumpe en estos periodos.'}</p>}
    <div className="h-[260px] min-w-0" aria-hidden="true"><ResponsiveContainer width="100%" height="100%" minWidth={0}><Graph data={count ? rows : data} margin={{ left: 4, right: 12 }}><CartesianGrid vertical={false} stroke="var(--border-subtle)" /><XAxis dataKey="month" {...axisProps} tickFormatter={monthTick} /><YAxis {...axisProps} {...axis} width={48} /><Tooltip filterNull={false} content={<TemporalTooltip rows={rows} unit={unit} />} />{count ? <Bar dataKey="value" name="Nuevos litigios" fill="var(--chart-bar-1)" barSize={32} isAnimationActive={false} /> : keys.map((key) => <Line key={key} type="linear" dataKey={key} stroke="var(--text-primary)" strokeWidth={2} dot={{ r: 3 }} connectNulls={false} isAnimationActive={false} />)}</Graph></ResponsiveContainer></div>
  </ChartContainer>
}

export function LitigationExposureChart({ items = [], historyAction = null }) {
  const model = litigationExposureViewModel(items)
  const title = 'Evolución de exposición litigiosa'
  if (!model.rows.length) return <ChartContainer title={title} subtitle="Total litigioso derivado únicamente con la partición completa; severidad alta cuando está disponible."><EmptyChartState chartTitle={title} /></ChartContainer>
  const series = [
    ...(model.hasTotal ? [{ key: 'total', label: 'Total', color: 'var(--text-primary)' }] : []),
    ...(model.hasHigh ? [{ key: 'high', label: 'Alta', color: 'var(--critical)' }] : []),
  ]
  const showContext = new Set(model.rows.map((row) => row.contextKey)).size > 1 || model.rows.some((row) => row.contextKey !== '[]')
  const columns = [{ key: 'periodText', label: 'Periodo' }, ...(showContext ? [{ key: 'contextText', label: 'Contexto' }] : []), ...SEVERITIES.map(({ key, label }) => ({ key: `${key}Text`, label, numeric: true })), ...(model.hasTotal ? [{ key: 'totalText', label: 'Total', numeric: true, render: (row) => row.complete ? row.totalText : 'Partición incompleta' }] : [])]
  const plotted = model.rows.filter((row) => Number.isFinite(row.total) || Number.isFinite(row.high))
  if (plotted.length === 1 && model.traces.length === 1) return <ChartContainer title={title} subtitle="Total disponible solo con alto, medio y bajo del mismo periodo y contexto; no se completan observaciones ausentes." footer={<DataTable caption={`Datos de ${title}`} columns={columns} rows={model.rows} />}><InsufficientHistoryState chartTitle={title} periodText={plotted[0].periodText} detail={plotted[0].complete ? `total ${plotted[0].totalText}` : null} action={historyAction} /></ChartContainer>
  return <ChartContainer title={title} subtitle="Total disponible solo con alto, medio y bajo del mismo periodo y contexto; no se completan observaciones ausentes." footer={<DataTable caption={`Datos de ${title}`} columns={columns} rows={model.rows} />}>
    <ChartLegend items={series} />
    <div className="space-y-5">{model.traces.map((trace) => {
      const { data, keys } = mergeSegmented(trace.rows, series)
      const values = trace.rows.flatMap((row) => [row.total, row.high])
      const hasCoordinates = values.some((value) => typeof value === 'number' && Number.isFinite(value))
      return <div key={trace.id} className="min-w-0 space-y-2">{(model.traces.length > 1 || trace.rows[0].contextKey !== '[]') && <p className="text-xs text-secondary">{trace.label}</p>}{hasCoordinates ? <div className="h-[260px] min-w-0" aria-hidden="true"><ResponsiveContainer width="100%" height="100%" minWidth={0}><LineChart data={data} margin={{ left: 10, right: 12 }}><CartesianGrid vertical={false} stroke="var(--border-subtle)" /><XAxis dataKey="month" {...axisProps} tickFormatter={monthTick} /><YAxis {...axisProps} {...chartAxisConfig(AXIS_UNITS.MXN, values)} width={62} /><Tooltip filterNull={false} content={<ExposureTooltip />} />{series.flatMap((seriesItem) => keys[seriesItem.key].map((key) => <Line key={key} type="linear" dataKey={key} name={seriesItem.label} stroke={seriesItem.color} strokeWidth={2} dot={{ r: 3 }} connectNulls={false} isAnimationActive={false} />))}</LineChart></ResponsiveContainer></div> : <EmptyChartState chartTitle={title} title={trace.rows.every((row) => row.sources?.every((item) => item.availability === 'NO_DISPONIBLE')) ? 'No disponible' : 'Sin datos disponibles'} message="Las observaciones recibidas se conservan en la tabla; no hay una serie representable de total o severidad alta." />}</div>
    })}</div>
  </ChartContainer>
}

function IncidentsTooltip({ active, payload, series }) {
  const row = payload?.find((item) => item.payload)?.payload
  if (!active || !row) return null
  return <TooltipSurface title={row.area} rows={series.map(({ key, label }) => ({ label, value: row[`${key}Text`] }))} />
}

// Incidentes de incumplimiento por área (DESIGN §16.4): barras horizontales apiladas por severidad explícita,
// periodo más reciente de la selección, sin total derivado y con tabla equivalente.
export function IncidentsByAreaChart({ items = [] }) {
  const model = incidentsByAreaViewModel(items)
  const title = 'Incidentes por área'
  const subtitle = model.periodText ? `Incidentes de incumplimiento por área y severidad · ${model.periodText}.` : 'Incidentes de incumplimiento por área y severidad.'
  if (!model.series.length) return <ChartContainer title={title} subtitle={subtitle}><EmptyChartState chartTitle={title} title={model.unavailable ? 'No disponible' : 'Sin datos disponibles'} message={model.unavailable ? 'Las observaciones de incidentes del periodo no tienen valor disponible.' : 'Sin observaciones de incidentes para los filtros activos.'} /></ChartContainer>
  const columns = [{ key: 'area', label: 'Área' }, ...SEVERITIES.map(({ key, label }) => ({ key: `${key}Text`, label, numeric: true }))]
  // Largo de cada barra apilada, solo para escalar el eje: no se presenta como total (D-UX-7).
  const values = model.rows.map((row) => model.series.reduce((sum, { key }) => sum + (row[key] || 0), 0))
  const axis = chartAxisConfig(AXIS_UNITS.COUNT, values)
  return <ChartContainer title={title} subtitle={subtitle} footer={<DataTable caption={`Datos de ${title}`} columns={columns} rows={model.rows} />}>
    <ChartLegend items={model.series} />
    <div className="min-w-0" style={{ height: Math.max(160, model.rows.length * 40 + 40) }} aria-hidden="true"><ResponsiveContainer width="100%" height="100%" minWidth={0}><BarChart layout="vertical" data={model.rows} margin={{ left: 4, right: 12 }}><CartesianGrid horizontal={false} stroke="var(--border-subtle)" /><XAxis type="number" {...axisProps} {...axis} /><YAxis type="category" dataKey="area" {...axisProps} width={112} /><Tooltip content={<IncidentsTooltip series={model.series} />} />{model.series.map((series) => <Bar key={series.key} dataKey={series.key} name={series.label} stackId="incidents" fill={series.color} barSize={18} isAnimationActive={false} />)}</BarChart></ResponsiveContainer></div>
  </ChartContainer>
}

const catalogOrder = Object.keys(KPI_CATALOG)
const observationOrder = (a, b) => catalogOrder.indexOf(a.kpi_code) - catalogOrder.indexOf(b.kpi_code) || a.period_start.localeCompare(b.period_start) || a.dimensionsText.localeCompare(b.dimensionsText)
// Periodo con la fecha de corte cuando el mes aún no termina: «octubre 2026 (al 13 oct 2026)».
const observationPeriod = (row) => row.as_of_date && row.as_of_date < row.period_end ? `${row.periodText} (al ${formatDocumentDate(row.as_of_date)})` : row.periodText

// Datos de los indicadores (DESIGN §16.3): columnas de decisión; Ámbito y Entidad solo cuando alguna fila
// los tiene; fecha de cálculo, fecha de corte e identificador del indicador en el detalle de cada fila.
export function ObservationTable({ items, caption = 'Datos de los indicadores' }) {
  const rows = [...items].sort(observationOrder)
  const columns = [
    { key: 'name', label: 'Indicador' },
    { key: 'periodText', label: 'Periodo', render: observationPeriod },
    { key: 'valueText', label: 'Valor', numeric: true },
    ...(rows.some((row) => row.dimensionsText) ? [{ key: 'dimensionsText', label: 'Ámbito', render: (row) => row.dimensionsText || '—' }] : []),
    ...(rows.some((row) => row.entity_filter_applicable) ? [{ key: 'entityText', label: 'Entidad' }] : []),
    { key: 'detail', label: 'Detalle', render: (row) => <TechnicalDetails summary="Ver"><dl><dt>Calculado</dt><dd className="mono">{formatAuditTimestamp(row.calculated_at)}</dd><dt>Datos al</dt><dd>{formatDocumentDate(row.as_of_date)}</dd></dl></TechnicalDetails> },
  ]
  return <DataTable caption={caption} columns={columns} rows={rows} />
}

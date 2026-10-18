import React from 'react'
import { Bar, BarChart, CartesianGrid, Cell, LabelList, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { DataTable, KpiRow, KpiSkeleton, TechnicalDetails } from '../../components/data.jsx'
import { Button } from '../../components/controls.jsx'
import { useIsNarrow } from '../../components/filters.jsx'
import { formatDecimal } from '../../shared/formatters.js'
import { formatDocumentDate, formatQuantity, formatUserTimestamp } from '../../shared/presentation.js'
import {
  exposureEvolutionViewModel,
  formatCompactCurrencyMXN,
  incidentsByAreaViewModel,
  SEVERITIES,
  litigationExposureViewModel,
  matterVolumePivot,
  severityCompositionViewModel,
  temporalSeriesViewModel,
} from './viewModels.js'
import { AXIS_UNITS, chartAxisConfig, monthTick } from './chartAxes.js'
import { KPI_CATALOG } from './adapters.js'

const AXIS_TICK = Object.freeze({ fill: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 11 })
const axisProps = Object.freeze({ axisLine: { stroke: 'var(--border-default)' }, tickLine: false, tick: AXIS_TICK })
// Eje temporal: siempre se ven el primer y el último mes aunque los intermedios se omitan por espacio.
const timeAxisProps = Object.freeze({ ...axisProps, interval: 'preserveStartEnd' })
// Margen lateral en las líneas para que el primer y el último punto no queden pegados a los bordes.
const LINE_PADDING = Object.freeze({ left: 16, right: 16 })
// Resalte bajo el cursor con el color de selección del tema (el gris por defecto de Recharts resalta en oscuro).
const BAR_CURSOR = Object.freeze({ fill: 'var(--background-selected)' })
const LINE_CURSOR = Object.freeze({ stroke: 'var(--border-strong)', strokeWidth: 1 })
const LABEL_TEXT = Object.freeze({ fill: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', fontSize: 11 })

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

// Meses que no se dibujan y por qué: sin observación (hueco del calendario) o con valor «No disponible».
function AvailabilityNote({ rows, consequence }) {
  const gaps = rows.filter((row) => row.availability === 'NO_OBSERVATION').map((row) => row.periodText)
  const unavailable = rows.filter((row) => row.availability === 'NO_DISPONIBLE').map((row) => row.periodText)
  if (!gaps.length && !unavailable.length) return null
  return <p className="text-xs text-secondary">{[gaps.length ? `Periodos sin observación: ${gaps.join('; ')}.` : null, unavailable.length ? `Periodos no disponibles: ${unavailable.join('; ')}.` : null, consequence].filter(Boolean).join(' ')}</p>
}

function TooltipSurface({ title, rows }) {
  return <div className="min-w-[160px] rounded-control border border-border bg-surface p-3 text-xs shadow-subtle"><p className="mb-2 font-medium text-primary">{title}</p><dl className="space-y-1">{rows.map((row) => <div key={row.label} className="flex items-center justify-between gap-4"><dt className="text-secondary">{row.label}</dt><dd className="font-mono tabular-nums text-primary">{row.value}</dd></div>)}</dl></div>
}

// Exposición del mes: las tres severidades con su estado y el total solo con la partición completa.
function ExposureBarTooltip({ active, payload }) {
  const row = payload?.find((item) => item.payload)?.payload
  if (!active || !row) return null
  if (row.availability !== 'DISPONIBLE') return <TooltipSurface title={row.periodText || row.month} rows={[{ label: 'Disponibilidad', value: row.availability === 'NO_DISPONIBLE' ? 'No disponible' : 'Sin observación' }]} />
  const values = SEVERITIES.map(({ key, label }) => ({ label, value: row[`${key}Text`] }))
  return <TooltipSurface title={row.periodText || row.month} rows={row.complete ? [{ label: 'Total', value: row.totalText }, ...values] : values} />
}

export function TemporalTooltip({ active, payload, label, rows = [], unit }) {
  const row = payload?.find((item) => item.payload)?.payload || rows.find((item) => item.month === label)
  if (!active || !row) return null
  const value = row.availability === 'NO_OBSERVATION' ? 'Sin observación'
    : row.availability === 'NO_DISPONIBLE' ? 'No disponible'
      : formatQuantity(row.rawValue?.replace(/\.0+$/, ''), unit)
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

// Importe abreviado y porcentaje encima de cada barra de composición.
// Se identifica por nombre: Recharts omite las barras sin valor al numerar sus etiquetas.
function CompositionLabel({ x, y, width, value, rows }) {
  const row = rows.find((item) => item.name === value)
  if (!row || row.value === null || !Number.isFinite(x)) return null
  return <text x={x + width / 2} y={y - 6} textAnchor="middle" {...LABEL_TEXT}>
    {row.percentage !== null && <tspan x={x + width / 2} dy={-14}>{formatCompactCurrencyMXN(row.value)}</tspan>}
    <tspan x={x + width / 2} dy={row.percentage !== null ? 14 : 0}>{row.percentage !== null ? row.percentageText : formatCompactCurrencyMXN(row.value)}</tspan>
  </text>
}

// Severidad en el eje; si no hay valor se indica debajo (No disponible / Sin observación), sin dibujar barra.
function CompositionTick({ x, y, payload, rows }) {
  const row = rows.find((item) => item.name === payload.value)
  return <g transform={`translate(${x},${y})`}><text dy={12} textAnchor="middle" {...AXIS_TICK} fill="var(--text-secondary)">{payload.value}</text>{row && row.value === null && <text dy={26} textAnchor="middle" {...AXIS_TICK}>{row.valueText}</text>}</g>
}

// Valor de cada barra de conteo, incluido el 0, que de otro modo no se distingue de un mes sin dato.
function CountLabel({ x, y, width, value }) {
  if (value === null || value === undefined || !Number.isFinite(x)) return null
  return <text x={x + width / 2} y={y - 6} textAnchor="middle" {...LABEL_TEXT}>{formatDecimal(String(value))}</text>
}

// Nombre del área: en escritorio hasta dos líneas a la izquierda; en móvil encima de su barra. Se recorta con «…»
// y el nombre completo sigue en el tooltip y en la tabla.
const fitLines = (text, perLine, lines) => {
  const words = String(text).split(/\s+/)
  const result = []
  let current = ''
  for (const word of words) {
    const next = current ? `${current} ${word}` : word
    if (next.length <= perLine) { current = next; continue }
    if (current) result.push(current)
    current = word
    if (result.length === lines) break
  }
  if (result.length < lines && current) result.push(current)
  const used = result.slice(0, lines)
  const shown = used.join(' ')
  if (shown.length < String(text).length) used[used.length - 1] = `${used[used.length - 1].slice(0, Math.max(1, perLine - 1))}…`
  return used.map((line) => line.length > perLine ? `${line.slice(0, perLine - 1)}…` : line)
}
function AreaTick({ x, y, payload, narrow }) {
  if (narrow) return <text x={8} y={y - 14} textAnchor="start" {...AXIS_TICK} fill="var(--text-secondary)">{fitLines(payload.value, 38, 1)[0]}</text>
  const lines = fitLines(payload.value, 24, 2)
  return <text x={x - 6} y={y} textAnchor="end" {...AXIS_TICK} fill="var(--text-secondary)">{lines.map((line, index) => <tspan key={index} x={x - 6} dy={index === 0 ? (lines.length > 1 ? -2 : 4) : 13}>{line}</tspan>)}</text>
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

// alerts ocupa, durante la carga de los KPI, la misma posición que tendrá «Requiere atención» al recibirlos.
export function ChartLoadingState({ label = 'Cargando…', charts = 1, showKpis = false, kpiSlots = Array.from({ length: 5 }, (_, index) => ({ code: index })), beforeAlerts = null, alerts = null }) {
  return <section role="status" aria-live="polite" aria-label={label}><span className={showKpis ? 'sr-only' : 'text-xs text-secondary'}>{label}</span>{showKpis && <KpiRow>{kpiSlots.map((slot) => <KpiSkeleton key={slot.code} label={slot.name} />)}</KpiRow>}{(beforeAlerts || alerts) && <div className="mb-8 space-y-8">{beforeAlerts}{alerts}</div>}<div className="space-y-6">{Array.from({ length: charts }, (_, index) => <div key={index} aria-hidden="true" className="h-[360px] rounded-panel border border-border bg-surface p-5"><div className="skeleton h-3 w-1/3" /><div className="skeleton mt-6 h-[260px] w-full opacity-60" /></div>)}</div></section>
}
// Carga de alertas con la geometría de un bloque de hallazgos (encabezado + dos tarjetas).
export function AlertsSkeleton({ label = 'Cargando…' }) {
  return <section role="status" aria-live="polite" aria-label={label} className="space-y-5"><span className="sr-only">{label}</span><div aria-hidden="true" className="space-y-5"><div className="skeleton h-4 w-40" /><div className="skeleton h-2.5 w-2/3" /><div className="grid grid-cols-1 gap-4 xl:grid-cols-2">{[0, 1].map((index) => <div key={index} className="h-[132px] space-y-3 rounded-panel border border-border bg-surface p-5"><div className="skeleton h-2.5 w-1/4" /><div className="skeleton h-3.5 w-3/5" /><div className="skeleton h-2.5 w-11/12" /><div className="skeleton h-2.5 w-4/5" /></div>)}</div></div></section>
}

export function ExposureEvolutionChart({ items = [], historyAction = null }) {
  const model = exposureEvolutionViewModel(items)
  const title = 'Evolución de exposición acumulada'
  const subtitle = 'Importes por severidad y periodo; no se imputan meses ni valores.'
  if (!model.rows.length) return <ChartContainer title={title} subtitle={subtitle}><EmptyChartState chartTitle={title} /></ChartContainer>
  const columns = [{ key: 'periodText', label: 'Periodo', nowrap: true }, ...SEVERITIES.map(({ key, label }) => ({ key: `${key}Text`, label, numeric: true })), { key: 'totalText', label: 'Total', numeric: true }]
  const table = <DataTable compact caption={`Datos de ${title}`} columns={columns} rows={model.rows} />
  const valued = model.rows.filter((row) => row.availability === 'DISPONIBLE')
  if (!valued.length) return <ChartContainer title={title} subtitle={subtitle} footer={table}><EmptyChartState chartTitle={title} title="No disponible" message="Los meses de la selección tienen observaciones de exposición sin valor disponible." /></ChartContainer>
  if (valued.length === 1) return <ChartContainer title={title} subtitle={subtitle} footer={table}><InsufficientHistoryState chartTitle={title} periodText={valued[0].periodText} action={historyAction} /></ChartContainer>
  if (valued.every((row) => SEVERITIES.every(({ key }) => !row[key]))) return <ChartContainer title={title} subtitle={subtitle} footer={table}><AvailabilityNote rows={model.rows} /><EmptyChartState chartTitle={title} title="Exposición en $0" message="Todos los importes de los meses con valor son $0 MXN; no hay barras que dibujar." /></ChartContainer>
  const axis = chartAxisConfig(AXIS_UNITS.MXN, valued.map((row) => SEVERITIES.reduce((sum, { key }) => sum + (row[key] || 0), 0)))
  return <ChartContainer title={title} subtitle={subtitle} footer={table}>
    <AvailabilityNote rows={model.rows} consequence="Estos periodos no generan una barra." />
    <ChartLegend items={model.series} />
    <div className="h-[260px] min-w-0" aria-hidden="true"><ResponsiveContainer width="100%" height="100%" minWidth={0}><BarChart data={model.rows} margin={{ left: 10, right: 8 }}><CartesianGrid vertical={false} stroke="var(--border-subtle)" /><XAxis dataKey="month" {...timeAxisProps} tickFormatter={monthTick} /><YAxis {...axisProps} {...axis} width={62} /><Tooltip cursor={BAR_CURSOR} content={<ExposureBarTooltip />} />{model.series.map((series) => <Bar key={series.key} dataKey={series.key} name={series.label} stackId="exposure" fill={series.color} barSize={32} isAnimationActive={false} />)}</BarChart></ResponsiveContainer></div>
  </ChartContainer>
}

// Composición por severidad del último periodo en barras verticales (DESIGN §8.4, 2026-10-18): permite comparar
// alturas sobre un eje común aunque los importes sean parecidos, y conserva visibles los valores pequeños y el cero.
export function SeverityChart({ items = [] }) {
  const model = severityCompositionViewModel(items)
  const title = 'Composición por severidad'
  if (!model.rows.length) return <ChartContainer title={title} subtitle="Composición del último periodo disponible dentro de la selección."><EmptyChartState chartTitle={title} title={model.unavailable ? 'No disponible' : 'Sin datos disponibles'} message={model.unavailable ? 'Las observaciones de severidad del último periodo no tienen valor disponible.' : 'Sin observaciones de severidad para los filtros activos.'} /></ChartContainer>
  const totalText = model.complete ? `Total: ${model.totalText}.` : `Total y porcentajes no disponibles: falta ${model.missing.join(' y ').toLowerCase()}.`
  const subtitle = `Periodo: ${model.periodText}. ${totalText} No se acumulan periodos históricos.`
  const table = <DataTable compact caption={`Datos de ${title}`} columns={[{ key: 'name', label: 'Nivel' }, { key: 'valueText', label: 'Importe', numeric: true }, { key: 'percentageText', label: 'Porcentaje', numeric: true }]} rows={model.rows} />
  if (model.allZero) return <ChartContainer title={title} subtitle={subtitle} footer={table}><EmptyChartState chartTitle={title} title="Exposición en $0" message={`Las tres severidades suman $0 MXN en ${model.periodText}.`} className="h-[200px]" /></ChartContainer>
  const axis = chartAxisConfig(AXIS_UNITS.MXN, model.rows.map((row) => row.value))
  return <ChartContainer title={title} subtitle={subtitle} footer={table}>
    <div className="h-[240px] min-w-0" aria-hidden="true"><ResponsiveContainer width="100%" height="100%" minWidth={0}><BarChart data={model.rows} margin={{ top: 34, left: 10, right: 8, bottom: 14 }}><CartesianGrid vertical={false} stroke="var(--border-subtle)" /><XAxis dataKey="name" {...axisProps} interval={0} tick={<CompositionTick rows={model.rows} />} /><YAxis {...axisProps} {...axis} width={62} /><Tooltip cursor={BAR_CURSOR} content={<CompositionTooltip />} /><Bar dataKey="value" name="Importe" barSize={48} isAnimationActive={false}>{model.rows.map((row) => <Cell key={row.id} fill={row.color} />)}<LabelList dataKey="name" content={<CompositionLabel rows={model.rows} />} /></Bar></BarChart></ResponsiveContainer></div>
  </ChartContainer>
}

export function TemporalChart({ items = [], kpiCode, title, subtitle, unit, emptyMessage, historyAction = null }) {
  const rows = temporalSeriesViewModel(items, kpiCode)
  if (!rows.length) return <ChartContainer title={title} subtitle={subtitle}><EmptyChartState chartTitle={title} message={emptyMessage} /></ChartContainer>
  const table = <DataTable compact caption={`Datos de ${title}`} columns={[{ key: 'periodText', label: 'Periodo', nowrap: true }, { key: 'valueText', label: 'Valor', numeric: true }]} rows={rows} />
  const withValue = rows.filter((row) => row.availability === 'DISPONIBLE' && row.value !== null)
  if (!withValue.length) return <ChartContainer title={title} subtitle={subtitle} footer={table}><EmptyChartState chartTitle={title} title={rows.some((row) => row.availability === 'NO_DISPONIBLE') ? 'No disponible' : 'Sin datos disponibles'} message="Ningún periodo de la selección tiene un valor que representar." /></ChartContainer>
  if (withValue.length === 1) return <ChartContainer title={title} subtitle={subtitle} footer={table}><InsufficientHistoryState chartTitle={title} periodText={withValue[0].periodText} detail={withValue[0].valueText} action={historyAction} /></ChartContainer>
  const { data, keys } = segmentedLines(rows, 'value')
  const count = kpiCode === 'KPI-LI-05'
  const Graph = count ? BarChart : LineChart
  const axis = chartAxisConfig(count ? AXIS_UNITS.COUNT : AXIS_UNITS.DAYS, rows.map((row) => row.value))
  return <ChartContainer title={title} subtitle={subtitle} footer={table}>
    <AvailabilityNote rows={rows} consequence={count ? 'Estos periodos no generan una barra.' : 'La línea se interrumpe en estos periodos.'} />
    <div className="h-[260px] min-w-0" aria-hidden="true"><ResponsiveContainer width="100%" height="100%" minWidth={0}><Graph data={count ? rows : data} margin={{ top: count ? 20 : 8, left: 4, right: 12 }}><CartesianGrid vertical={false} stroke="var(--border-subtle)" /><XAxis dataKey="month" {...timeAxisProps} {...(count ? {} : { padding: LINE_PADDING })} tickFormatter={monthTick} /><YAxis {...axisProps} {...axis} width={48} /><Tooltip filterNull={false} cursor={count ? BAR_CURSOR : LINE_CURSOR} content={<TemporalTooltip rows={rows} unit={unit} />} />{count ? <Bar dataKey="value" name="Nuevos litigios" fill="var(--chart-bar-1)" barSize={32} minPointSize={(value) => value === 0 ? 2 : 0} isAnimationActive={false}><LabelList dataKey="value" content={<CountLabel />} /></Bar> : keys.map((key) => <Line key={key} type="linear" dataKey={key} stroke="var(--text-primary)" strokeWidth={2} dot={{ r: 3 }} connectNulls={false} isAnimationActive={false} />)}</Graph></ResponsiveContainer></div>
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
  const columns = [{ key: 'periodText', label: 'Periodo', nowrap: true }, ...(showContext ? [{ key: 'contextText', label: 'Contexto' }] : []), ...SEVERITIES.map(({ key, label }) => ({ key: `${key}Text`, label, numeric: true })), ...(model.hasTotal ? [{ key: 'totalText', label: 'Total', numeric: true, render: (row) => row.complete ? row.totalText : 'Partición incompleta' }] : [])]
  const plotted = model.rows.filter((row) => Number.isFinite(row.total) || Number.isFinite(row.high))
  // Una sola escala para todos los contextos: dos entidades se comparan sobre el mismo eje.
  const sharedValues = model.rows.flatMap((row) => [row.total, row.high])
  const withTotal = model.rows.filter((row) => row.complete).length
  const partialTotal = model.hasTotal && withTotal < model.rows.length ? `Total visible en ${withTotal} de ${model.rows.length} ${model.rows.length === 1 ? 'periodo' : 'periodos'}: solo se calcula con Alto, Medio y Bajo disponibles del mismo mes.` : null
  if (plotted.length === 1 && model.traces.length === 1) return <ChartContainer title={title} subtitle="Total disponible solo con alto, medio y bajo del mismo periodo y contexto; no se completan observaciones ausentes." footer={<DataTable compact caption={`Datos de ${title}`} columns={columns} rows={model.rows} />}><InsufficientHistoryState chartTitle={title} periodText={plotted[0].periodText} detail={plotted[0].complete ? `total ${plotted[0].totalText}` : null} action={historyAction} /></ChartContainer>
  return <ChartContainer title={title} subtitle="Total disponible solo con alto, medio y bajo del mismo periodo y contexto; no se completan observaciones ausentes." footer={<DataTable compact caption={`Datos de ${title}`} columns={columns} rows={model.rows} />}>
    <ChartLegend items={series} />
    {partialTotal && <p className="text-xs text-secondary">{partialTotal}</p>}
    <div className="space-y-5">{model.traces.map((trace) => {
      const { data, keys } = mergeSegmented(trace.rows, series)
      const values = trace.rows.flatMap((row) => [row.total, row.high])
      const hasCoordinates = values.some((value) => typeof value === 'number' && Number.isFinite(value))
      return <div key={trace.id} className="min-w-0 space-y-2">{(model.traces.length > 1 || trace.rows[0].contextKey !== '[]') && <p className="text-xs text-secondary">{trace.label}</p>}{hasCoordinates ? <div className="h-[260px] min-w-0" aria-hidden="true"><ResponsiveContainer width="100%" height="100%" minWidth={0}><LineChart data={data} margin={{ left: 10, right: 12 }}><CartesianGrid vertical={false} stroke="var(--border-subtle)" /><XAxis dataKey="month" {...timeAxisProps} padding={LINE_PADDING} tickFormatter={monthTick} /><YAxis {...axisProps} {...chartAxisConfig(AXIS_UNITS.MXN, sharedValues)} width={62} /><Tooltip filterNull={false} cursor={LINE_CURSOR} content={<ExposureTooltip />} />{series.flatMap((seriesItem) => keys[seriesItem.key].map((key) => <Line key={key} type="linear" dataKey={key} name={seriesItem.label} stroke={seriesItem.color} strokeWidth={2} dot={{ r: 3 }} connectNulls={false} isAnimationActive={false} />))}</LineChart></ResponsiveContainer></div> : <EmptyChartState chartTitle={title} title={trace.rows.every((row) => row.sources?.every((item) => item.availability === 'NO_DISPONIBLE')) ? 'No disponible' : 'Sin datos disponibles'} message="Las observaciones recibidas se conservan en la tabla; no hay una serie representable de total o severidad alta." />}</div>
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
  const narrow = useIsNarrow()
  const title = 'Incidentes por área'
  const subtitle = model.periodText ? `Incidentes de incumplimiento por área y severidad · ${model.periodText}.` : 'Incidentes de incumplimiento por área y severidad.'
  if (!model.series.length) return <ChartContainer title={title} subtitle={subtitle}><EmptyChartState chartTitle={title} title={model.unavailable ? 'No disponible' : 'Sin datos disponibles'} message={model.unavailable ? 'Las observaciones de incidentes del periodo no tienen valor disponible.' : 'Sin observaciones de incidentes para los filtros activos.'} /></ChartContainer>
  const columns = [{ key: 'area', label: 'Área' }, ...SEVERITIES.map(({ key, label }) => ({ key: `${key}Text`, label, numeric: true }))]
  if (model.allZero) return <ChartContainer title={title} subtitle={subtitle} footer={<DataTable compact caption={`Datos de ${title}`} columns={columns} rows={model.rows} />}><EmptyChartState chartTitle={title} title="0 incidentes" message={`Ninguna de las áreas registradas tiene incidentes en ${model.periodText}.`} className="h-[180px]" /></ChartContainer>
  // Largo de cada barra apilada, solo para escalar el eje: no se presenta como total (D-UX-7).
  const values = model.rows.map((row) => model.series.reduce((sum, { key }) => sum + (row[key] || 0), 0))
  const axis = chartAxisConfig(AXIS_UNITS.COUNT, values)
  return <ChartContainer title={title} subtitle={subtitle} footer={<DataTable compact caption={`Datos de ${title}`} columns={columns} rows={model.rows} />}>
    <ChartLegend items={model.series} />
    <div className="min-w-0" style={{ height: Math.max(160, model.rows.length * (narrow ? 52 : 44) + 40) }} aria-hidden="true"><ResponsiveContainer width="100%" height="100%" minWidth={0}><BarChart layout="vertical" data={model.rows} margin={{ top: narrow ? 14 : 4, left: narrow ? 8 : 4, right: 12 }}><CartesianGrid horizontal={false} stroke="var(--border-subtle)" /><XAxis type="number" {...axisProps} {...axis} /><YAxis type="category" dataKey="area" {...axisProps} interval={0} width={narrow ? 4 : 168} tick={<AreaTick narrow={narrow} />} /><Tooltip cursor={BAR_CURSOR} content={<IncidentsTooltip series={model.series} />} />{model.series.map((series) => <Bar key={series.key} dataKey={series.key} name={series.label} stackId="incidents" fill={series.color} barSize={18} isAnimationActive={false} />)}</BarChart></ResponsiveContainer></div>
  </ChartContainer>
}

const catalogOrder = Object.keys(KPI_CATALOG)
const observationOrder = (a, b) => catalogOrder.indexOf(a.kpi_code) - catalogOrder.indexOf(b.kpi_code) || a.period_start.localeCompare(b.period_start) || a.dimensionsText.localeCompare(b.dimensionsText)
// Periodo con la fecha de corte cuando el mes aún no termina: «octubre 2026 (al 13 oct 2026)».
const observationPeriod = (row) => row.as_of_date && row.as_of_date < row.period_end ? <><span className="block whitespace-nowrap">{row.periodText}</span>{' '}<span className="block whitespace-nowrap text-xs text-secondary">(al {formatDocumentDate(row.as_of_date)})</span></> : row.periodText

// Datos de los indicadores (DESIGN §16.3): columnas de decisión; Ámbito y Entidad solo cuando alguna fila
// los tiene; fecha de cálculo, fecha de corte e identificador del indicador en el detalle de cada fila.
// Celda sin observación: «Sin dato», nunca cero (no se imputan combinaciones ausentes).
export function MatterVolumeTable({ items, model = matterVolumePivot(items) }) {
  if (!model) return null
  return <div className="space-y-2"><h3 className="text-sm font-semibold">Volumen de asuntos jurídicos gestionados · {model.periodText}</h3><DataTable caption="Volumen de asuntos por tipo y estado" columns={[{ key: 'type', label: 'Tipo de asunto', nowrap: true }, ...model.states.map((state) => ({ key: `estado-${state}`, label: state, numeric: true, render: (row) => row.values[state] ?? <span className="text-muted">Sin dato</span> }))]} rows={model.rows} /></div>
}
export function ObservationTable({ items, caption = 'Datos de los indicadores' }) {
  const rows = [...items].sort(observationOrder)
  const columns = [
    { key: 'name', label: 'Indicador', medium: true },
    { key: 'periodText', label: 'Periodo', nowrap: true, render: observationPeriod },
    { key: 'valueText', label: 'Valor', numeric: true },
    ...(rows.some((row) => row.dimensionsText) ? [{ key: 'dimensionsText', label: 'Ámbito', medium: true, render: (row) => row.dimensionsText || '—' }] : []),
    ...(rows.some((row) => row.entity_filter_applicable) ? [{ key: 'entityText', label: 'Entidad' }] : []),
    { key: 'calculated_at', label: 'Calculado', render: (row) => formatUserTimestamp(row.calculated_at) },
  ]
  return <DataTable caption={caption} columns={columns} rows={rows} />
}

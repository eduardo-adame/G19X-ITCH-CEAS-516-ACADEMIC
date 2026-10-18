import { formatDate, formatDecimal, roundDecimal } from '../../shared/formatters.js'
import { formatPeriodRange } from '../../shared/presentation.js'

export const SEVERITIES = Object.freeze([
  { key: 'alto', label: 'Alto', color: 'var(--critical)' },
  { key: 'medio', label: 'Medio', color: 'var(--warning)' },
  { key: 'bajo', label: 'Bajo', color: 'var(--success)' },
])

function chartNumber(item) {
  if (item.availability !== 'DISPONIBLE' || item.value === null) return null
  // Coordenada de la gráfica: no se descarta un decimal válido por precisión
  // binaria (p. ej. 18.333…); solo se excluyen valores fuera de rango seguro.
  const number = Number(item.value)
  return Number.isFinite(number) && Math.abs(number) <= Number.MAX_SAFE_INTEGER ? number : null
}

export function sumDecimals(values) {
  const precision = Math.max(...values.map((value) => String(value).split('.')[1]?.length || 0))
  const factor = 10n ** BigInt(precision)
  const total = values.reduce((sum, value) => {
    const text = String(value)
    const [integer, fraction = ''] = text.replace(/^-/, '').split('.')
    const magnitude = BigInt(integer) * factor + BigInt(fraction.padEnd(precision, '0') || '0')
    return sum + (text.startsWith('-') ? -magnitude : magnitude)
  }, 0n)
  const sign = total < 0n ? '-' : ''
  const absolute = total < 0n ? -total : total
  const integer = absolute / factor
  const fraction = precision ? String(absolute % factor).padStart(precision, '0').replace(/0+$/, '') : ''
  return `${sign}${integer}${fraction ? `.${fraction}` : ''}`
}

function byPeriod(a, b) {
  return a.period_start.localeCompare(b.period_start)
}

function periodRow(item) {
  return {
    id: item.period_start,
    period_start: item.period_start,
    periodText: item.periodText,
    month: item.period_start.slice(0, 7),
  }
}

function groupedPeriods(items, kpiCode) {
  const periods = new Map()
  for (const item of items.filter((row) => row.kpi_code === kpiCode).sort(byPeriod)) {
    if (!periods.has(item.period_start)) periods.set(item.period_start, periodRow(item))
    periods.get(item.period_start).source = item
  }
  return periods
}

export function formatCurrencyMXN(value) {
  return value === null || value === undefined ? 'No disponible' : formatDecimal(String(value), { prefix: '$', suffix: ' MXN' })
}

export function formatCompactCurrencyMXN(value) {
  if (!Number.isFinite(Number(value))) return '—'
  const millions = Number(value) / 1_000_000
  const digits = Math.abs(millions) > 0 && Math.abs(millions) < 1 ? 2 : 1
  return `$${millions.toLocaleString('es-MX', { minimumFractionDigits: 0, maximumFractionDigits: digits })} M`
}

export function formatDays(value) {
  return value === null || value === undefined ? 'No disponible' : `${formatDecimal(roundDecimal(String(value)))} días`
}

export function formatCount(value, unit = '') {
  if (value === null || value === undefined) return 'No disponible'
  return `${formatDecimal(String(value))}${unit ? ` ${unit}` : ''}`
}

export function formatPercentage(value) {
  if (!Number.isFinite(Number(value))) return 'No disponible'
  return `${Number(value).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} %`
}

export function formatPeriod(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}$/.test(value) ? value : formatDate(value)
}

// Evolución de exposición (KPI-LI-01) sobre el calendario completo de la selección: un mes sin observación o con
// observaciones «No disponible» se conserva como tal, sin omitirlo ni imputarlo. El total del mes solo se informa
// con Alto, Medio y Bajo disponibles del mismo periodo y contexto (DDG-003).
export function exposureEvolutionViewModel(items) {
  const eligible = items.filter((row) => row.kpi_code === 'KPI-LI-01' && row.severity)
  const periods = groupedPeriods(eligible, 'KPI-LI-01')
  const sources = new Map([...periods.keys()].map((key) => [key, []]))
  const present = new Set()
  for (const item of eligible) {
    const period = periods.get(item.period_start)
    sources.get(item.period_start).push(item)
    const value = chartNumber(item)
    if (value === null) { period[`${item.severity}Text`] = 'No disponible'; continue }
    period[item.severity] = value
    period[`${item.severity}Raw`] = item.value
    period[`${item.severity}Text`] = formatCurrencyMXN(item.value)
    present.add(item.severity)
  }
  const observed = [...periods.values()].map((row) => {
    const rowSources = sources.get(row.period_start)
    const complete = hasCompleteExposurePartition(rowSources)
    const totalRaw = complete ? sumDecimals(rowSources.map((item) => item.value)) : null
    const texts = Object.fromEntries(SEVERITIES.map(({ key }) => [`${key}Text`, row[`${key}Text`] || 'Sin observación']))
    return { ...row, ...texts, availability: SEVERITIES.some(({ key }) => row[key] !== undefined) ? 'DISPONIBLE' : 'NO_DISPONIBLE', complete, totalRaw, totalText: complete ? formatCurrencyMXN(totalRaw) : 'No disponible' }
  })
  const rows = monthlyTimeline(observed).map((row) => row.availability === 'NO_OBSERVATION'
    ? { ...row, ...Object.fromEntries(SEVERITIES.map(({ key }) => [`${key}Text`, 'Sin observación'])), complete: false, totalText: 'Sin observación' }
    : row)
  return { rows, series: SEVERITIES.filter(({ key }) => present.has(key)) }
}

// Composición del último periodo por severidad. Las tres severidades se presentan siempre; una ausente o
// «No disponible» se muestra como tal. Total y porcentajes solo con la partición completa (DDG-003): con una
// severidad faltante, un porcentaje sobre las demás describiría mal el reparto.
export function severityCompositionViewModel(items) {
  const eligible = items.filter((item) => item.kpi_code === 'KPI-LI-01' && item.severity)
  if (!eligible.length) return { period: null, total: null, rows: [] }
  const period = eligible.reduce((latest, item) => item.period_start > latest ? item.period_start : latest, eligible[0].period_start)
  const current = eligible.filter((item) => item.period_start === period)
  // Observaciones del periodo sin valor disponible: «No disponible», no «Sin observación».
  if (!current.some((item) => chartNumber(item) !== null)) return { period, total: null, rows: [], unavailable: current.some((item) => item.availability === 'NO_DISPONIBLE') }
  const complete = hasCompleteExposurePartition(current)
  const totalRaw = complete ? sumDecimals(current.map((item) => item.value)) : null
  const total = complete ? Number(totalRaw) : null
  const rows = SEVERITIES.map((severity) => {
    const matches = current.filter((item) => item.severity === severity.key)
    const item = matches.length === 1 ? matches[0] : null
    const value = item ? chartNumber(item) : null
    const percentage = complete && value !== null ? (total === 0 ? 0 : value / total * 100) : null
    return {
      id: severity.key,
      severity: severity.key,
      name: severity.label,
      color: severity.color,
      value,
      valueText: !item ? (matches.length ? 'Observaciones no comparables' : 'Sin observación') : value === null ? 'No disponible' : formatCurrencyMXN(item.value),
      percentage,
      percentageText: percentage === null ? 'No disponible' : formatPercentage(percentage),
    }
  })
  return {
    period,
    periodText: current[0].periodText || period,
    complete,
    total,
    totalText: complete ? formatCurrencyMXN(totalRaw) : 'No disponible',
    allZero: complete && total === 0,
    missing: rows.filter((row) => row.value === null).map((row) => row.name),
    rows,
  }
}

export function temporalSeriesViewModel(items, kpiCode) {
  const rows = items.filter((row) => row.kpi_code === kpiCode).sort(byPeriod).map((item) => ({
    ...periodRow(item),
    value: chartNumber(item),
    rawValue: item.value,
    valueText: item.valueText ?? item.displayValue,
    unit: item.unit,
    availability: item.availability,
    dimensionsText: item.dimensionsText,
  }))
  return monthlyTimeline(rows).map((row) => ({ ...row, unit: row.unit || rows[0]?.unit }))
}

function monthOrdinal(month) {
  return Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1
}

function monthFromOrdinal(ordinal) {
  return `${String(Math.floor(ordinal / 12)).padStart(4, '0')}-${String(ordinal % 12 + 1).padStart(2, '0')}`
}

export function monthlyTimeline(rows) {
  if (!rows.length) return []
  const ordered = [...rows].sort((a, b) => a.month.localeCompare(b.month))
  const start = monthOrdinal(ordered[0].month)
  const end = monthOrdinal(ordered.at(-1).month)
  return Array.from({ length: end - start + 1 }, (_, index) => {
    const month = monthFromOrdinal(start + index)
    const present = ordered.filter((row) => row.month === month)
    if (present.length) return present
    const period_start = `${month}-01`
    const date = new Date(`${period_start}T00:00:00Z`)
    date.setUTCMonth(date.getUTCMonth() + 1); date.setUTCDate(0)
    const period_end = date.toISOString().slice(0, 10)
    // El hueco pertenece al calendario visual, no a las observaciones productivas.
    return [{ id: `gap-${month}`, month, period_start, period_end, periodText: formatPeriodRange(period_start, period_end), value: null, rawValue: null, valueText: 'Sin observación', availability: 'NO_OBSERVATION', observed: false }]
  }).flat()
}

const DIMENSION_LABELS = Object.freeze({ entity: 'Entidad', area: 'Área', tipo_asunto: 'Tipo de asunto', estado: 'Estado' })
// Dimensiones adicionales a la severidad con su nombre en la interfaz («Entidad: Norte»), nunca la clave técnica.
export function contextLabel(dimensions) {
  return Object.entries(dimensions).filter(([key]) => key !== 'nivel_severidad').sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${DIMENSION_LABELS[key] || key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, ' ')}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
    .join(' · ') || 'Sin dimensiones adicionales'
}

export function exposureContextKey(row) {
  return JSON.stringify(Object.entries(row.dimensions).filter(([key]) => key !== 'nivel_severidad').sort(([a], [b]) => a.localeCompare(b)))
}

export function hasCompleteExposurePartition(rows) {
  return rows.length === 3 && rows.every((row) => row.kpi_code === 'KPI-LI-01' && row.availability === 'DISPONIBLE' && row.value !== null)
    && SEVERITIES.every(({ key }) => rows.filter((row) => row.severity === key).length === 1)
    && rows.every((row) => row.period_start === rows[0].period_start && row.period_end === rows[0].period_end && exposureContextKey(row) === exposureContextKey(rows[0]))
}

export function litigationExposureViewModel(items) {
  const partitions = new Map()
  for (const item of items.filter((row) => row.kpi_code === 'KPI-LI-01').sort(byPeriod)) {
    const contextKey = exposureContextKey(item)
    const id = `${item.period_start}:${item.period_end}:${contextKey}`
    if (!partitions.has(id)) partitions.set(id, { ...periodRow(item), id, period_end: item.period_end, contextKey, contextText: contextLabel(item.dimensions), sources: [] })
    partitions.get(id).sources.push(item)
  }
  const rows = [...partitions.values()].map((row) => {
    const complete = hasCompleteExposurePartition(row.sources)
    const values = {}
    for (const { key } of SEVERITIES) {
      const selected = row.sources.filter((item) => item.severity === key)
      const item = selected.length === 1 ? selected[0] : null
      if (item) Object.assign(values, { [key]: chartNumber(item), [`${key}Raw`]: item.value, [`${key}Text`]: item.availability === 'NO_DISPONIBLE' ? 'No disponible' : formatCurrencyMXN(item.value), [`${key}Availability`]: item.availability })
      else values[`${key}Text`] = selected.length ? 'Observaciones no comparables' : 'Sin observación'
    }
    const totalRaw = complete ? sumDecimals(row.sources.map((item) => item.value)) : null
    return {
      ...row, ...values, complete,
      high: values.alto,
      highText: values.altoText,
      total: complete ? chartNumber({ availability: 'DISPONIBLE', value: totalRaw }) : undefined,
      totalRaw,
      totalText: complete ? formatCurrencyMXN(totalRaw) : 'No disponible',
    }
  })
  const contexts = new Map()
  for (const row of rows) {
    if (!contexts.has(row.contextKey)) contexts.set(row.contextKey, [])
    contexts.get(row.contextKey).push(row)
  }
  const traces = [...contexts.entries()].flatMap(([id, selected]) => {
    // Dos particiones simultáneas no justifican asociarlas arbitrariamente entre meses.
    const ambiguous = new Set(selected.map((row) => row.month)).size !== selected.length
    const groups = ambiguous ? selected.map((row) => [row]) : [selected]
    return groups.map((group, index) => ({ id: `${id}:${index}`, label: ambiguous ? `${group[0].contextText} · ${group[0].periodText}` : group[0].contextText, rows: monthlyTimeline(group) }))
  })
  return { rows, traces, hasTotal: rows.some((row) => row.complete), hasHigh: rows.some((row) => row.high !== undefined && row.high !== null) }
}

export function findingSeverity(dimensions) {
  const value = dimensions?.nivel_severidad
  return SEVERITIES.some(({ key }) => key === value) ? value : null
}

// Incidentes de incumplimiento (KPI-CN-03) por área y severidad del último periodo con observaciones dentro
// de la selección (DESIGN §16.4). No se suman periodos ni se presenta un total: cada celda es la observación
// recibida para esa área y severidad; la ausencia y «No disponible» se conservan como tales. Las áreas se
// ordenan de mayor a menor número de incidentes para responder «dónde se concentra».
export function incidentsByAreaViewModel(items) {
  const eligible = items.filter((item) => item.kpi_code === 'KPI-CN-03' && typeof item.dimensions?.area === 'string' && item.severity)
  if (!eligible.length) return { period: null, rows: [], series: [], unavailable: false }
  const period = eligible.reduce((latest, item) => item.period_start > latest ? item.period_start : latest, eligible[0].period_start)
  const current = eligible.filter((item) => item.period_start === period)
  const areas = [...new Set(current.map((item) => item.dimensions.area))].sort((a, b) => a.localeCompare(b, 'es'))
  const present = new Set()
  const rows = areas.map((area) => {
    const row = { id: area, area }
    for (const { key } of SEVERITIES) {
      const matches = current.filter((item) => item.dimensions.area === area && item.severity === key)
      if (matches.length !== 1) { row[`${key}Text`] = matches.length ? 'Observaciones no comparables' : 'Sin observación'; continue }
      const value = chartNumber(matches[0])
      if (value === null) { row[`${key}Text`] = 'No disponible'; continue }
      row[key] = value
      row[`${key}Text`] = formatDecimal(matches[0].value)
      present.add(key)
    }
    return row
  })
  // La suma por área solo ordena las barras; no se presenta como total (D-UX-7).
  const size = (row) => SEVERITIES.reduce((sum, { key }) => sum + (row[key] || 0), 0)
  rows.sort((a, b) => size(b) - size(a) || a.area.localeCompare(b.area, 'es'))
  return {
    period,
    periodText: current[0].periodText,
    allZero: present.size > 0 && rows.every((row) => size(row) === 0),
    rows,
    series: SEVERITIES.filter(({ key }) => present.has(key)),
    unavailable: !present.size && current.some((item) => item.availability === 'NO_DISPONIBLE'),
  }
}

// Volumen de asuntos (KPI-EO-01) como tabla Tipo de asunto × Estado del último periodo de la selección.
// Solo reordena valores recibidos: no suma celdas ni calcula totales. Si una celda tuviera más de una
// observación (otra dimensión no prevista), no se arma la tabla y se conserva el listado plano.
export function matterVolumePivot(items) {
  const rows = items.filter((row) => row.kpi_code === 'KPI-EO-01' && typeof row.dimensions?.tipo_asunto === 'string' && typeof row.dimensions?.estado === 'string')
  if (!rows.length) return null
  const latest = rows.reduce((max, row) => row.period_start > max ? row.period_start : max, rows[0].period_start)
  const current = rows.filter((row) => row.period_start === latest)
  if (current.some((row) => Object.keys(row.dimensions).some((key) => !['tipo_asunto', 'estado'].includes(key)))) return null
  const cells = new Map()
  for (const row of current) {
    const key = JSON.stringify([row.dimensions.tipo_asunto, row.dimensions.estado])
    if (cells.has(key)) return null
    cells.set(key, row.valueText)
  }
  const collator = new Intl.Collator('es-MX')
  const types = [...new Set(current.map((row) => row.dimensions.tipo_asunto))].sort(collator.compare)
  const states = [...new Set(current.map((row) => row.dimensions.estado))].sort(collator.compare)
  return { periodStart: latest, periodText: current[0].periodText, states, rows: types.map((type) => ({ id: type, type, values: Object.fromEntries(states.map((state) => [state, cells.get(JSON.stringify([type, state])) ?? null])) })) }
}

import { formatDecimal, formatTimestamp, roundDecimal, validDate } from './formatters.js'

// Política de fechas de la interfaz (DESIGN §16.2). Los nombres de mes son fijos para que la
// presentación no dependa de variantes de Intl («octubre de 2026», «sept.»).
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']
const MONTHS_SHORT = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']
const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado']
// Zona horaria del sistema (decisión del usuario, 2026-10-17): toda fecha y hora visible y todo «hoy» se
// expresan en hora de la Ciudad de México, sin depender de la zona configurada en el navegador.
export const BUSINESS_TIME_ZONE = 'America/Mexico_City'
export const BUSINESS_TIME_ZONE_LABEL = 'hora de la Ciudad de México'
// Reloj de la barra superior (USER_TIMESTAMP): «jueves, 16 oct 2026 · 10:42».
export function formatClock(date) {
  const { year, month, day, hour, minute } = zonedParts(date, BUSINESS_TIME_ZONE)
  const time = `${twoDigits(hour)}:${twoDigits(minute)}`
  const label = `${day} ${MONTHS_SHORT[month - 1]}`
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  return { long: `${WEEKDAYS[weekday]}, ${label} ${year} · ${time}`, short: `${label}, ${time}`, iso: `${year}-${twoDigits(month)}-${twoDigits(day)}T${time}` }
}

const validMonth = (value) => typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value)
const parts = (value) => value.split('-').map(Number)
const lastDay = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate()

// PERIOD_DATE de un mes: «octubre 2026»; corto para ejes: «oct 2026».
export function formatMonth(value, { short = false } = {}) {
  const month = validDate(value) ? value.slice(0, 7) : value
  if (!validMonth(month)) return '—'
  const [year, index] = parts(month)
  return `${(short ? MONTHS_SHORT : MONTHS)[index - 1]} ${year}`
}

// PERIOD_DATE de un rango de fechas jurídicas (sin conversión de zona).
export function formatPeriodRange(start, end) {
  if (!validDate(start) || !validDate(end) || start > end) return '—'
  const [y1, m1, d1] = parts(start); const [y2, m2, d2] = parts(end)
  if (d1 === 1 && d2 === lastDay(y2, m2)) {
    if (y1 === y2 && m1 === m2) return `${MONTHS[m1 - 1]} ${y1}`
    return y1 === y2 ? `${MONTHS[m1 - 1]} – ${MONTHS[m2 - 1]} ${y2}` : `${MONTHS[m1 - 1]} ${y1} – ${MONTHS[m2 - 1]} ${y2}`
  }
  if (start === end) return formatDocumentDate(start)
  if (y1 === y2 && m1 === m2) return `${d1} – ${d2} ${MONTHS_SHORT[m2 - 1]} ${y2}`
  return y1 === y2 ? `${d1} ${MONTHS_SHORT[m1 - 1]} – ${d2} ${MONTHS_SHORT[m2 - 1]} ${y2}` : `${formatDocumentDate(start)} – ${formatDocumentDate(end)}`
}

// DOCUMENT_DATE / date-only: se preserva la fecha exacta, sin pasar por Date ni zona horaria.
export function formatDocumentDate(value) {
  if (!validDate(value)) return '—'
  const [year, month, day] = parts(value)
  return `${day} ${MONTHS_SHORT[month - 1]} ${year}`
}

const validTimestamp = (value) => formatTimestamp(value) !== '—'
const twoDigits = (value) => String(value).padStart(2, '0')

function zonedParts(value, timeZone) {
  const fields = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' })
    .formatToParts(new Date(value)).filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]))
  return fields
}

// USER_TIMESTAMP: hora de la Ciudad de México, formato único y sin zona visible.
export function formatUserTimestamp(value) {
  if (!validTimestamp(value)) return '—'
  const { year, month, day, hour, minute } = zonedParts(value, BUSINESS_TIME_ZONE)
  return `${day} ${MONTHS_SHORT[month - 1]} ${year}, ${twoDigits(hour)}:${twoDigits(minute)}`
}

// AUDIT_TIMESTAMP: precisión de segundos y zona explícita (hora de la Ciudad de México).
export function formatAuditTimestamp(value) {
  if (!validTimestamp(value)) return '—'
  const { year, month, day, hour, minute, second } = zonedParts(value, BUSINESS_TIME_ZONE)
  return `${day} ${MONTHS_SHORT[month - 1]} ${year}, ${twoDigits(hour)}:${twoDigits(minute)}:${twoDigits(second)} (${BUSINESS_TIME_ZONE_LABEL})`
}

// Unidades del catálogo KPI en singular para cantidades iguales a uno.
const SINGULAR = Object.freeze({ contratos: 'contrato', litigios: 'litigio', obligaciones: 'obligación', incidentes: 'incidente', asuntos: 'asunto', días: 'día' })
const isOne = (value) => /^-?1(?:\.0+)?$/.test(String(value))

// Valor con su unidad, sin convertir ausencia en cero: «7 contratos», «$550,000 MXN», «13.6 días».
export function formatQuantity(value, unit, { signed = false } = {}) {
  if (value === null || value === undefined) return 'No disponible'
  const text = unit === 'días' ? roundDecimal(String(value)) : String(value)
  const sign = signed && !text.startsWith('-') && !/^0+(?:\.0+)?$/.test(text) ? '+' : ''
  if (unit === 'importe') {
    const formatted = formatDecimal(text.replace(/^-/, ''), { prefix: '$', suffix: ' MXN' })
    return formatted === 'No disponible' ? formatted : `${text.startsWith('-') ? '−' : sign}${formatted}`
  }
  const number = formatDecimal(text)
  if (number === 'No disponible') return number
  const label = isOne(text) ? SINGULAR[unit] || unit : unit
  return `${sign}${number}${label ? ` ${label}` : ''}`
}

// Filtros por fecha: el selector entrega un día de la Ciudad de México; el contrato exige marca de tiempo
// con zona. Se envía el inicio (o fin) de ese día con el desplazamiento de esa zona en esa fecha.
// Rango de días para chips de filtro: «1 oct 2026 – 15 oct 2026», «desde …» o «hasta …».
export function formatDayRange(from, to) {
  if (from && to) return `${formatDocumentDate(from)} – ${formatDocumentDate(to)}`
  return from ? `desde ${formatDocumentDate(from)}` : `hasta ${formatDocumentDate(to)}`
}
export function localDayBoundary(date, { end = false } = {}) {
  if (!validDate(date)) return ''
  const [year, month, day] = parts(date)
  const offset = zoneOffsetMinutes(year, month, day, end ? 23 : 0, end ? 59 : 0, end ? 59 : 0)
  const sign = offset >= 0 ? '+' : '-'
  return `${date}T${end ? '23:59:59' : '00:00:00'}${sign}${twoDigits(Math.floor(Math.abs(offset) / 60))}:${twoDigits(Math.abs(offset) % 60)}`
}

// Desplazamiento (minutos) de la zona del sistema para una hora de pared de esa zona.
function zoneOffsetMinutes(year, month, day, hour, minute, second) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second)
  const shown = zonedParts(guess, BUSINESS_TIME_ZONE)
  const offset = (Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute, shown.second) - guess) / 60000
  // Segunda pasada: la hora de pared pedida se evalúa con el desplazamiento vigente en ese instante.
  const exact = zonedParts(guess - offset * 60000, BUSINESS_TIME_ZONE)
  return (Date.UTC(exact.year, exact.month - 1, exact.day, exact.hour, exact.minute, exact.second) - (guess - offset * 60000)) / 60000
}

// Rangos rápidos en días de la Ciudad de México; «Últimos 7 días» incluye hoy.
export function quickRanges(now = new Date()) {
  const current = zonedParts(now, BUSINESS_TIME_ZONE)
  const day = (date) => `${date.getUTCFullYear()}-${twoDigits(date.getUTCMonth() + 1)}-${twoDigits(date.getUTCDate())}`
  const back = (days) => new Date(Date.UTC(current.year, current.month - 1, current.day - days))
  const today = day(back(0))
  return [
    { value: 'today', label: 'Hoy', from: today, to: today },
    { value: 'last_7', label: 'Últimos 7 días', from: day(back(6)), to: today },
    { value: 'last_30', label: 'Últimos 30 días', from: day(back(29)), to: today },
    { value: 'this_month', label: 'Este mes', from: day(new Date(Date.UTC(current.year, current.month - 1, 1))), to: today },
  ]
}
// Día de la Ciudad de México (AAAA-MM-DD) de una marca de tiempo, para volver a mostrarla en el selector de fecha.
export function localDayOf(value) {
  if (!validTimestamp(value)) return ''
  const { year, month, day } = zonedParts(value, BUSINESS_TIME_ZONE)
  return `${year}-${twoDigits(month)}-${twoDigits(day)}`
}

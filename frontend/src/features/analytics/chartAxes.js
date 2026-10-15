import { formatDecimal, roundDecimal } from '../../shared/formatters.js'
import { formatMonth } from '../../shared/presentation.js'
import { formatCompactCurrencyMXN, formatPercentage } from './viewModels.js'

export const AXIS_UNITS = Object.freeze({ COUNT: 'COUNT', DAYS: 'DAYS', MXN: 'MXN', PERCENTAGE: 'PERCENTAGE' })

// Techo «redondo» del eje (múltiplo de 1, 2 o 5 × 10^n) para que el tick superior no sea un valor
// arbitrario como «14.96 d». El margen superior conserva espacio sobre el máximo real.
// COUNT conserva su algoritmo aprobado (paso ≤ un cuarto del rango); días y MXN usan el paso redondo
// inmediatamente superior para no saturar el eje (p. ej. MXN en pasos de $0.5 M, no de $0.2 M).
function niceScale(maximum, minimumStep, { coarse = false } = {}) {
  const headroom = maximum + Math.max(minimumStep, maximum * 0.1)
  const target = Math.max(minimumStep, headroom / 4)
  const magnitude = 10 ** Math.floor(Math.log10(target))
  const step = magnitude * (coarse ? [1, 2, 5, 10].find((factor) => factor * magnitude >= target) : [5, 2, 1].find((factor) => factor * magnitude <= target) || 1)
  const ceiling = Math.ceil(headroom / step) * step
  return { domain: [0, ceiling], ticks: Array.from({ length: Math.round(ceiling / step) + 1 }, (_, index) => Number((index * step).toPrecision(12))) }
}

// Mes del eje X (AAAA-MM) en el formato de periodo de la interfaz: «oct 2026».
export const monthTick = (value) => formatMonth(value, { short: true })

export function chartAxisConfig(unit, values = []) {
  const maximum = Math.max(0, ...values.filter((value) => typeof value === 'number' && Number.isFinite(value)))
  if (unit === AXIS_UNITS.COUNT) return { ...niceScale(maximum, 1), allowDecimals: false, tickFormatter: (value) => formatDecimal(String(value)) }
  if (unit === AXIS_UNITS.PERCENTAGE) return { domain: [0, 100], allowDecimals: true, tickFormatter: formatPercentage }
  if (unit === AXIS_UNITS.DAYS) return { ...niceScale(maximum, 1, { coarse: true }), allowDecimals: true, tickFormatter: (value) => `${formatDecimal(roundDecimal(String(value)))} d` }
  return { ...(maximum > 0 ? niceScale(maximum, maximum / 100, { coarse: true }) : { domain: [0, 1] }), allowDecimals: true, tickFormatter: formatCompactCurrencyMXN }
}

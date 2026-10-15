import { formatMonth, formatQuantity } from '../../shared/presentation.js'
import { dimensionsLabel, KPI_CATALOG } from './adapters.js'

// Presentación humana de un hallazgo (DESIGN §16.1). Se construye solo con campos estructurados del
// contrato y formateadores deterministas por regla; el texto persistido no se reinterpreta y queda para
// el Detalle técnico. Una regla no catalogada o incoherente con su indicador usa un fallback seguro.
const RULES = Object.freeze({
  RC03_APPEARANCE_OR_INCREASE: { kpi: 'KPI-RC-03', kind: 'APPEARANCE', subject: 'contratos próximos a vencimiento sin revisión', article: 'los' },
  CN02_APPEARANCE_OR_INCREASE: { kpi: 'KPI-CN-02', kind: 'APPEARANCE', subject: 'obligaciones regulatorias vencidas sin atender', article: 'las' },
  LI01_STRICT_THREE_MONTH_INCREASE: { kpi: 'KPI-LI-01', kind: 'THREE_MONTH', title: 'La exposición por litigios activos aumentó durante tres meses consecutivos', amount: true },
  LI05_STRICT_THREE_MONTH_INCREASE: { kpi: 'KPI-LI-05', kind: 'THREE_MONTH', title: 'Los nuevos litigios aumentaron durante tres meses consecutivos' },
  CN03_STRICT_THREE_MONTH_INCREASE: { kpi: 'KPI-CN-03', kind: 'THREE_MONTH', title: 'Los incidentes de incumplimiento aumentaron durante tres meses consecutivos' },
})

const decimal = (value) => typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value)
const isZero = (value) => /^-?0+(?:\.0+)?$/.test(value)
const isOne = (value) => /^1(?:\.0+)?$/.test(value)

export function recurrenceText(pattern) {
  const match = /^([0-4])_OF_4$/.exec(pattern ?? '')
  return match ? `Este comportamiento se observó en ${match[1]} de los últimos 4 meses.` : null
}

// Mes evaluado: el de la evaluación enlazada; si no existe, el mes en que termina el periodo del hallazgo.
export function evaluatedMonth(finding, evaluations = []) {
  const evaluation = evaluations.find((item) => item.id === finding.proactive_evaluation_id)
  return (evaluation?.evaluation_period || finding.period_end || '').slice(0, 7)
}

export function describeFinding(finding, evaluations = []) {
  const catalog = KPI_CATALOG[finding.kpi_code]
  const name = catalog?.name || 'indicador'
  const unit = catalog?.unit
  const month = evaluatedMonth(finding, evaluations)
  const values = {
    current: formatQuantity(finding.current_value, unit),
    reference: formatQuantity(finding.reference_value, unit),
    variation: formatQuantity(finding.variation, unit, { signed: true }),
  }
  const base = { name, month, monthText: formatMonth(month), scope: dimensionsLabel(finding.dimensions || {}), values, recurrence: recurrenceText(finding.recurrent_pattern) }
  const rule = RULES[finding.triggered_rule]
  const coherent = rule && rule.kpi === finding.kpi_code && catalog && ['current_value', 'reference_value', 'variation'].every((key) => decimal(finding[key])) && base.monthText !== '—'
  if (!coherent) return { ...base, known: false, title: `Alerta de ${name.charAt(0).toLowerCase()}${name.slice(1)}`, sentence: null }
  const title = rule.kind === 'APPEARANCE'
    ? (isZero(finding.reference_value) ? `Aparecieron ${rule.subject}` : `Aumentaron ${rule.article} ${rule.subject}`)
    : rule.title
  const verb = rule.amount ? 'la exposición fue de' : isOne(finding.current_value) ? 'se registró' : 'se registraron'
  const sentence = `En ${base.monthText} ${verb} ${values.current}, frente a ${values.reference} en el valor de referencia del análisis (${values.variation}).`
  return { ...base, known: true, title, sentence }
}

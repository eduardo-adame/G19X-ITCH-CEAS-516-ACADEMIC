import { describe, expect, it } from 'vitest'
import { formatAuditTimestamp, formatDocumentDate, formatMonth, formatPeriodRange, formatQuantity, formatUserTimestamp, localDayBoundary, localDayOf, quickRanges, formatClock } from '../src/shared/presentation.js'
import { auditActionLabel, familyLabel, quarantineCauseLabel, roleLabel, statusPresentation } from '../src/shared/labels.js'
import { describeFinding, evaluatedMonth, recurrenceText } from '../src/features/analytics/findingNarrative.js'

describe('SRS_REQUIRED: política de fechas DESIGN §16.2', () => {
  it('PERIOD_DATE: mes completo, rango de meses y años distintos sin «de» ni años de dos dígitos', () => {
    expect(formatPeriodRange('2026-10-01', '2026-10-31')).toBe('octubre 2026')
    expect(formatPeriodRange('2026-05-01', '2026-10-31')).toBe('mayo – octubre 2026')
    expect(formatPeriodRange('2025-11-01', '2026-01-31')).toBe('noviembre 2025 – enero 2026')
    expect(formatMonth('2026-10')).toBe('octubre 2026')
    expect(formatMonth('2026-09-01', { short: true })).toBe('sep 2026')
  })
  it('PERIOD_DATE: un rango que no coincide con meses completos conserva los días exactos', () => {
    expect(formatPeriodRange('2026-10-03', '2026-10-17')).toBe('3 – 17 oct 2026')
    expect(formatPeriodRange('2026-09-28', '2026-10-03')).toBe('28 sep – 3 oct 2026')
    expect(formatPeriodRange('2026-10-31', '2026-10-01')).toBe('—')
  })
  it('DOCUMENT_DATE: la fecha jurídica no cambia por zona horaria', () => {
    expect(formatDocumentDate('2026-10-06')).toBe('6 oct 2026')
    expect(formatDocumentDate('2026-01-01')).toBe('1 ene 2026')
    expect(formatDocumentDate('2026-02-30')).toBe('—')
  })
  it('USER_TIMESTAMP sin «UTC» visible y AUDIT_TIMESTAMP con segundos y zona explícita', () => {
    expect(formatUserTimestamp('2026-10-13T04:06:12Z')).toMatch(/^\d{1,2} [a-z]{3} \d{4}, \d{2}:\d{2}$/)
    expect(formatUserTimestamp('2026-10-13T04:06:12Z')).not.toContain('UTC')
    // 04:06 UTC del 13 de octubre son las 22:06 del 12 de octubre en la Ciudad de México.
    expect(formatUserTimestamp('2026-10-13T04:06:12Z')).toBe('12 oct 2026, 22:06')
    expect(formatAuditTimestamp('2026-10-13T04:06:12Z')).toBe('12 oct 2026, 22:06:12 (hora de la Ciudad de México)')
    expect(formatUserTimestamp('no-es-fecha')).toBe('—')
  })
  it('filtros de fecha: el día local viaja con zona explícita y vuelve al mismo día', () => {
    const start = localDayBoundary('2030-02-01'); const end = localDayBoundary('2030-02-01', { end: true })
    expect(start).toMatch(/^2030-02-01T00:00:00[+-]\d{2}:\d{2}$/)
    expect(end).toMatch(/^2030-02-01T23:59:59[+-]\d{2}:\d{2}$/)
    expect(localDayOf(start)).toBe('2030-02-01')
    expect(localDayOf(end)).toBe('2030-02-01')
    expect(localDayBoundary('')).toBe('')
  })
})

describe('SRS_REQUIRED: cantidades con unidad sin convertir ausencia en cero (RF-078, RNF-005)', () => {
  it('null es «No disponible» y cero se conserva', () => {
    expect(formatQuantity(null, 'contratos')).toBe('No disponible')
    expect(formatQuantity('0', 'contratos')).toBe('0 contratos')
  })
  it('singular, importe en MXN, días redondeados y signo de variación', () => {
    expect(formatQuantity('1', 'contratos')).toBe('1 contrato')
    expect(formatQuantity('3', 'obligaciones')).toBe('3 obligaciones')
    expect(formatQuantity('550000', 'importe')).toBe('$550,000 MXN')
    expect(formatQuantity('18.33333333333333333333333333', 'días')).toBe('18.33 días')
    expect(formatQuantity('3', 'contratos', { signed: true })).toBe('+3 contratos')
    expect(formatQuantity('-2', 'litigios', { signed: true })).toBe('-2 litigios')
    expect(formatQuantity('0', 'litigios', { signed: true })).toBe('0 litigios')
    expect(formatQuantity('15000', 'importe', { signed: true })).toBe('+$15,000 MXN')
  })
})

describe('SRS_REQUIRED: hallazgo humanizado desde campos estructurados (DESIGN §16.1, RF-075)', () => {
  const base = { id: 'f', proactive_evaluation_id: 'e', kpi_code: 'KPI-RC-03', dimensions: {}, period_start: '2026-09-01', period_end: '2026-10-31', current_value: '7', reference_value: '4', variation: '3', triggered_rule: 'RC03_APPEARANCE_OR_INCREASE', recurrent_pattern: '3_OF_4', description: 'KPI-RC-03 registró una señal en 2026-10 para {}: …' }
  const evaluations = [{ id: 'e', evaluation_period: '2026-10-01' }]
  it('caso real canónico: incremento con recurrencia, sin códigos ni «{}»', () => {
    const view = describeFinding(base, evaluations)
    expect(view.known).toBe(true)
    expect(view.title).toBe('Aumentaron los contratos próximos a vencimiento sin revisión')
    expect(view.sentence).toBe('En octubre 2026 se registraron 7 contratos, frente a 4 contratos en el valor de referencia del análisis (+3 contratos).')
    expect(view.recurrence).toBe('Este comportamiento se observó en 3 de los últimos 4 meses.')
    expect(view.scope).toBe('')
    expect(JSON.stringify(view)).not.toMatch(/KPI-|RC03_|\{\}|_OF_4/)
  })
  it('aparición desde cero, singular y reglas de tres meses con importe', () => {
    expect(describeFinding({ ...base, current_value: '1', reference_value: '0', variation: '1' }, evaluations)).toMatchObject({ title: 'Aparecieron contratos próximos a vencimiento sin revisión', sentence: expect.stringContaining('se registró 1 contrato') })
    const exposure = describeFinding({ ...base, kpi_code: 'KPI-LI-01', triggered_rule: 'LI01_STRICT_THREE_MONTH_INCREASE', dimensions: { nivel_severidad: 'alto' }, current_value: '550000', reference_value: '500000', variation: '50000', recurrent_pattern: null }, evaluations)
    expect(exposure.title).toBe('La exposición por litigios activos aumentó durante tres meses consecutivos')
    expect(exposure.sentence).toBe('En octubre 2026 la exposición fue de $550,000 MXN, frente a $500,000 MXN en el valor de referencia del análisis (+$50,000 MXN).')
    expect(exposure.scope).toBe('Nivel de severidad: Alto')
    expect(exposure.recurrence).toBeNull()
  })
  it('regla desconocida o incoherente con el indicador usa fallback seguro sin inventar frase', () => {
    const unknown = describeFinding({ ...base, triggered_rule: 'REGLA_FUTURA' }, evaluations)
    expect(unknown).toMatchObject({ known: false, sentence: null, title: 'Alerta de contratos próximos a vencimiento sin revisión' })
    expect(describeFinding({ ...base, kpi_code: 'KPI-LI-05' }, evaluations)).toMatchObject({ known: false, sentence: null })
    expect(unknown.values.current).toBe('7 contratos')
  })
  it('mes evaluado: evaluación enlazada; sin ella, el mes final del hallazgo', () => {
    expect(evaluatedMonth(base, evaluations)).toBe('2026-10')
    expect(evaluatedMonth(base, [])).toBe('2026-10')
    expect(recurrenceText('3/4')).toBeNull()
    expect(recurrenceText('4_OF_4')).toBe('Este comportamiento se observó en 4 de los últimos 4 meses.')
  })
})

describe('ROBUSTNESS: rótulos de valores internos sin inventar', () => {
  it('traduce valores catalogados y devuelve tal cual los desconocidos', () => {
    expect(familyLabel('CONTRATOS_DOCUMENTOS')).toBe('Contratos y documentos')
    expect(roleLabel('JURIDICO')).toBe('Jurídico')
    expect(quarantineCauseLabel('MISSING_REQUIRED_FIELD')).toBe('Falta un campo obligatorio')
    expect(auditActionLabel('QUARANTINE_VIEW')).toBe('Consulta de cuarentena')
    expect(auditActionLabel('ACCION_NUEVA')).toBe('ACCION_NUEVA')
    expect(familyLabel(null)).toBeNull()
  })
  it('estados con semántica de sistema y fallback neutral', () => {
    expect(statusPresentation('quarantine', 'Pendiente')).toEqual({ label: 'Pendiente', variant: 'warning' })
    expect(statusPresentation('audit', 'DENIED')).toEqual({ label: 'Denegado', variant: 'critical' })
    expect(statusPresentation('processing', 'LISTA')).toEqual({ label: 'Listo', variant: 'success' })
    expect(statusPresentation('audit', 'OTRO')).toEqual({ label: 'OTRO', variant: 'neutral' })
  })
})

describe('SRS_REQUIRED: hora de la Ciudad de México en toda la interfaz (decisión del usuario, 2026-10-17)', () => {
  it('los filtros envían los límites del día con el desplazamiento de la Ciudad de México', () => {
    expect(localDayBoundary('2026-10-31')).toBe('2026-10-31T00:00:00-06:00')
    expect(localDayBoundary('2026-10-31', { end: true })).toBe('2026-10-31T23:59:59-06:00')
    expect(localDayOf('2026-11-01T02:00:00Z')).toBe('2026-10-31')
  })
  it('«Hoy» y «Este mes» se calculan con el día de la Ciudad de México aunque en UTC ya sea otro día', () => {
    const ranges = Object.fromEntries(quickRanges(new Date('2026-11-01T05:30:00Z')).map((range) => [range.value, range]))
    expect(ranges.today).toMatchObject({ from: '2026-10-31', to: '2026-10-31' })
    expect(ranges.this_month).toMatchObject({ from: '2026-10-01', to: '2026-10-31' })
    expect(ranges.last_7).toMatchObject({ from: '2026-10-25', to: '2026-10-31' })
  })
  it('el reloj de la barra superior muestra la hora de la Ciudad de México', () => {
    expect(formatClock(new Date('2026-10-18T05:17:00Z'))).toEqual({ long: 'sábado, 17 oct 2026 · 23:17', short: '17 oct, 23:17', iso: '2026-10-17T23:17' })
  })
})

import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { SessionProvider } from '../src/auth/SessionProvider.jsx'
import { AnalyticsPage } from '../src/features/analytics/pages.jsx'
import { formatPercentChange } from '../src/shared/presentation.js'

vi.mock('recharts', () => {
  const Pass = ({ children }) => <div>{children}</div>
  return { ResponsiveContainer: Pass, BarChart: Pass, LineChart: Pass, PieChart: Pass, Pie: () => null, Cell: () => null, LabelList: () => null, CartesianGrid: () => null, XAxis: () => null, YAxis: () => null, Tooltip: () => null, Legend: () => null, Bar: () => null, Line: () => null, ReferenceLine: () => null }
})

const runId = '11111111-1111-4111-8111-111111111111'
const evaluationId = '22222222-2222-4222-8222-222222222222'
const decreasingId = '55555555-5555-4555-8555-555555555555'
const findingId = '33333333-3333-4333-8333-333333333333'
const evaluation = (overrides) => ({ id: evaluationId, analytic_run_id: runId, kpi_code: 'KPI-CN-02', canonical_dimensions_key: {}, evaluation_period: '2026-09-01', outcome: 'EVALUATED', signal_detected: true, trend_direction: 'INCREASING', recurrence_month_count: 2, current_value: '5', reference_value: '3', absolute_variation: '2', percentage_variation: '66.66666666666666666666666667', rules_applied: ['CN02_APPEARANCE_OR_INCREASE'], not_evaluated_reason: null, entity_filter_applicable: false, ...overrides })
const analysis = {
  current_analytic_run_id: runId, alert_count: 1,
  items: [{ analytic_run_id: runId, completed_at: '2026-10-01T12:00:00Z', window_start: '2026-04-01T06:00:00Z', window_end: '2026-10-01T05:59:59Z', executive_summary: 'Resumen persistido de la ejecución.',
    evaluations: [evaluation(), evaluation({ id: decreasingId, kpi_code: 'KPI-LI-01', canonical_dimensions_key: { nivel_severidad: 'medio' }, signal_detected: false, trend_direction: 'DECREASING', current_value: '100000', reference_value: '200000', absolute_variation: '-100000', percentage_variation: '-50', rules_applied: ['LI01_STRICT_THREE_MONTH_INCREASE'] })],
    findings: [{ id: findingId, analytic_run_id: runId, proactive_evaluation_id: evaluationId, kpi_code: 'KPI-CN-02', dimensions: {}, period_start: '2026-08-01', period_end: '2026-09-30', current_value: '5', reference_value: '3', variation: '2', triggered_rule: 'CN02_APPEARANCE_OR_INCREASE', recurrent_pattern: null, description: 'Descripción sustentada.', created_at: '2026-10-01T12:00:00Z', entity_filter_applicable: false }],
    context_references: [] }],
}
const kpis = { period_start: '2026-10-01', period_end: '2026-10-31', period_reference: '2026-10-01', filters: { period: 'current_month', period_start: null, period_end: null, risk_type: 'all', entity: null }, items: [] }
function Where() { return <output aria-label="Dirección actual">{useLocation().search}</output> }
function fixture({ view = 'trends', search = '' } = {}) {
  const client = { acquireRead: vi.fn((path) => ({ promise: Promise.resolve(path.startsWith('/dashboard/kpis') ? kpis : analysis), release: vi.fn() })), request: vi.fn(), abortAll: vi.fn() }
  const snapshot = { status: 'authenticated', principal: { id: runId, username: 'cuenta-sintetica', roles: ['JURIDICO'] }, generation: 1 }
  const manager = { client, getSnapshot: () => snapshot, subscribe: () => () => {}, restore: vi.fn(), revalidate: vi.fn() }
  render(<SessionProvider manager={manager}><MemoryRouter initialEntries={[`/${search}`]}><AnalyticsPage view={view} /><Where /></MemoryRouter></SessionProvider>)
  return client
}
const analysisPaths = (client) => client.acquireRead.mock.calls.map(([path]) => path).filter((path) => path.startsWith('/dashboard/analysis'))

describe('ROBUSTNESS: correcciones de la certificación de Tendencias (2026-10-18)', () => {
  it('O-1: con el análisis vigente no hay selector de Periodo; al pasar a Histórico aparece y acota la lectura', async () => {
    const client = fixture()
    await screen.findByText('Análisis vigente')
    expect(screen.queryByLabelText('Periodo')).toBeNull()
    expect(analysisPaths(client).every((path) => !path.includes('period='))).toBe(true)
    await userEvent.selectOptions(screen.getByLabelText('Análisis', { selector: 'select' }), 'historical')
    await waitFor(() => expect(screen.getByLabelText('Dirección actual')).toHaveTextContent('analysis_mode=historical'))
    expect(screen.getByLabelText('Dirección actual')).toHaveTextContent('period=last_6_months')
    expect(screen.getByLabelText('Periodo')).toBeInTheDocument()
    await waitFor(() => expect(analysisPaths(client).at(-1)).toContain('period=last_6_months'))
  })
  it('O-1: un periodo antiguo en la dirección con análisis vigente no muestra chip ni selector', async () => {
    fixture({ search: '?analysis_mode=current&period=last_3_months' })
    await screen.findByText('Análisis vigente')
    expect(screen.queryByText('Periodo: Últimos 3 meses')).toBeNull()
    expect(screen.queryByLabelText('Periodo')).toBeNull()
  })
  it('O-1: las vistas con indicadores conservan su selector de Periodo', async () => {
    fixture({ view: 'summary' })
    expect(await screen.findByLabelText('Periodo')).toBeInTheDocument()
  })
  it('O-2: la tabla de evaluaciones informa la tendencia y la variación porcentual persistidas', async () => {
    fixture()
    const table = await screen.findByRole('table', { name: 'Evaluaciones del análisis' })
    expect(within(table).getByRole('columnheader', { name: 'Tendencia' })).toBeInTheDocument()
    expect(within(table).getByText('Creciente')).toBeInTheDocument()
    expect(within(table).getByText('Decreciente')).toBeInTheDocument()
    expect(within(table).getByText('+66.67 %')).toBeInTheDocument()
    expect(within(table).getByText('−50 %')).toBeInTheDocument()
  })
  it('O-2: la tarjeta del hallazgo muestra el porcentaje de su evaluación', async () => {
    fixture()
    const card = (await screen.findAllByRole('article'))[0]
    expect(within(card).getByText('+66.67 %')).toBeInTheDocument()
  })
  it('O-3: el resumen registrado se rotula como de la ejecución completa', async () => {
    fixture()
    expect(await screen.findByText('Resumen registrado de la ejecución completa (sin filtros)')).toBeInTheDocument()
  })
  it('O-2: la variación porcentual se formatea con signo y no inventa valores', () => {
    expect(formatPercentChange('66.66666666666666666666666667')).toBe('+66.67 %')
    expect(formatPercentChange('-25')).toBe('−25 %')
    expect(formatPercentChange('0')).toBe('0 %')
    expect(formatPercentChange(null)).toBeNull()
    expect(formatPercentChange('no-numérico')).toBeNull()
  })
})

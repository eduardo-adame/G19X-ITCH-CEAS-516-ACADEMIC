import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { SessionProvider } from '../src/auth/SessionProvider.jsx'
import { ApiError } from '../src/api/errors.js'
import { AnalyticsPage } from '../src/features/analytics/pages.jsx'
import { LitigationExposureChart, SeverityChart, TemporalChart } from '../src/features/analytics/charts.jsx'
import { adaptKpis, KPI_CATALOG } from '../src/features/analytics/adapters.js'
import { buildRegistry } from '../src/routing/registry.jsx'
import * as analytics from '../src/features/analytics/routes.jsx'

// Aislar el render SVG: la geometría real se verifica en la revisión visual.
vi.mock('recharts', () => {
  const Container = ({ children }) => <div>{children}</div>
  const Graph = ({ data, children }) => <div data-testid="chart" data-points={JSON.stringify(data)}>{children}</div>
  const Plot = ({ data, dataKey, connectNulls, type }) => <span data-testid="plot" data-points={data ? JSON.stringify(data) : undefined} data-key={dataKey} data-connect={String(connectNulls)} data-type={type} />
  return { ResponsiveContainer: Container, BarChart: Graph, LineChart: Graph, PieChart: Graph, Pie: Plot, Cell: () => null, LabelList: () => null, CartesianGrid: () => null, XAxis: () => null, YAxis: () => null, Tooltip: () => null, Line: Plot, Bar: Plot }
})
const runId = '11111111-1111-4111-8111-111111111111'
const contextId = '44444444-4444-4444-8444-444444444444'
function observation(code = 'KPI-RC-03', overrides = {}) {
  return { kpi_code: code, name: KPI_CATALOG[code].name, unit: KPI_CATALOG[code].unit, classification: KPI_CATALOG[code].core ? 'MVP-NÚCLEO' : 'MVP-COMPLEMENTARIO', period_start: '2030-01-01', period_end: '2030-01-31', as_of_date: '2030-01-31', calculated_at: '2030-02-01T00:00:00Z', dimensions: {}, entity_filter_applicable: false, availability: 'DISPONIBLE', value: '0', ...overrides }
}
const kpiPage = (items = [observation()]) => ({ period_start: '2029-08-01', period_end: '2030-01-31', period_reference: '2030-01-01', filters: { period: 'last_6_months', period_start: null, period_end: null, risk_type: 'all', entity: null }, items })
function analysisPage(withFinding = false) {
  const evaluationId = '22222222-2222-4222-8222-222222222222'; const findingId = '33333333-3333-4333-8333-333333333333'
  return { current_analytic_run_id: runId, alert_count: withFinding ? 1 : 0, items: [{ analytic_run_id: runId, completed_at: '2030-02-01T00:00:00Z', window_start: '2029-08-01T00:00:00Z', window_end: '2030-01-31T23:59:59Z', executive_summary: withFinding ? 'Resumen sintético persistido.' : 'Análisis completado sin hallazgos.', evaluations: [{ id: evaluationId, analytic_run_id: runId, kpi_code: 'KPI-RC-03', canonical_dimensions_key: {}, evaluation_period: '2030-01-01', outcome: 'EVALUATED', signal_detected: withFinding, trend_direction: null, recurrence_month_count: 3, current_value: withFinding ? '2' : '0', reference_value: '0', absolute_variation: withFinding ? '2' : '0', percentage_variation: null, rules_applied: ['RC03_APPEARANCE_OR_INCREASE'], not_evaluated_reason: null, entity_filter_applicable: false }], findings: withFinding ? [{ id: findingId, analytic_run_id: runId, proactive_evaluation_id: evaluationId, kpi_code: 'KPI-RC-03', dimensions: {}, period_start: '2029-12-01', period_end: '2030-01-31', current_value: '2', reference_value: '0', variation: '2', triggered_rule: 'RC03_APPEARANCE_OR_INCREASE', recurrent_pattern: '3/4', description: 'Descripción sintética sustentada.', created_at: '2030-02-01T00:00:00Z', entity_filter_applicable: false }] : [], context_references: withFinding ? [{ id: contextId, finding_id: findingId, kpi_code: 'KPI-RC-03', dimensions: {}, period_start: '2029-12-01', period_end: '2030-01-31', context_identifiers: {}, operation_id: runId, correlation_id: runId }] : [] }] }
}
function LocationControls() {
  const location = useLocation(); const navigate = useNavigate()
  return <><output aria-label="Dirección actual">{location.search}</output><button onClick={() => navigate(-1)}>Atrás de prueba</button><button onClick={() => navigate(1)}>Adelante de prueba</button></>
}
function fixture({ search = '', view = 'summary', kpis = kpiPage(), analysis = analysisPage(), error = null, pending = false, roles = ['JURIDICO'] } = {}) {
  const client = { acquireRead: vi.fn((path) => ({ promise: pending ? new Promise(() => {}) : error ? Promise.reject(new ApiError(error)) : Promise.resolve(path.startsWith('/dashboard/kpis') ? kpis : analysis), release: vi.fn() })), abortAll: vi.fn() }
  const snapshot = { status: 'authenticated', principal: { id: runId, username: 'cuenta-sintetica', roles }, generation: 1 }
  const manager = { client, getSnapshot: () => snapshot, subscribe: () => () => {}, restore: vi.fn(), revalidate: vi.fn() }
  render(<SessionProvider manager={manager}><MemoryRouter initialEntries={[`/${search}`]}><AnalyticsPage view={view} /><LocationControls /></MemoryRouter></SessionProvider>)
  return client
}
describe('SRS_REQUIRED: cuatro vistas analíticas', () => {
  it('ROBUSTNESS: cada indicador tiene su definición y en el resumen abre su vista con el mismo periodo', async () => {
    fixture({ search: '?period=last_3_months&risk_type=all' })
    const contracts = await screen.findByRole('link', { name: 'Contratos próximos a vencimiento sin revisión (ver en Riesgo contractual)' })
    expect(contracts).toHaveAttribute('href', '/contratos?period=last_3_months')
    expect(screen.getAllByRole('link', { name: /\(ver en Gestión de litigios\)$/ }).map((link) => link.getAttribute('href'))).toEqual(['/litigios?period=last_3_months', '/litigios?period=last_3_months'])
    // Cumplimiento no tiene vista propia: su título no es enlace.
    expect(screen.queryByRole('link', { name: /Obligaciones regulatorias/ })).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /^Qué mide: / })).toHaveLength(5)
    fireEvent.click(screen.getByRole('button', { name: 'Qué mide: Obligaciones regulatorias vencidas sin atender' }))
    expect(screen.getByRole('note')).toHaveTextContent('fecha límite ya pasó sin evidencia de cumplimiento')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('note')).not.toBeInTheDocument()
  })
  it('ROBUSTNESS: «Entidad: No aplicable» explica por qué en su ayuda', async () => {
    fixture({ view: 'contracts' })
    const entity = await screen.findByTestId('entity-not-applicable')
    fireEvent.click(within(entity).getByRole('button', { name: 'Por qué la entidad no aplica' }))
    expect(screen.getByRole('note')).toHaveTextContent('no se desglosan por entidad')
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('note')).not.toBeInTheDocument()
  })
  it.each([['summary', 'Resumen ejecutivo'], ['contracts', 'Riesgo contractual'], ['litigation', 'Gestión de litigios'], ['trends', 'Tendencias y riesgos']])('encabeza %s y usa API física', async (view, title) => {
    const client = fixture({ view }); expect(screen.getByRole('heading', { name: title })).toBeVisible()
    expect(await screen.findByText(/^Sin alertas (en el análisis|de riesgo)/)).toBeVisible()
    // El texto registrado del análisis queda en «Detalle técnico», sin mostrarse como lectura principal (D-UX-1).
    expect(await screen.findByText('Análisis completado sin hallazgos.')).not.toBeVisible()
    expect(screen.getByRole('table', { name: 'Evaluaciones del análisis' })).toBeVisible()
    expect(client.acquireRead.mock.calls.every(([path]) => /^\/dashboard\/(kpis|analysis)\?/.test(path))).toBe(true)
  })
  it('muestra KPI/contextos, diferencia cero de no disponible y limita moneda a exposición', async () => {
    fixture({ kpis: kpiPage(Object.keys(KPI_CATALOG).map((code) => observation(code, code === 'KPI-RC-01' ? { availability: 'NO_DISPONIBLE', value: null } : code === 'KPI-LI-01' ? { dimensions: { nivel_severidad: 'alto' }, value: '17.50' } : {}))) })
    expect(await screen.findByRole('heading', { name: 'Contexto operativo' })).toBeVisible()
    expect(screen.getByRole('table', { name: 'Datos de los indicadores' })).toBeVisible()
    expect(screen.getAllByText('No disponible').length).toBeGreaterThan(0)
    expect(screen.getAllByText('0 contratos').length).toBeGreaterThan(0)
    expect(screen.getAllByText(/MXN|\$/).length).toBeGreaterThan(0)
    expect(screen.getByText('Entidad: No aplicable')).toBeVisible()
    expect(screen.queryAllByRole('columnheader', { name: 'Entidad' })).toHaveLength(0)
    expect(document.body.textContent).not.toContain('KPI-RC-03')
  })
  it('mantiene geometría KPI estable y conserva el decimal dimensional en las tablas', async () => {
    fixture({ kpis: kpiPage([
      observation('KPI-LI-01', { dimensions: { nivel_severidad: 'alto' }, value: '12.5000', calculated_at: '2030-02-01T01:02:03Z' }),
      observation('KPI-LI-01', { dimensions: { nivel_severidad: 'medio' }, value: '0.000000000000000001', calculated_at: '2030-02-02T04:05:06Z' }),
    ]) })
    expect((await screen.findAllByText('$12.5000 MXN')).length).toBeGreaterThan(0)
    expect(screen.getAllByText('$0.000000000000000001 MXN').length).toBeGreaterThan(0)
    expect(screen.getByText('Desglose disponible')).toBeVisible()
    expect(screen.getByText('Desglose por severidad en gráfica y tabla')).toBeVisible()
  })
  it('muestra backend alert_count y contexto RF048 sin seleccionar documentos', async () => {
    fixture({ analysis: analysisPage(true) })
    expect(await screen.findByText('1 alerta')).toBeVisible()
    const link = screen.getByRole('link', { name: 'Verificar evidencia documental' })
    expect(link).toHaveAttribute('href', `/consulta?context_reference_id=${contextId}`)
    expect(screen.getByText('Resumen sintético persistido.')).toBeInTheDocument()
    expect(screen.getByText('Resumen sintético persistido.')).not.toBeVisible()
    expect(screen.getByText('3/4')).toBeInTheDocument()
    expect(screen.queryByText(/se observó en/)).not.toBeInTheDocument()
  })
  it('normaliza nivel_severidad canónico del hallazgo y muestra su badge', async () => {
    const payload = analysisPage(true)
    const run = payload.items[0]
    run.evaluations[0].kpi_code = 'KPI-LI-01'
    run.evaluations[0].canonical_dimensions_key = { nivel_severidad: 'alto' }
    run.findings[0].kpi_code = 'KPI-LI-01'
    run.findings[0].dimensions = { nivel_severidad: 'alto' }
    run.context_references[0].kpi_code = 'KPI-LI-01'
    run.context_references[0].dimensions = { nivel_severidad: 'alto' }
    fixture({ view: 'trends', analysis: payload })
    expect(await screen.findByText('Alto')).toBeVisible()
    expect(screen.getByRole('article')).toHaveTextContent('Descripción sintética sustentada.')
    expect(screen.getByRole('article')).toHaveTextContent('Nivel de severidad: Alto')
    expect(screen.getByRole('article')).toHaveTextContent('Alerta de exposición total por litigios activos')
    expect(screen.queryAllByTestId('chart')).toHaveLength(0)
  })
  it('F-12: recurrencia estructurada legible y narrativa histórica persistida sin reescribir', async () => {
    const payload = analysisPage(true)
    payload.items[0].findings[0].recurrent_pattern = '3_OF_4'
    const legacy = 'KPI-RC-03 registró una señal en 2026-10 para {}: regla RC03_APPEARANCE_OR_INCREASE, recurrencia 3/4.'
    payload.items[0].findings[0].description = legacy
    fixture({ view: 'trends', analysis: payload })
    expect(await screen.findByText('1 alerta')).toBeVisible()
    expect(screen.getByText('Este comportamiento se observó en 3 de los últimos 4 meses.')).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Aparecieron contratos próximos a vencimiento sin revisión' })).toBeVisible()
    expect(screen.getByText('En enero 2030 se registraron 2 contratos, frente a 0 contratos en el valor de referencia del análisis (+2 contratos).')).toBeVisible()
    expect(screen.getByText(legacy)).toBeInTheDocument()
    expect(screen.getByText(legacy)).not.toBeVisible()
    expect(screen.queryByText(/3_OF_4/)).not.toBeInTheDocument()
  })
  it('UX-052: con filtro de riesgo no afirma que la ejecución no produjo señales', async () => {
    const payload = analysisPage(false)
    payload.items[0].executive_summary = 'KPI-RC-03 registró una señal en 2026-10 para {}: valor actual 7, referencia 4.'
    fixture({ view: 'litigation', analysis: payload })
    expect(await screen.findByText('Sin alertas de riesgo de litigio en el análisis')).toBeVisible()
    expect(screen.getByRole('link', { name: 'Ver todas las alertas' })).toHaveAttribute('href', '/')
    expect(screen.queryByText(/no produjo señales/)).not.toBeInTheDocument()
    expect(await screen.findByText(payload.items[0].executive_summary)).not.toBeVisible()
  })
  it('el Resumen ignora parámetros antiguos de análisis histórico y muestra las alertas vigentes bajo los KPI', async () => {
    const client = fixture({ search: `?period=last_6_months&analysis_mode=historical&analytic_run_id=${runId}`, analysis: analysisPage(true) })
    await screen.findByText('1 alerta')
    expect(client.acquireRead.mock.calls.filter(([path]) => path.startsWith('/dashboard/analysis')).every(([path]) => path === '/dashboard/analysis?risk_type=all')).toBe(true)
    const kpis = screen.getByLabelText('Indicadores principales'); const alerts = screen.getByRole('heading', { name: 'Requiere atención' })
    const concentration = screen.getByRole('heading', { name: 'Dónde se concentra' })
    expect(kpis.compareDocumentPosition(alerts) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(alerts.compareDocumentPosition(concentration) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
  it('la evolución pide sus propios últimos 6 meses aunque el periodo sea el mes en curso', async () => {
    const client = fixture({ view: 'contracts', kpis: kpiPage([observation('KPI-RC-01', { value: '13.6' })]) })
    expect(await screen.findByText('Historia insuficiente para mostrar una evolución')).toBeVisible()
    expect(client.acquireRead.mock.calls.some(([path]) => path === '/dashboard/kpis?period=current_month&risk_type=contractual')).toBe(true)
    expect(client.acquireRead.mock.calls.some(([path]) => path === '/dashboard/kpis?period=last_6_months&risk_type=contractual')).toBe(true)
    const windows = screen.getByRole('group', { name: 'Ventana de la evolución' })
    expect(within(windows).getByRole('button', { name: 'Últimos 6 meses' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('Meses cerrados: agosto 2029 – enero 2030')).toBeVisible()
    expect(screen.getByText('Solo hay datos de enero 2030: 13.6 días.')).toBeVisible()
    expect(screen.queryAllByTestId('chart')).toHaveLength(0)
  })
  it('con historia insuficiente en 6 meses la gráfica amplía solo la evolución a 12 meses', async () => {
    const client = fixture({ view: 'contracts', kpis: kpiPage([observation('KPI-RC-01', { value: '13.6' })]) })
    await userEvent.click(await screen.findByRole('button', { name: 'Ver últimos 12 meses' }))
    await waitFor(() => expect(client.acquireRead.mock.calls.some(([path]) => path === '/dashboard/kpis?period=last_12_months&risk_type=contractual')).toBe(true))
    // La ventana de evolución no altera el filtro «Periodo» de la dirección.
    expect(screen.getByLabelText('Dirección actual').textContent).not.toContain('period=')
    expect(await screen.findByText('No hay más meses con datos dentro de la selección.')).toBeVisible()
    expect(screen.queryByRole('button', { name: /Ver últimos 12/ })).not.toBeInTheDocument()
    expect(within(screen.getByRole('group', { name: 'Ventana de la evolución' })).getByRole('button', { name: 'Últimos 12 meses' })).toHaveAttribute('aria-pressed', 'true')
  })
  it('si la selección ya es de 6 meses la evolución reutiliza la misma lectura', async () => {
    const client = fixture({ view: 'contracts', search: '?period=last_6_months', kpis: kpiPage([observation('KPI-RC-01', { value: '13.6' })]) })
    await screen.findByText('Historia insuficiente para mostrar una evolución')
    expect(client.acquireRead.mock.calls.filter(([path]) => path.startsWith('/dashboard/kpis')).map(([path]) => path)).toEqual(['/dashboard/kpis?period=last_6_months&risk_type=contractual'])
  })
  it('Litigios muestra solo el contexto de asuntos litigiosos y Contratos el contractual', async () => {
    const items = [observation('KPI-RC-01', { value: '5' }), observation('KPI-EO-01', { dimensions: { tipo_asunto: 'Litigio', estado: 'Abierto' }, value: '2' }), observation('KPI-EO-01', { dimensions: { tipo_asunto: 'Contrato', estado: 'Vigente' }, value: '3' })]
    fixture({ view: 'litigation', kpis: kpiPage(items) })
    expect(await screen.findByRole('heading', { name: 'Contexto operativo' })).toBeVisible()
    const volume = screen.getByRole('table', { name: 'Volumen de asuntos por tipo y estado' })
    expect(volume).toHaveTextContent('Litigio')
    expect(volume).not.toHaveTextContent('Contrato')
    expect(screen.queryByRole('table', { name: 'Datos del contexto operativo' })).not.toBeInTheDocument()
    expect(document.querySelector('details.data-section')).toBeNull()
  })
  it('regresión: un mes en curso (datos al día de hoy) se presenta en la tabla sin romper la vista', async () => {
    fixture({ kpis: kpiPage([observation('KPI-RC-03', { period_start: '2030-01-01', period_end: '2030-01-31', as_of_date: '2030-01-15', value: '2' })]) })
    const table = await screen.findByRole('table', { name: 'Datos de los indicadores' })
    expect(table).toHaveTextContent('enero 2030 (al 15 ene 2030)')
    expect(screen.getByRole('heading', { name: 'Resumen ejecutivo' })).toBeVisible()
  })
  it('evaluaciones: reglas comunes una vez sobre la tabla, regla propia breve por fila y mes único en la ficha', async () => {
    const payload = analysisPage(true)
    const base = payload.items[0].evaluations[0]
    base.rules_applied = ['RC03_APPEARANCE_OR_INCREASE', 'TREND_STRICT_THREE_MONTH', 'RECURRENCE_THREE_OF_FOUR']
    payload.items[0].evaluations.push({ ...base, id: '66666666-6666-4666-8666-666666666666', kpi_code: 'KPI-LI-05', signal_detected: false, rules_applied: ['LI05_STRICT_THREE_MONTH_INCREASE', 'TREND_STRICT_THREE_MONTH', 'RECURRENCE_THREE_OF_FOUR'] })
    fixture({ analysis: payload })
    const table = await screen.findByRole('table', { name: 'Evaluaciones del análisis' })
    expect(screen.getByText('Reglas aplicadas a todos los indicadores: Tendencia de tres meses consecutivos; Recurrencia en 3 de los últimos 4 meses.')).toBeVisible()
    expect(within(table).getByRole('columnheader', { name: 'Regla del indicador' })).toBeVisible()
    expect(within(table).getByText('Aparición o aumento')).toBeVisible()
    expect(within(table).getByText('Aumento tres meses seguidos')).toBeVisible()
    expect(within(table).queryByText('Tendencia de tres meses consecutivos')).not.toBeInTheDocument()
    expect(within(table).queryByRole('columnheader', { name: 'Mes' })).not.toBeInTheDocument()
    // «Mes evaluado» aparece en la tarjeta de la alerta y una vez en la ficha de evaluaciones.
    expect(within(table.closest('.rounded-panel')).getByText('Mes evaluado', { selector: 'dt' })).toBeVisible()
  })
  it('no presenta link de contexto sin document.query', async () => {
    fixture({ analysis: analysisPage(true), roles: [] })
    await screen.findByText('1 alerta'); expect(screen.queryByRole('link', { name: 'Verificar evidencia documental' })).not.toBeInTheDocument()
  })
  it('vigente no envía period al análisis y usa periodo actual para KPI', async () => {
    const client = fixture(); await screen.findByText('0 alertas')
    expect(client.acquireRead.mock.calls.some(([path]) => path === '/dashboard/analysis?risk_type=all')).toBe(true)
    expect(client.acquireRead.mock.calls.some(([path]) => path === '/dashboard/kpis?period=current_month&risk_type=all')).toBe(true)
    expect(screen.getByLabelText('Periodo')).toBeEnabled()
    expect(screen.queryAllByRole('columnheader', { name: 'Fecha de cálculo' })).toHaveLength(0)
    expect(screen.getByText(/actualizados el \d{1,2} (ene|feb) 2030, \d{2}:\d{2}$/)).toBeVisible()
  })
  it('Tendencias aplica filtros históricos y back/forward restaura selección', async () => {
    const client = fixture({ view: 'trends' }); await screen.findByText('0 alertas')
    await userEvent.selectOptions(screen.getByLabelText('Análisis'), 'historical')
    await waitFor(() => expect(screen.getByLabelText('Dirección actual')).toHaveTextContent('analysis_mode=historical'))
    await userEvent.selectOptions(screen.getByLabelText('Periodo'), 'last_3_months')
    await waitFor(() => expect(screen.getByLabelText('Dirección actual')).toHaveTextContent('period=last_3_months'))
    await userEvent.selectOptions(screen.getByLabelText('Tipo de riesgo'), 'compliance')
    await waitFor(() => expect(client.acquireRead.mock.calls.some(([path]) => path === '/dashboard/analysis?period=last_3_months&risk_type=compliance')).toBe(true))
    await userEvent.click(screen.getByRole('button', { name: 'Atrás de prueba' }))
    await waitFor(() => expect(screen.getByLabelText('Tipo de riesgo')).toHaveValue('all'))
    expect(screen.getByLabelText('Periodo')).toHaveValue('last_3_months')
    await userEvent.click(screen.getByRole('button', { name: 'Atrás de prueba' }))
    await userEvent.click(screen.getByRole('button', { name: 'Atrás de prueba' }))
    await waitFor(() => expect(screen.getByLabelText('Análisis')).toHaveValue('current'))
    await userEvent.click(screen.getByRole('button', { name: 'Adelante de prueba' }))
    await userEvent.click(screen.getByRole('button', { name: 'Adelante de prueba' }))
    await waitFor(() => expect(screen.getByLabelText('Periodo')).toHaveValue('last_3_months'))
  })
  it('permite seleccionar el mes en curso sin convertir análisis vigente en histórico', async () => {
    const client = fixture({ search: '?period=last_6_months&analysis_mode=current' }); await screen.findByText('0 alertas')
    await userEvent.selectOptions(screen.getByLabelText('Periodo'), 'current_month')
    await waitFor(() => expect(client.acquireRead.mock.calls.some(([path]) => path === '/dashboard/kpis?period=current_month&risk_type=all')).toBe(true))
    expect(screen.queryByLabelText('Análisis')).not.toBeInTheDocument()
    expect(client.acquireRead.mock.calls.filter(([path]) => path.startsWith('/dashboard/analysis')).every(([path]) => path === '/dashboard/analysis?risk_type=all')).toBe(true)
    expect(screen.getByLabelText('Dirección actual')).not.toHaveTextContent('analysis_mode=historical')
  })
  it('ofrece mes actual explícito y conserva la selección al navegar atrás', async () => {
    const client = fixture({ search: '?period=last_6_months&analysis_mode=current' }); await screen.findByText('0 alertas')
    await userEvent.click(screen.getByRole('button', { name: 'Ver periodo en curso' }))
    await waitFor(() => expect(client.acquireRead.mock.calls.some(([path]) => path.includes('period=current_month'))).toBe(true))
    expect(screen.getByLabelText('Periodo')).toHaveValue('current_month')
    await userEvent.click(screen.getByRole('button', { name: 'Atrás de prueba' }))
    await waitFor(() => expect(screen.getByLabelText('Periodo')).toHaveValue('last_6_months'))
  })
  it.each(['summary', 'contracts', 'litigation'])('%s inicia en mes actual y conserva opciones históricas', async (view) => {
    const client = fixture({ view }); await screen.findByText('0 alertas')
    expect(screen.getByLabelText('Periodo')).toHaveValue('current_month')
    expect(client.acquireRead.mock.calls.some(([path]) => path.startsWith('/dashboard/kpis?period=current_month'))).toBe(true)
    expect(within(screen.getByLabelText('Periodo')).getByRole('option', { name: 'Últimos 6 meses' })).toBeInTheDocument()
  })
  it('fechas custom inválidas no disparan lectura histórica', async () => {
    const client = fixture(); await screen.findByText('0 alertas'); const before = client.acquireRead.mock.calls.length
    await userEvent.selectOptions(screen.getByLabelText('Periodo'), 'custom')
    expect(client.acquireRead).toHaveBeenCalledTimes(before)
    // Sin botón «Aplicar»: un rango invertido marca «Hasta» y no consulta.
    fireEvent.change(screen.getByLabelText('Desde'), { target: { value: '2030-02-01' } })
    fireEvent.change(screen.getByLabelText('Hasta'), { target: { value: '2030-01-01' } })
    expect(screen.getByRole('alert')).toHaveTextContent('Debe ser igual o posterior a «Desde».')
    expect(screen.getByLabelText('Hasta')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByLabelText('Hasta')).toHaveAttribute('min', '2030-02-01')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(client.acquireRead).toHaveBeenCalledTimes(before)
    // Rango válido: se aplica solo, sin botón.
    fireEvent.change(screen.getByLabelText('Hasta'), { target: { value: '2030-03-01' } })
    await waitFor(() => expect(screen.getByLabelText('Dirección actual')).toHaveTextContent('period_start=2030-02-01'))
    expect(screen.queryByRole('button', { name: 'Aplicar rango' })).not.toBeInTheDocument()
  })
  it('retira parámetros desconocidos con aviso seguro y sin usarlos en API', async () => {
    const client = fixture({ search: '?query=contenido-no-permitido&risk_type=alto' })
    await screen.findByText('Se retiraron filtros no válidos de la dirección.')
    expect(screen.getByLabelText('Dirección actual')).not.toHaveTextContent('query')
    expect(client.acquireRead.mock.calls.every(([path]) => !path.includes('contenido-no-permitido'))).toBe(true)
  })
  it('conserva lectura vacía sin convertirla en riesgo', async () => {
    fixture({ kpis: kpiPage([]), analysis: { current_analytic_run_id: null, alert_count: 0, items: [] } })
    expect(await screen.findByText('Sin análisis completados')).toBeVisible()
    expect(within(screen.getByLabelText('Indicadores principales')).getAllByText('Sin observación')).toHaveLength(5); expect(screen.getByText('0 alertas')).toBeVisible()
  })
  it('loading no muestra valores cero provisionales', () => { fixture({ pending: true }); expect(screen.getAllByText('Cargando…')).toHaveLength(2); expect(screen.queryByText('0')).not.toBeInTheDocument() })
  it.each([401, 403, 422, 503])('muestra error %i sin contenido previo', async (error) => {
    fixture({ error }); const alerts = await screen.findAllByRole('alert'); expect(alerts).toHaveLength(2)
    expect(screen.queryByText('Análisis completado sin hallazgos.')).not.toBeInTheDocument()
    if (error === 403) expect(alerts[0]).toHaveTextContent('Sin autorización')
  })
  it('incluye alternativa tabular y meses ausentes sin fabricar conteos', () => {
    const items = adaptKpis(kpiPage([observation('KPI-LI-05', { value: '3' }), observation('KPI-LI-05', { value: '8', period_start: '2030-03-01', period_end: '2030-03-31' })])).items
    render(<TemporalChart items={items} kpiCode="KPI-LI-05" title="Serie temporal" subtitle="Prueba" unit="litigios" />)
    expect(screen.getByRole('table')).toBeInTheDocument()
    const points = JSON.parse(screen.getByTestId('chart').getAttribute('data-points'))
    expect(points.map((row) => row.month)).toEqual(['2030-01', '2030-02', '2030-03'])
    expect(points.map((row) => row.value)).toEqual([3, null, 8])
    expect(screen.getAllByTestId('plot')).toHaveLength(1)
    expect(screen.getByTestId('plot').dataset.key).toBe('value')
    expect(screen.getByRole('table')).toHaveTextContent('Sin observación')
  })
  it('registry descubre cuatro rutas distintas protegidas', () => {
    const registry = buildRegistry({ analytics }); expect(registry.routes).toHaveLength(4)
    expect(registry.routes.every((route) => route.capability === 'dashboard.read')).toBe(true)
    expect(registry.navigation.map((item) => item.path)).toEqual(['/', '/contratos', '/litigios', '/tendencias'])
  })
  it('resumen ejecutivo con datasets vacíos preserva bloque 8/4 con ChartContainer, títulos y EmptyChartState sin datos inventados', async () => {
    fixture({ view: 'summary', kpis: kpiPage([]), analysis: { current_analytic_run_id: null, alert_count: 0, items: [] } })
    await screen.findByLabelText('Indicadores principales')
    expect(within(screen.getByLabelText('Indicadores principales')).getAllByText('Sin observación')).toHaveLength(5)
    expect(screen.getByText('Evolución de exposición acumulada')).toBeVisible()
    expect(screen.getByText('Composición por severidad')).toBeVisible()
    expect(screen.getAllByText('Sin datos disponibles')).toHaveLength(3)
    expect(screen.getByLabelText('Incidentes por área: sin datos disponibles')).toBeInTheDocument()
    expect(screen.getByLabelText('Evolución de exposición acumulada: sin datos disponibles')).toBeInTheDocument()
    expect(screen.getByLabelText('Composición por severidad: sin datos disponibles')).toBeInTheDocument()
    expect(screen.queryAllByTestId('chart')).toHaveLength(0)
    expect(screen.queryByText(/0 %/)).not.toBeInTheDocument()
  })
  it('compone severidades desde la dimensión canónica del DTO y no muestra estado vacío', () => {
    const items = adaptKpis(kpiPage([
      observation('KPI-LI-01', { dimensions: { nivel_severidad: 'alto' }, value: '200000' }),
      observation('KPI-LI-01', { dimensions: { nivel_severidad: 'medio' }, value: '90000' }),
      observation('KPI-LI-01', { dimensions: { nivel_severidad: 'bajo' }, value: '25000' }),
      observation('KPI-CN-03', { dimensions: { area: 'Finanzas', nivel_severidad: 'medio' }, value: '1' }),
    ])).items

    render(<SeverityChart items={items} />)

    expect(screen.queryByLabelText('Composición por severidad: sin datos disponibles')).not.toBeInTheDocument()
    expect(screen.getAllByText('Alto').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Medio').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Bajo').length).toBeGreaterThan(0)
    expect(screen.getAllByText(/\$200,000 MXN/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/63\.49 %/).length).toBeGreaterThan(0)
    expect(screen.getByText(/Total: \$315,000 MXN\./)).toBeVisible()
    expect(screen.getByTestId('plot').dataset.key).toBe('value')
    expect(JSON.parse(screen.getByTestId('chart').dataset.points).map(({ name, value }) => ({ name, value }))).toEqual([
      { name: 'Alto', value: 200000 },
      { name: 'Medio', value: 90000 },
      { name: 'Bajo', value: 25000 },
    ])
  })
  it('contratos con dataset vacío preserva ChartContainer para tiempo de ciclo y muestra EmptyChartState contextual', async () => {
    fixture({ view: 'contracts', kpis: kpiPage([]) })
    expect(await screen.findByText('Tiempo de ciclo del contrato', { selector: 'figcaption' })).toBeVisible()
    // La definición del indicador está en su ayuda ⓘ (DESIGN §21.2), igual que en las demás vistas.
    fireEvent.click(screen.getByRole('button', { name: 'Qué mide: Contratos próximos a vencimiento sin revisión' }))
    expect(screen.getByRole('note')).toHaveTextContent('vencen entre hoy y los próximos 60 días')
    expect(screen.getByText('No existen observaciones contractuales para los filtros seleccionados.')).toBeVisible()
    expect(screen.getByLabelText('Tiempo de ciclo del contrato: sin datos disponibles')).toBeInTheDocument()
    expect(screen.queryAllByTestId('chart')).toHaveLength(0)
  })
  it('litigios con ambos datasets vacíos preserva ambas superficies de gráficas independientemente', async () => {
    fixture({ view: 'litigation', kpis: kpiPage([]) })
    expect(await screen.findByText('Evolución de exposición litigiosa')).toBeVisible()
    expect(screen.getByText('Nuevos litigios por periodo', { selector: 'figcaption' })).toBeVisible()
    expect(screen.getByLabelText('Evolución de exposición litigiosa: sin datos disponibles')).toBeInTheDocument()
    expect(screen.getByLabelText('Nuevos litigios por periodo: sin datos disponibles')).toBeInTheDocument()
    expect(screen.queryAllByTestId('chart')).toHaveLength(0)
  })
  it('litigios con estado mixto: una gráfica poblada y otra vacía conviven sin anularse', async () => {
    fixture({ view: 'litigation', kpis: kpiPage([observation('KPI-LI-01', { dimensions: { nivel_severidad: 'alto' }, value: '15.00' })]) })
    expect((await screen.findAllByText('Evolución de exposición litigiosa')).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('Nuevos litigios por periodo', { selector: 'figcaption' })).toBeVisible()
    expect(screen.getAllByTestId('chart')).toHaveLength(1)
    expect(screen.getByLabelText('Nuevos litigios por periodo: sin datos disponibles')).toBeInTheDocument()
  })
  it('tendencias sin hallazgos prioriza el resumen de ejecución y no crea una galería KPI', async () => {
    fixture({ view: 'trends', kpis: kpiPage([]) })
    expect(await screen.findByText('Sin alertas en el análisis')).toBeVisible()
    expect(screen.getByText(/No son predicciones ni asesoría jurídica/)).toBeVisible()
    expect(screen.queryAllByTestId('chart')).toHaveLength(0)
  })
})

describe('SRS_REQUIRED: certificación visual de partición y hallazgos', () => {
  const exposureItems = (levels) => adaptKpis(kpiPage(['2030-01-01', '2030-02-01'].flatMap((period_start) => levels.map((nivel_severidad) => observation('KPI-LI-01', {
    period_start, period_end: period_start === '2030-01-01' ? '2030-01-31' : '2030-02-28',
    dimensions: { nivel_severidad }, value: { alto: '200000', medio: '90000', bajo: '25000' }[nivel_severidad],
  }))))).items

  it('la partición completa muestra la leyenda y el total visual de 315000', () => {
    render(<LitigationExposureChart items={exposureItems(['alto', 'medio', 'bajo'])} />)
    expect(screen.getByLabelText('Leyenda')).toHaveTextContent('Total')
    expect(screen.getByRole('table')).toHaveTextContent('$315,000 MXN')
    expect(JSON.parse(screen.getByTestId('chart').dataset.points)[0].total).toBe(315000)
  })
  it('la partición incompleta no muestra Total ni 290000 en leyenda, gráfica o tabla', () => {
    render(<LitigationExposureChart items={exposureItems(['alto', 'medio'])} />)
    expect(screen.getByLabelText('Leyenda')).not.toHaveTextContent('Total')
    expect(screen.queryByRole('columnheader', { name: 'Total', exact: true })).not.toBeInTheDocument()
    expect(screen.queryByText('$290,000 MXN')).not.toBeInTheDocument()
    expect(JSON.parse(screen.getByTestId('chart').dataset.points)[0].total).toBeUndefined()
  })
  it('NO_DISPONIBLE en todas las severidades del periodo muestra «No disponible», no «Sin observaciones»', () => {
    const items = adaptKpis(kpiPage(['alto', 'medio', 'bajo'].map((level) => observation('KPI-LI-01', { dimensions: { nivel_severidad: level }, availability: 'NO_DISPONIBLE', value: null })))).items
    render(<SeverityChart items={items} />)
    expect(screen.getByLabelText('Composición por severidad: no disponible')).toHaveTextContent('Las observaciones de severidad del último periodo no tienen valor disponible.')
    expect(screen.queryByText(/Sin observaciones de severidad/)).not.toBeInTheDocument()
  })
  it('la tabla de exposición conserva los periodos No disponible sin fabricar cero ni ocultarlos', () => {
    const items = adaptKpis(kpiPage(['2029-11-01', '2029-12-01'].flatMap((start) => ['alto', 'medio', 'bajo'].map((level) => observation('KPI-LI-01', { period_start: start, period_end: start.replace('-01', '-28').replace(/-28$/, '-28'), dimensions: { nivel_severidad: level }, availability: 'NO_DISPONIBLE', value: null }))))).items
    render(<LitigationExposureChart items={items} />)
    const rows = screen.getByRole('table', { name: 'Datos de Evolución de exposición litigiosa' }).querySelectorAll('tbody tr')
    expect(rows).toHaveLength(2)
    expect([...rows].every((row) => row.textContent.includes('No disponible') && !/\$0 MXN/.test(row.textContent))).toBe(true)
  })
  it('el donut vacío conserva EmptyChartState sin periodo inventado', () => {
    render(<SeverityChart items={[]} />)
    expect(screen.getByLabelText('Composición por severidad: sin datos disponibles')).toBeVisible()
    expect(screen.queryAllByTestId('chart')).toHaveLength(0)
    expect(screen.queryByText(/Periodo:/)).not.toBeInTheDocument()
  })
  it('el hallazgo real-shaped sin severidad presenta tarjeta sin RiskBadge ni sparkline', async () => {
    fixture({ view: 'trends', analysis: analysisPage(true), kpis: kpiPage([]) })
    const card = await screen.findByRole('article')
    expect(card).toHaveTextContent('Contratos próximos a vencimiento sin revisión')
    expect(card).toHaveTextContent('Actual')
    expect(card).toHaveTextContent('Referencia del análisis')
    expect(card).toHaveTextContent('Variación')
    expect(card).toHaveTextContent('Patrón recurrente registrado3/4')
    expect(card).toHaveTextContent('Generado')
    expect(card.querySelector('.badge')).toBeNull()
    expect(screen.queryAllByTestId('chart')).toHaveLength(0)
  })
})

describe('SRS_REQUIRED: cinco slots ejecutivos y frontera de datos', () => {
  const mainSlots = () => within(screen.getByLabelText('Indicadores principales')).getAllByRole('group')
  it('una sola observación LI05=0 mantiene cinco slots y cuatro ausencias accesibles', async () => {
    fixture({ kpis: kpiPage([observation('KPI-LI-05')]) })
    await screen.findByLabelText('Indicadores principales')
    expect(mainSlots()).toHaveLength(5)
    expect(mainSlots().map((slot) => slot.dataset.state)).toEqual(['NO_OBSERVATION', 'NO_OBSERVATION', 'ZERO', 'NO_OBSERVATION', 'NO_OBSERVATION'])
    const expandedStates = within(screen.getByLabelText('Indicadores principales')).getAllByText('Sin observación para la selección')
    expect(expandedStates).toHaveLength(4)
    expandedStates.forEach((state) => expect(state).toHaveClass('sr-only'))
    within(screen.getByLabelText('Indicadores principales')).getAllByText('Sin observación').forEach((state) => expect(state).toHaveAttribute('aria-hidden', 'true'))
    expect(screen.queryByText('Sin indicadores principales')).not.toBeInTheDocument()
  })
  it('all-data conserva total exacto LI01 y CN03 dimensional en una sola card', async () => {
    fixture({ kpis: kpiPage([
      observation('KPI-RC-03'), observation('KPI-LI-05'), observation('KPI-CN-02'),
      ...['alto', 'medio', 'bajo'].map((level) => observation('KPI-LI-01', { value: { alto: '200000', medio: '90000', bajo: '25000' }[level], dimensions: { nivel_severidad: level } })),
      observation('KPI-CN-03', { value: '1', dimensions: { area: 'Legal', nivel_severidad: 'medio' } }),
      observation('KPI-CN-03', { value: '2', dimensions: { area: 'Finanzas', nivel_severidad: 'alto' } }),
    ]) })
    await screen.findByLabelText('Indicadores principales')
    expect(mainSlots()).toHaveLength(5)
    expect([...mainSlots()[1].querySelectorAll('.kpi-value-slot > span')].map((span) => span.textContent)).toEqual(['$315,000', 'MXN'])
    expect(mainSlots()[4]).toHaveTextContent('Desglose disponible')
    expect(mainSlots()[4].querySelector('.kpi-value-slot')).not.toHaveTextContent('3')
  })
  it('all-ND dimensional conserva No disponible y presentación compacta', async () => {
    fixture({ kpis: kpiPage([
      ...['alto', 'medio', 'bajo'].map((level) => observation('KPI-LI-01', { value: null, availability: 'NO_DISPONIBLE', dimensions: { nivel_severidad: level } })),
      ...['Legal', 'Finanzas'].map((area) => observation('KPI-CN-03', { value: null, availability: 'NO_DISPONIBLE', dimensions: { area, nivel_severidad: 'alto' } })),
    ]) })
    await screen.findByLabelText('Indicadores principales')
    expect(mainSlots()[1]).toHaveAttribute('data-state', 'NO_DISPONIBLE')
    expect(mainSlots()[4]).toHaveAttribute('data-state', 'NO_DISPONIBLE')
    expect(within(mainSlots()[1]).getByText('No disponible')).toHaveClass('text-[14px]', 'leading-5')
    expect(within(mainSlots()[0]).getByText('Sin observación')).toHaveClass('text-[14px]', 'leading-5')
    expect(screen.queryByText('Por dimensión')).not.toBeInTheDocument()
  })
  it('loading emplea cinco skeletons con la misma primitiva de altura y fila final', () => {
    fixture({ pending: true })
    const skeletons = document.querySelectorAll('.kpi-row > .kpi-metric[data-state="LOADING"]')
    expect(skeletons).toHaveLength(5)
    expect(skeletons[0].parentElement).toHaveClass('kpi-row-five')
    expect(screen.queryByText('0')).not.toBeInTheDocument()
  })
  it('el filtro litigation no muestra dominios no aplicables como si faltaran observaciones', async () => {
    fixture({ search: '?period=current_month&risk_type=litigation', kpis: kpiPage([]) })
    await screen.findByLabelText('Indicadores principales')
    expect(mainSlots().map((slot) => slot.getAttribute('aria-label'))).toEqual([KPI_CATALOG['KPI-LI-01'].name, KPI_CATALOG['KPI-LI-05'].name])
    expect(mainSlots().map((slot) => slot.dataset.state)).toEqual(['NO_OBSERVATION', 'NO_OBSERVATION'])
  })
  it.each([403, 503])('error KPI %i no produce cinco ceros ni tarjetas de datos', async (error) => {
    fixture({ error })
    const alerts = await screen.findAllByRole('alert')
    expect(alerts[0]).toHaveTextContent(error === 403 ? 'Sin autorización' : 'Error al cargar los indicadores')
    expect(document.querySelectorAll('.kpi-metric')).toHaveLength(0)
    expect(screen.queryByLabelText('Indicadores principales')).not.toBeInTheDocument()
  })
  it('sin dashboard.read no muestra skeletons, tarjetas ni observaciones aun con respuesta fixture', async () => {
    fixture({ roles: [] })
    expect(screen.getByRole('alert')).toHaveTextContent('Sin autorización')
    await screen.findByText('0 alertas')
    expect(document.querySelectorAll('.kpi-metric')).toHaveLength(0)
    expect(screen.queryByText(/^Datos de los indicadores/)).not.toBeInTheDocument()
  })
  it('un error después de cambiar filtros elimina las cifras anteriores sin reemplazarlas por ceros', async () => {
    const client = fixture({ kpis: kpiPage([observation('KPI-RC-03', { value: '42' })]) })
    await screen.findByLabelText('Indicadores principales')
    expect(mainSlots()[0]).toHaveTextContent('42')
    client.acquireRead.mockImplementation(() => ({ promise: Promise.reject(new ApiError(503)), release: vi.fn() }))
    await userEvent.selectOptions(screen.getByLabelText('Tipo de riesgo'), 'litigation')
    await screen.findAllByRole('alert')
    expect(screen.queryByLabelText('Indicadores principales')).not.toBeInTheDocument()
    expect(screen.queryByText('42')).not.toBeInTheDocument()
    expect(document.querySelectorAll('.kpi-metric')).toHaveLength(0)
  })
})

describe('SRS_REQUIRED: slots estructurales de contratos y litigios', () => {
  const slots = () => within(screen.getByLabelText('Indicadores principales')).getAllByRole('group')
  it.each([['contracts', 1], ['litigation', 2]])('%s conserva %i slots ausentes y accesibilidad completa', async (view, count) => {
    fixture({ view, kpis: kpiPage([]) })
    await screen.findByLabelText('Indicadores principales')
    expect(slots()).toHaveLength(count)
    expect(slots().map((slot) => slot.dataset.state)).toEqual(Array(count).fill('NO_OBSERVATION'))
    expect(within(screen.getByLabelText('Indicadores principales')).getAllByText('Sin observación para la selección')).toHaveLength(count)
    expect(screen.queryByText('Sin indicadores principales')).not.toBeInTheDocument()
    expect(document.querySelectorAll('.kpi-entry')).toHaveLength(0)
  })
  it.each([['contracts', 1], ['litigation', 2]])('%s loading conserva %i slots sin motion', (view, count) => {
    fixture({ view, pending: true })
    expect(document.querySelectorAll('.kpi-metric[data-state="LOADING"]')).toHaveLength(count)
    expect(document.querySelectorAll('.kpi-entry')).toHaveLength(0)
  })
  it('RC01 de contexto no reemplaza al RC03 ausente ni incorpora otro dominio', async () => {
    fixture({ view: 'contracts', kpis: kpiPage([observation('KPI-RC-01', { value: '5.5' }), observation('KPI-LI-05')]) })
    await screen.findByLabelText('Indicadores principales')
    expect(slots()).toHaveLength(1)
    expect(slots()[0]).toHaveAttribute('aria-label', KPI_CATALOG['KPI-RC-03'].name)
    expect(slots()[0]).toHaveAttribute('data-state', 'NO_OBSERVATION')
    expect(screen.getByRole('heading', { name: 'Contexto operativo' })).toBeVisible()
    expect(screen.getByRole('table', { name: 'Datos del contexto operativo' })).toHaveTextContent('Tiempo de ciclo')
  })
  it('litigios parcial mantiene LI01 ausente y LI05 cero observado', async () => {
    fixture({ view: 'litigation', kpis: kpiPage([observation('KPI-LI-05')]) })
    await screen.findByLabelText('Indicadores principales')
    expect(slots().map((slot) => slot.dataset.state)).toEqual(['NO_OBSERVATION', 'ZERO'])
  })
  it('litigios ND dimensional y simple permanece compacto y distinto de cero', async () => {
    fixture({ view: 'litigation', kpis: kpiPage([
      ...['alto', 'medio', 'bajo'].map((level) => observation('KPI-LI-01', { dimensions: { nivel_severidad: level }, availability: 'NO_DISPONIBLE', value: null })),
      observation('KPI-LI-05', { availability: 'NO_DISPONIBLE', value: null }),
    ]) })
    await screen.findByLabelText('Indicadores principales')
    expect(slots().map((slot) => slot.dataset.state)).toEqual(['NO_DISPONIBLE', 'NO_DISPONIBLE'])
    expect(within(slots()[0]).getByText('No disponible')).toHaveClass('text-[14px]', 'leading-5')
    expect(screen.queryByText('Por dimensión')).not.toBeInTheDocument()
  })
  it.each([['contracts', 403], ['contracts', 503], ['litigation', 403], ['litigation', 503]])('%s error %i preserva boundary sin slots falsos', async (view, error) => {
    fixture({ view, error })
    expect((await screen.findAllByRole('alert'))[0]).toHaveTextContent(error === 403 ? 'Sin autorización' : 'Error al cargar los indicadores')
    expect(document.querySelectorAll('.kpi-metric')).toHaveLength(0)
    expect(screen.queryByLabelText('Indicadores principales')).not.toBeInTheDocument()
  })
})

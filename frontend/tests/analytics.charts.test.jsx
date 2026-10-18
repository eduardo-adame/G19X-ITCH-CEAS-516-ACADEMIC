import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { adaptKpis, KPI_CATALOG } from '../src/features/analytics/adapters.js'
import { ExposureTooltip, LitigationExposureChart, TemporalChart, TemporalTooltip } from '../src/features/analytics/charts.jsx'
import { litigationExposureViewModel, temporalSeriesViewModel } from '../src/features/analytics/viewModels.js'

vi.mock('recharts', () => {
  const Container = ({ children }) => <div>{children}</div>
  const Graph = ({ data, children }) => <div data-testid="chart" data-points={JSON.stringify(data)}>{children}</div>
  return {
    ResponsiveContainer: Container, BarChart: Graph, LineChart: Graph, PieChart: Graph,
    Pie: () => null, Cell: () => null, LabelList: () => null, CartesianGrid: () => null, XAxis: () => null, Tooltip: () => null,
    YAxis: ({ domain, ticks, allowDecimals }) => <span data-testid="axis" data-domain={JSON.stringify(domain)} data-ticks={JSON.stringify(ticks)} data-decimals={String(allowDecimals)} />,
    Line: ({ dataKey, connectNulls, isAnimationActive }) => <span data-testid="line" data-key={dataKey} data-connect={String(connectNulls)} data-animation={String(isAnimationActive)} />,
    Bar: ({ dataKey, isAnimationActive }) => <span data-testid="bar" data-key={dataKey} data-animation={String(isAnimationActive)} />,
  }
})
const item = (code, month, value, overrides = {}) => {
  const end = new Date(`${month}-01T00:00:00Z`); end.setUTCMonth(end.getUTCMonth() + 1); end.setUTCDate(0)
  return { kpi_code: code, name: KPI_CATALOG[code].name, unit: KPI_CATALOG[code].unit, classification: KPI_CATALOG[code].core ? 'MVP-NÚCLEO' : 'MVP-COMPLEMENTARIO', period_start: `${month}-01`, period_end: end.toISOString().slice(0, 10), as_of_date: `${month}-01`, calculated_at: '2030-02-01T00:00:00Z', dimensions: {}, entity_filter_applicable: false, availability: value === null ? 'NO_DISPONIBLE' : 'DISPONIBLE', value, ...overrides }
}
const adapted = (items) => adaptKpis({ items, filters: {}, period_start: null, period_end: null, period_reference: null }).items
const exposure = (values = ['200000', '90000', '25000']) => ['alto', 'medio', 'bajo'].map((level, index) => item('KPI-LI-01', '2026-10', values[index], { dimensions: { nivel_severidad: level } }))

describe('ROBUSTNESS: gráficas temporales según calendario y escalas aprobados', () => {
  it('real_null_breaks_line: julio sin observación interrumpe la línea en dos segmentos y figura en tabla', () => {
    const items = adapted([['2026-05', '10'], ['2026-06', '20'], ['2026-08', '30'], ['2026-09', '15']].map(([month, value]) => item('KPI-RC-01', month, value)))
    render(<TemporalChart items={items} kpiCode="KPI-RC-01" title="Ciclo" unit="días" />)
    expect(JSON.parse(screen.getByTestId('chart').dataset.points).map(({ value }) => value)).toEqual([10, 20, null, 30, 15])
    expect(screen.getAllByTestId('line')).toHaveLength(2)
    expect(screen.getAllByTestId('line').every((line) => line.dataset.connect === 'false' && line.dataset.animation === 'false')).toBe(true)
    expect(screen.getByRole('table')).toHaveTextContent('julio 2026Sin observación')
    expect(screen.getByText(/Periodos sin observación:.*julio 2026.*La línea se interrumpe/)).toBeVisible()
    expect(screen.getByTestId('axis')).toHaveAttribute('data-decimals', 'true')
  })
  it('LI05 utiliza barras discretas, ticks enteros y headroom0..2 para cinco unos', () => {
    const items = adapted(['05', '06', '07', '08', '09'].map((month) => item('KPI-LI-05', `2026-${month}`, '1')))
    render(<TemporalChart items={items} kpiCode="KPI-LI-05" title="Nuevos" unit="litigios" />)
    expect(screen.getByTestId('bar')).toHaveAttribute('data-animation', 'false')
    expect(screen.queryAllByTestId('line')).toHaveLength(0)
    expect(screen.getByTestId('axis')).toHaveAttribute('data-domain', '[0,2]')
    expect(screen.getByTestId('axis')).toHaveAttribute('data-ticks', '[0,1,2]')
    expect(screen.getByTestId('axis')).toHaveAttribute('data-decimals', 'false')
    expect(JSON.parse(screen.getByTestId('chart').dataset.points).map(({ value }) => value)).toEqual([1, 1, 1, 1, 1])
  })
})

describe('SRS_REQUIRED: F-07 decimales de alta precisión en RC01 (RF-030, RF-078, RNF-005)', () => {
  const months = [['2026-05', '15.75'], ['2026-06', '18.5'], ['2026-07', '18.33333333333333333333333333'], ['2026-08', '21.5'], ['2026-09', '18']]
  const rc01 = () => adapted(months.map(([month, value]) => item('KPI-RC-01', month, value)))
  it('high_precision_decimal_chart: julio con 28 dígitos se grafica y la serie es una sola línea', () => {
    render(<TemporalChart items={rc01()} kpiCode="KPI-RC-01" title="Ciclo" unit="días" />)
    const points = JSON.parse(screen.getByTestId('chart').dataset.points)
    expect(points).toHaveLength(5)
    expect(points.every((point) => Object.entries(point).some(([key, value]) => key.startsWith('value') && typeof value === 'number'))).toBe(true)
    expect(screen.getAllByTestId('line')).toHaveLength(1)
    expect(screen.queryByText(/Periodos sin observación/)).toBeNull()
  })
  it('valid_period_not_null: el periodo disponible no se convierte en ausencia', () => {
    const july = temporalSeriesViewModel(rc01(), 'KPI-RC-01').find((row) => row.month === '2026-07')
    expect(july.value).not.toBeNull()
    expect(july.value).toBeCloseTo(18.3333333333, 9)
    expect(july).toMatchObject({ availability: 'DISPONIBLE', rawValue: '18.33333333333333333333333333' })
  })
  it('table_chart_consistency: tabla, tooltip y coordenada coinciden con dos decimales y no muestran 28 dígitos', () => {
    const rows = temporalSeriesViewModel(rc01(), 'KPI-RC-01')
    const july = rows.find((row) => row.month === '2026-07')
    expect(july.valueText).toBe('18.33 días')
    expect(`${july.value.toFixed(2)} días`).toBe(july.valueText)
    const { unmount } = render(<TemporalChart items={rc01()} kpiCode="KPI-RC-01" title="Ciclo" unit="días" />)
    expect(screen.getByRole('table')).toHaveTextContent('julio 202618.33 días')
    expect(screen.getByRole('table')).not.toHaveTextContent('18.333')
    unmount()
    render(<TemporalTooltip active payload={[{ payload: july }]} rows={rows} unit="días" />)
    expect(screen.getByText('18.33 días')).toBeVisible()
  })
  it('real_null_breaks_line: una observación No disponible no se grafica ni se presenta como cero', () => {
    const items = adapted([['2026-05', '15.75'], ['2026-06', null], ['2026-07', '18.33333333333333333333333333']].map(([month, value]) => item('KPI-RC-01', month, value)))
    render(<TemporalChart items={items} kpiCode="KPI-RC-01" title="Ciclo" unit="días" />)
    expect(screen.getAllByTestId('line')).toHaveLength(2)
    expect(screen.getByRole('table')).toHaveTextContent('junio 2026No disponible')
  })
})

describe('SRS_REQUIRED: tooltips y tablas conservan valores, unidad y disponibilidad', () => {
  it('tooltip RC01 presenta periodo, ciclo y el decimal redondeado a dos cifras sin usar Number', () => {
    const rows = temporalSeriesViewModel(adapted([item('KPI-RC-01', '2026-05', '0.1254567890123456789')]), 'KPI-RC-01')
    render(<TemporalTooltip active payload={[{ payload: rows[0] }]} rows={rows} unit="días" />)
    expect(screen.getByText('Tiempo de ciclo')).toBeVisible()
    expect(screen.getByText('0.13 días')).toBeVisible()
    expect(screen.getByText('mayo 2026')).toBeVisible()
  })
  it.each([['NO_OBSERVATION', 'Sin observación'], ['NO_DISPONIBLE', 'No disponible']])('tooltip temporal %s no muestra cero', (availability, text) => {
    const row = { month: '2026-07', periodText: 'Julio 2026', availability, value: null, rawValue: null }
    render(<TemporalTooltip active payload={[]} label="2026-07" rows={[row]} unit="días" />)
    expect(screen.getByText(text)).toBeVisible()
    expect(screen.queryByText('0 días')).not.toBeInTheDocument()
  })
  it('tooltip LI05 conserva cero real y no presenta fracciones de litigio', () => {
    render(<TemporalTooltip active payload={[{ payload: { periodText: 'Julio 2026', rawValue: '0.000', availability: 'DISPONIBLE' } }]} unit="litigios" />)
    expect(screen.getByText('Nuevos litigios')).toBeVisible()
    expect(screen.getByText('0 litigios')).toBeVisible()
  })
  it('LI01 parcial medio/bajo conserva datos accesibles sin Total ni cifra parcial', () => {
    render(<LitigationExposureChart items={adapted(exposure().slice(1))} />)
    expect(screen.getByRole('table')).toHaveTextContent('$90,000 MXN')
    expect(screen.getByRole('table')).toHaveTextContent('$25,000 MXN')
    expect(screen.getByRole('table')).toHaveTextContent('Sin observación')
    expect(screen.queryByRole('columnheader', { name: 'Total', exact: true })).not.toBeInTheDocument()
    expect(screen.queryByText('$115,000 MXN')).not.toBeInTheDocument()
    expect(screen.queryAllByTestId('chart')).toHaveLength(0)
  })
  it('LI01 todo ND conserva tres niveles en tabla sin falso total ni gráfico cero', () => {
    render(<LitigationExposureChart items={adapted(exposure([null, null, null]))} />)
    expect(screen.getByRole('table')).toBeVisible()
    expect(screen.getByRole('table')).toHaveTextContent('No disponible')
    expect(screen.queryAllByTestId('chart')).toHaveLength(0)
    expect(screen.queryByText('$0 MXN')).not.toBeInTheDocument()
  })
})

describe('ROBUSTNESS: presentación de contextos y decimales de alta precisión', () => {
  it('LI01 separa contextos reales en trazas y no combina alto A con medio B', () => {
    const items = exposure().map((row, index) => ({ ...row, dimensions: { ...row.dimensions, entity: index === 1 ? 'B' : 'A' } }))
    render(<LitigationExposureChart items={adapted(items)} />)
    expect(screen.getByRole('table')).toHaveTextContent('Entidad: A')
    expect(screen.getByRole('table')).toHaveTextContent('Entidad: B')
    expect(screen.queryByRole('columnheader', { name: 'Total', exact: true })).not.toBeInTheDocument()
    expect(screen.queryByText('$315,000 MXN')).not.toBeInTheDocument()
    expect(screen.getAllByTestId('chart')).toHaveLength(1)
  })
  it('tooltip de exposición conserva Total y tres importes exactos autorizados', () => {
    const model = litigationExposureViewModel(adapted(exposure(['200000.1234567890123456789', '90000', '25000'])))
    render(<ExposureTooltip active payload={[{ payload: model.rows[0] }]} />)
    expect(screen.getByText('$315,000.1234567890123456789 MXN')).toBeVisible()
    expect(screen.getByText('$200,000.1234567890123456789 MXN')).toBeVisible()
    expect(screen.getByText('$90,000 MXN')).toBeVisible()
    expect(screen.getByText('$25,000 MXN')).toBeVisible()
  })
})

import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { adaptKpis, KPI_CATALOG } from '../src/features/analytics/adapters.js'
import { incidentsByAreaViewModel } from '../src/features/analytics/viewModels.js'
import { IncidentsByAreaChart } from '../src/features/analytics/charts.jsx'

vi.mock('recharts', () => {
  const Container = ({ children }) => <div>{children}</div>
  const Graph = ({ data, layout, children }) => <div data-testid="chart" data-layout={layout} data-points={JSON.stringify(data)}>{children}</div>
  const Plot = ({ dataKey, stackId }) => <span data-testid="bar" data-key={dataKey} data-stack={stackId} />
  return { ResponsiveContainer: Container, BarChart: Graph, CartesianGrid: () => null, XAxis: () => null, YAxis: () => null, Tooltip: () => null, Bar: Plot, LineChart: Graph, Line: Plot, PieChart: Graph, Pie: Plot, Cell: () => null, LabelList: () => null }
})

const cn03 = (area, nivel_severidad, value, month = '2026-10', availability = 'DISPONIBLE') => ({
  kpi_code: 'KPI-CN-03', name: KPI_CATALOG['KPI-CN-03'].name, unit: 'incidentes', classification: 'MVP-NÚCLEO',
  period_start: `${month}-01`, period_end: `${month}-${month === '2026-09' ? '30' : '31'}`, as_of_date: `${month}-28`, calculated_at: '2026-10-13T04:06:00Z',
  dimensions: { area, nivel_severidad }, entity_filter_applicable: false, availability, value: availability === 'DISPONIBLE' ? value : null,
})
const adapted = (items) => adaptKpis({ items, filters: {}, period_start: null, period_end: null, period_reference: null }).items

describe('SRS_REQUIRED: incidentes por área sin totales derivados (UX-006, DESIGN §16.4, D-UX-7)', () => {
  it('usa solo el último periodo, ordena áreas de mayor a menor (empate alfabético) y conserva cero, ND y ausencia', () => {
    const model = incidentsByAreaViewModel(adapted([
      cn03('Operaciones', 'medio', '3'), cn03('Cumplimiento', 'alto', '3'), cn03('Compras', 'alto', '0'),
      cn03('Finanzas', 'medio', null, '2026-10', 'NO_DISPONIBLE'), cn03('Cumplimiento', 'alto', '9', '2026-09'),
    ]))
    expect(model.periodText).toBe('octubre 2026')
    expect(model.rows.map((row) => row.area)).toEqual(['Cumplimiento', 'Operaciones', 'Compras', 'Finanzas'])
    expect(model.rows[0]).toMatchObject({ alto: 3, altoText: '3', medioText: 'Sin observación' })
    expect(model.rows[2]).toMatchObject({ alto: 0, altoText: '0' })
    expect(model.rows[3]).toMatchObject({ medioText: 'No disponible' })
    expect(model.rows[3].medio).toBeUndefined()
    expect(model.series.map((series) => series.key)).toEqual(['alto', 'medio'])
    expect(JSON.stringify(model)).not.toContain('"9"')
  })
  it('dibuja barras horizontales apiladas por severidad con tabla equivalente y sin columna de total', () => {
    render(<IncidentsByAreaChart items={adapted([cn03('Compras', 'alto', '1'), cn03('Operaciones', 'medio', '2'), cn03('Operaciones', 'bajo', '1')])} />)
    expect(screen.getByTestId('chart')).toHaveAttribute('data-layout', 'vertical')
    expect(screen.getAllByTestId('bar').map((bar) => [bar.dataset.key, bar.dataset.stack])).toEqual([['alto', 'incidents'], ['medio', 'incidents'], ['bajo', 'incidents']])
    const table = screen.getByRole('table', { name: 'Datos de Incidentes por área' })
    expect([...table.querySelectorAll('th')].map((th) => th.textContent)).toEqual(['Área', 'Alto', 'Medio', 'Bajo'])
    expect(table).not.toHaveTextContent('Total')
    expect(screen.getByText('Incidentes de incumplimiento por área y severidad · octubre 2026.')).toBeVisible()
  })
  it('sin observaciones o con todo No disponible conserva el estado vacío sin cero', () => {
    const { unmount } = render(<IncidentsByAreaChart items={[]} />)
    expect(screen.getByLabelText('Incidentes por área: sin datos disponibles')).toBeVisible()
    unmount()
    render(<IncidentsByAreaChart items={adapted([cn03('Compras', 'alto', null, '2026-10', 'NO_DISPONIBLE')])} />)
    expect(screen.getByLabelText('Incidentes por área: no disponible')).toBeVisible()
    expect(screen.queryByTestId('chart')).not.toBeInTheDocument()
  })
})

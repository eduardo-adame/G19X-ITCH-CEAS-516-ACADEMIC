import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { adaptKpis, KPI_CATALOG } from '../src/features/analytics/adapters.js'
import { ExposureEvolutionChart, IncidentsByAreaChart, SeverityChart, TemporalChart, TemporalTooltip } from '../src/features/analytics/charts.jsx'
import { contextLabel, exposureEvolutionViewModel, severityCompositionViewModel } from '../src/features/analytics/viewModels.js'
import { AXIS_UNITS, chartAxisConfig } from '../src/features/analytics/chartAxes.js'

vi.mock('recharts', () => {
  const Container = ({ children }) => <div>{children}</div>
  const Graph = ({ data, children }) => <div data-testid="chart" data-points={JSON.stringify(data)}>{children}</div>
  const Plot = ({ dataKey, children }) => <span data-testid="plot" data-key={dataKey}>{children}</span>
  return { ResponsiveContainer: Container, BarChart: Graph, LineChart: Graph, Cell: () => null, LabelList: () => null, CartesianGrid: () => null, XAxis: () => null, YAxis: () => null, Tooltip: () => null, Line: Plot, Bar: Plot }
})

const month = (value) => {
  const end = new Date(`${value}-01T00:00:00Z`); end.setUTCMonth(end.getUTCMonth() + 1); end.setUTCDate(0)
  return { period_start: `${value}-01`, period_end: end.toISOString().slice(0, 10) }
}
let seq = 0
const observation = (code, value, at, dimensions = {}) => ({ id: `obs-${++seq}`, kpi_code: code, name: KPI_CATALOG[code].name, unit: KPI_CATALOG[code].unit, classification: KPI_CATALOG[code].core ? 'MVP-NÚCLEO' : 'MVP-COMPLEMENTARIO', dimensions, ...month(at), as_of_date: month(at).period_end, calculated_at: '2026-10-18T06:00:00Z', entity_filter_applicable: false, value: value === null ? null : String(value), availability: value === null ? 'NO_DISPONIBLE' : 'DISPONIBLE' })
const adapted = (items) => adaptKpis({ items, filters: {}, period_start: null, period_end: null, period_reference: null }).items
const exposure = (at, levels) => Object.entries(levels).map(([nivel_severidad, value]) => observation('KPI-LI-01', value, at, { nivel_severidad }))

describe('SRS_REQUIRED: evolución de exposición sobre el calendario completo (revisión de gráficas G-2, G-3)', () => {
  it('conserva el mes faltante y el mes «No disponible» sin omitirlos ni imputarlos', () => {
    const model = exposureEvolutionViewModel(adapted([
      ...exposure('2026-04', { alto: 400000, medio: 300000, bajo: 100000 }),
      ...exposure('2026-06', { alto: null, medio: null, bajo: null }),
      ...exposure('2026-07', { alto: 500000 }),
    ]))
    expect(model.rows.map((row) => [row.month, row.availability])).toEqual([['2026-04', 'DISPONIBLE'], ['2026-05', 'NO_OBSERVATION'], ['2026-06', 'NO_DISPONIBLE'], ['2026-07', 'DISPONIBLE']])
    expect(model.rows[0]).toMatchObject({ complete: true, totalText: '$800,000 MXN' })
    expect(model.rows[3]).toMatchObject({ complete: false, totalText: 'No disponible', medioText: 'Sin observación' })
    expect(model.rows[2].alto).toBeUndefined()
    expect(model.rows[2].altoText).toBe('No disponible')
  })
  it('explica los periodos que no generan barra', () => {
    render(<ExposureEvolutionChart items={adapted([...exposure('2026-04', { alto: 4e5, medio: 3e5, bajo: 1e5 }), ...exposure('2026-06', { alto: null, medio: null, bajo: null }), ...exposure('2026-07', { alto: 5e5, medio: 2e5, bajo: 1e5 })])} />)
    expect(screen.getByText('Periodos sin observación: mayo 2026. Periodos no disponibles: junio 2026. Estos periodos no generan una barra.')).toBeVisible()
    expect(screen.getByRole('table', { name: 'Datos de Evolución de exposición acumulada' })).toHaveTextContent('Total')
  })
  it('meses cerrados solo «No disponible» dicen No disponible, no «Aún no existen observaciones»', () => {
    render(<ExposureEvolutionChart items={adapted(['2026-05', '2026-06'].flatMap((at) => exposure(at, { alto: null, medio: null, bajo: null })))} />)
    expect(screen.getByLabelText('Evolución de exposición acumulada: no disponible')).toHaveTextContent('Los meses de la selección tienen observaciones de exposición sin valor disponible.')
    expect(screen.queryByText(/Aún no existen observaciones/)).not.toBeInTheDocument()
  })
  it('todos los importes en cero muestran un estado explícito', () => {
    render(<ExposureEvolutionChart items={adapted(['2026-05', '2026-06'].flatMap((at) => exposure(at, { alto: 0, medio: 0, bajo: 0 })))} />)
    expect(screen.getByLabelText('Evolución de exposición acumulada: exposición en $0')).toBeVisible()
  })
})

describe('SRS_REQUIRED: composición por severidad en barras verticales (revisión de gráficas P-1, G-9)', () => {
  it('presenta las tres severidades y solo calcula total y porcentajes con la partición completa', () => {
    const partial = severityCompositionViewModel(adapted(exposure('2026-10', { alto: 400000, medio: null, bajo: 100000 })))
    expect(partial).toMatchObject({ complete: false, total: null, totalText: 'No disponible', missing: ['Medio'] })
    expect(partial.rows.map((row) => [row.name, row.valueText, row.percentageText])).toEqual([['Alto', '$400,000 MXN', 'No disponible'], ['Medio', 'No disponible', 'No disponible'], ['Bajo', '$100,000 MXN', 'No disponible']])
    render(<SeverityChart items={adapted(exposure('2026-10', { alto: 400000, medio: null, bajo: 100000 }))} />)
    expect(screen.getByText('Periodo: octubre 2026. Total y porcentajes no disponibles: falta medio. No se acumulan periodos históricos.')).toBeVisible()
    expect(JSON.parse(screen.getByTestId('chart').dataset.points).map((row) => row.name)).toEqual(['Alto', 'Medio', 'Bajo'])
  })
  it('con la partición completa informa el total en el subtítulo y dibuja barras de importe', () => {
    render(<SeverityChart items={adapted(exposure('2026-10', { alto: 550000, medio: 540000, bajo: 575000 }))} />)
    expect(screen.getByText(/Total: \$1,665,000 MXN\./)).toBeVisible()
    expect(screen.getByTestId('plot').dataset.key).toBe('value')
  })
  it('un total en cero no deja un hueco: estado explícito con su periodo', () => {
    render(<SeverityChart items={adapted(exposure('2026-10', { alto: 0, medio: 0, bajo: 0 }))} />)
    expect(screen.getByLabelText('Composición por severidad: exposición en $0')).toHaveTextContent('Las tres severidades suman $0 MXN en octubre 2026.')
  })
})

describe('ROBUSTNESS: ceros, avisos y textos (revisión de gráficas G-4 a G-6, G-8)', () => {
  it('incidentes en cero muestran un estado explícito', () => {
    render(<IncidentsByAreaChart items={adapted(['alto', 'medio'].map((nivel_severidad) => observation('KPI-CN-03', 0, '2026-10', { area: 'Compras', nivel_severidad })))} />)
    expect(screen.getByLabelText('Incidentes por área: 0 incidentes')).toHaveTextContent('Ninguna de las áreas registradas tiene incidentes en octubre 2026.')
  })
  it('el tooltip usa el singular: «1 litigio» y «1 día»', () => {
    const { rerender } = render(<TemporalTooltip active payload={[{ payload: { month: '2026-05', periodText: 'mayo 2026', availability: 'DISPONIBLE', rawValue: '1' } }]} unit="litigios" />)
    expect(screen.getByText('1 litigio')).toBeVisible()
    rerender(<TemporalTooltip active payload={[{ payload: { month: '2026-05', periodText: 'mayo 2026', availability: 'DISPONIBLE', rawValue: '1' } }]} unit="días" />)
    expect(screen.getByText('1 día')).toBeVisible()
  })
  it('la línea de tiempo de ciclo explica también los meses «No disponible»', () => {
    render(<TemporalChart items={adapted([observation('KPI-RC-01', 12, '2026-04'), observation('KPI-RC-01', null, '2026-06'), observation('KPI-RC-01', 20, '2026-07')])} kpiCode="KPI-RC-01" title="Tiempo de ciclo del contrato" unit="días" />)
    expect(screen.getByText('Periodos sin observación: mayo 2026. Periodos no disponibles: junio 2026. La línea se interrumpe en estos periodos.')).toBeVisible()
  })
  it('el contexto se nombra en español y el eje en cero no repite marcas', () => {
    expect(contextLabel({ entity: 'Norte', nivel_severidad: 'alto' })).toBe('Entidad: Norte')
    expect(contextLabel({ nivel_severidad: 'alto' })).toBe('Sin dimensiones adicionales')
    expect(chartAxisConfig(AXIS_UNITS.MXN, [0, 0]).ticks).toEqual([0])
  })
})

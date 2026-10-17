import React from 'react'
import { describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { matterVolumePivot } from '../src/features/analytics/viewModels.js'
import { MatterVolumeTable } from '../src/features/analytics/charts.jsx'

const row = (tipo, estado, valueText, period = '2026-10-01', extra = {}) => ({ kpi_code: 'KPI-EO-01', dimensions: { tipo_asunto: tipo, estado, ...extra }, period_start: period, periodText: period === '2026-10-01' ? 'octubre 2026' : 'septiembre 2026', valueText })

describe('ROBUSTNESS: volumen de asuntos Tipo × Estado (UX-010)', () => {
  it('usa solo el último periodo, ordena alfabéticamente y no suma ni imputa celdas', () => {
    const model = matterVolumePivot([row('Litigio', 'Abierto', '3', '2026-09-01'), row('Litigio', 'Abierto', '2'), row('Contrato', 'Cerrado', '5'), row('Contrato', 'Abierto', '1')])
    expect(model.periodText).toBe('octubre 2026')
    expect(model.states).toEqual(['Abierto', 'Cerrado'])
    expect(model.rows.map((item) => item.type)).toEqual(['Contrato', 'Litigio'])
    expect(model.rows[1].values).toEqual({ Abierto: '2', Cerrado: null })
    expect(JSON.stringify(model)).not.toContain('Total')
  })
  it('no arma la tabla si una celda tendría más de una observación', () => {
    expect(matterVolumePivot([row('Litigio', 'Abierto', '2', '2026-10-01', { entity: 'A' }), row('Litigio', 'Abierto', '4', '2026-10-01', { entity: 'B' })])).toBeNull()
    expect(matterVolumePivot([])).toBeNull()
  })
  it('una combinación sin observación se muestra como «Sin dato», nunca como cero', () => {
    render(<MatterVolumeTable items={[row('Litigio', 'Abierto', '2'), row('Contrato', 'Cerrado', '5')]} />)
    const table = screen.getByRole('region', { name: 'Volumen de asuntos por tipo y estado' })
    expect(within(table).getAllByText('Sin dato')).toHaveLength(2)
    expect(within(table).queryByText('0')).not.toBeInTheDocument()
  })
})

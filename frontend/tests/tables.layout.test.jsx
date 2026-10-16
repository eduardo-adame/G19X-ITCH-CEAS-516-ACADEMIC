import React from 'react'
import { describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { DataTable } from '../src/components/data.jsx'
import { ruleLabel, ruleShortLabel } from '../src/features/analytics/adapters.js'

const rows = [{ id: 'a', name: 'Contratos próximos a vencimiento sin revisión', value: '$1,250,000.50 MXN', when: '15 oct 2026, 10:05' }]

describe('ROBUSTNESS: distribución de columnas en tablas', () => {
  it('las columnas numéricas alinean encabezado y celdas a la derecha y no se parten', () => {
    render(<DataTable caption="Prueba" rows={rows} columns={[{ key: 'name', label: 'Indicador', wide: true }, { key: 'value', label: 'Valor', numeric: true }, { key: 'when', label: 'Calculado', nowrap: true }]} />)
    const table = screen.getByRole('table')
    expect(within(table).getByRole('columnheader', { name: 'Valor' })).toHaveClass('text-right')
    expect(within(table).getByRole('cell', { name: '$1,250,000.50 MXN' })).toHaveClass('text-right', 'whitespace-nowrap')
    expect(within(table).getByRole('cell', { name: rows[0].name })).toHaveClass('cell-wide')
    expect(within(table).getByRole('cell', { name: rows[0].when })).toHaveClass('whitespace-nowrap')
    expect(within(table).getByRole('columnheader', { name: 'Indicador' })).not.toHaveClass('text-right')
  })

  it('las columnas de acción fijas van al final aunque se declaren antes', () => {
    render(<DataTable caption="Prueba" rows={rows} columns={[{ key: 'actions', label: 'Acciones', fit: true, sticky: true, render: () => 'Corregir' }, { key: 'name', label: 'Indicador' }, { key: 'detail', label: 'Detalle', fit: true, render: () => 'Ver' }]} />)
    const headers = within(screen.getByRole('table')).getAllByRole('columnheader').map((header) => header.textContent)
    expect(headers).toEqual(['Indicador', 'Detalle', 'Acciones'])
    expect(within(screen.getByRole('table')).getByRole('columnheader', { name: 'Acciones' })).toHaveClass('cell-sticky')
    expect(within(screen.getByRole('table')).getByRole('cell', { name: 'Corregir' })).toHaveClass('cell-sticky')
    expect(within(screen.getByRole('table')).getByRole('cell', { name: 'Ver' })).not.toHaveClass('cell-text')
  })

  it('las reglas comunes del análisis tienen rótulo y la tabla usa una forma breve', () => {
    expect(ruleLabel('TREND_STRICT_THREE_MONTH')).toBe('Tendencia de tres meses consecutivos')
    expect(ruleLabel('RECURRENCE_THREE_OF_FOUR')).toBe('Recurrencia en 3 de los últimos 4 meses')
    expect(ruleShortLabel('RC03_APPEARANCE_OR_INCREASE')).toBe('Aparición o aumento')
    expect(ruleShortLabel('LI01_STRICT_THREE_MONTH_INCREASE')).toBe('Aumento tres meses seguidos')
    expect(ruleShortLabel('REGLA_DESCONOCIDA')).toBe('Regla persistida de análisis')
  })
})

import React, { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CursorPager, DateRangeFields, FilterToolbar, ResultsSummary, SearchField, useDebouncedCallback } from '../src/components/filters.jsx'
import { Select } from '../src/components/controls.jsx'

function setNarrow(narrow) {
  window.matchMedia = vi.fn(() => ({ matches: narrow, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
}
afterEach(() => { delete window.matchMedia; vi.useRealTimers() })

const primary = <Select label="Familia" value="" onChange={() => {}} options={[{ value: '', label: 'Todas' }]} />

describe('ROBUSTNESS: barra de filtros (DESIGN §19)', () => {
  it('escritorio: controles en línea, «Más filtros» con contador y chips con «Limpiar todo»', async () => {
    const remove = vi.fn(); const clear = vi.fn()
    render(<FilterToolbar primary={primary} secondary={<SearchField label="Identificador" onApply={() => {}} />} secondaryActive={1} chips={[{ id: 'f', label: 'Familia: Litigios', onRemove: remove }]} onClearAll={clear} />)
    expect(screen.getByLabelText('Familia')).toBeVisible()
    const more = screen.getByRole('button', { name: 'Más filtros (1)' })
    expect(more).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByLabelText('Identificador')).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'Quitar filtro Familia: Litigios' }))
    expect(remove).toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Limpiar todo' }))
    expect(clear).toHaveBeenCalled()
  })
  it('móvil: botón «Filtros (n)» que despliega un panel y «Ver resultados» lo cierra devolviendo el foco', async () => {
    setNarrow(true)
    render(<FilterToolbar primary={primary} chips={[{ id: 'f', label: 'Familia: Litigios', onRemove: () => {} }]} />)
    const toggle = screen.getByRole('button', { name: 'Filtros (1)' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByLabelText('Familia')).not.toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Filtros activos' })).toHaveTextContent('Familia: Litigios')
    await userEvent.click(toggle)
    expect(screen.getByLabelText('Familia')).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'Ver resultados' }))
    expect(screen.queryByLabelText('Familia')).not.toBeInTheDocument()
    expect(toggle).toHaveFocus()
  })
  it('sin filtros activos no hay fila de chips', () => {
    render(<FilterToolbar primary={primary} />)
    expect(screen.queryByRole('group', { name: 'Filtros activos' })).not.toBeInTheDocument()
  })
})

describe('ROBUSTNESS: campos con validación en línea', () => {
  it('SearchField aplica con Enter; un valor inválido se marca y no se aplica', async () => {
    const apply = vi.fn()
    render(<SearchField label="Identificador" validate={(value) => value.length === 4} invalidMessage="Cuatro caracteres." onApply={apply} />)
    const input = screen.getByLabelText('Identificador')
    await userEvent.type(input, 'ab{Enter}')
    expect(screen.getByRole('alert')).toHaveTextContent('Cuatro caracteres.')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(apply).not.toHaveBeenCalled()
    await userEvent.type(input, 'cd{Enter}')
    expect(apply).toHaveBeenCalledWith('abcd')
    expect(input).toHaveAttribute('aria-invalid', 'false')
  })
  it('SearchField aplica sola tras la pausa al escribir', async () => {
    vi.useFakeTimers()
    const apply = vi.fn()
    render(<SearchField label="Nombre" onApply={apply} />)
    fireEvent.change(screen.getByLabelText('Nombre'), { target: { value: 'contrato' } })
    expect(apply).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(450))
    expect(apply).toHaveBeenCalledWith('contrato')
  })
  it('DateRangeFields: «Hasta» acotado por «Desde»; un rango invertido se señala y no se notifica', () => {
    const change = vi.fn()
    render(<DateRangeFields fromLabel="Retenido desde" toLabel="Retenido hasta" onChange={change} />)
    fireEvent.change(screen.getByLabelText('Retenido desde'), { target: { value: '2030-02-01' } })
    expect(change).toHaveBeenLastCalledWith({ from: '2030-02-01', to: '' })
    expect(screen.getByLabelText('Retenido hasta')).toHaveAttribute('min', '2030-02-01')
    fireEvent.change(screen.getByLabelText('Retenido hasta'), { target: { value: '2030-01-01' } })
    expect(change).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('alert')).toHaveTextContent('Debe ser igual o posterior a «Retenido desde».')
    expect(screen.getByLabelText('Retenido hasta')).toHaveAttribute('aria-invalid', 'true')
  })
})

describe('ROBUSTNESS: resultado, paginación y agrupación de cambios', () => {
  it('ResultsSummary anuncia el número de elementos y si hay más páginas', () => {
    const { rerender } = render(<ResultsSummary count={25} hasMore />)
    expect(screen.getByRole('status')).toHaveTextContent('25 elementos · hay más páginas')
    rerender(<ResultsSummary count={0} />)
    expect(screen.getByRole('status')).toHaveTextContent('Sin resultados para estos filtros')
  })
  it('CursorPager ofrece anterior/siguiente y «Primera página» al entrar por un enlace con cursor', () => {
    const { rerender } = render(<CursorPager hasNext hasPrevious onNext={() => {}} onPrevious={() => {}} />)
    expect(within(screen.getByRole('navigation', { name: 'Paginación' })).getAllByRole('button').map((button) => button.textContent)).toEqual(['Página anterior', 'Página siguiente'])
    rerender(<CursorPager hasNext={false} hasPrevious={false} atDeepLink onFirst={() => {}} />)
    expect(screen.getByRole('button', { name: 'Primera página' })).toBeVisible()
  })
  it('useDebouncedCallback agrupa cambios rápidos (flechas del teclado) en una sola aplicación', () => {
    vi.useFakeTimers()
    const apply = vi.fn()
    function Probe() { const [value, setValue] = useState(''); const schedule = useDebouncedCallback(apply, 250); return <input aria-label="probe" value={value} onChange={(event) => { setValue(event.target.value); schedule(event.target.value) }} /> }
    render(<Probe />)
    for (const value of ['a', 'b', 'c', 'd', 'e']) fireEvent.change(screen.getByLabelText('probe'), { target: { value } })
    act(() => vi.advanceTimersByTime(300))
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledWith('e')
  })
})

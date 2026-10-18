import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Loading, SessionLoading } from '../src/components/feedback.jsx'
import { ICONS, navigationIcon } from '../src/components/Icon.jsx'
import { APP_NAME } from '../src/shared/brand.js'

afterEach(() => vi.useRealTimers())

describe('ROBUSTNESS: carga inicial de sesión con marca y barra (decisión del usuario, 2026-10-18)', () => {
  it('no parpadea: antes de 300 ms solo anuncia el estado a lectores de pantalla', () => {
    vi.useFakeTimers()
    render(<SessionLoading />)
    expect(screen.getByRole('status')).toHaveTextContent('Comprobando tu sesión…')
    expect(screen.queryByText(APP_NAME)).not.toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(300) })
    expect(screen.getByText(APP_NAME)).toBeInTheDocument()
    expect(document.querySelector('.loading-track')).not.toBeNull()
  })
  it('a los 8 s explica la demora y ofrece reintentar', async () => {
    vi.useFakeTimers()
    const onRetry = vi.fn()
    render(<SessionLoading onRetry={onRetry} />)
    act(() => { vi.advanceTimersByTime(8000) })
    expect(screen.getByText('Está tardando más de lo habitual.')).toBeInTheDocument()
    vi.useRealTimers()
    await userEvent.click(screen.getByRole('button', { name: 'Reintentar' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })
  it('las cargas dentro de una vista llevan la barra compacta y su texto', () => {
    render(<Loading label="Comprobando acceso al documento…" />)
    expect(screen.getByRole('status')).toHaveTextContent('Comprobando acceso al documento…')
    expect(document.querySelector('.loading-track-compact')).not.toBeNull()
  })
})

describe('ROBUSTNESS: nombre e iconos del menú (decisión del usuario, 2026-10-18)', () => {
  it('el sistema se llama Legaltech', () => { expect(APP_NAME).toBe('Legaltech') })
  it('cada módulo usa el icono aprobado y Consulta documental el de IA', () => {
    expect(Object.fromEntries(['/', '/litigios', '/tendencias', '/consulta', '/documentos', '/administracion'].map((path) => [path, navigationIcon(path)]))).toEqual({
      '/': 'summary', '/litigios': 'litigation', '/tendencias': 'trend', '/consulta': 'assistant', '/documentos': 'library', '/administracion': 'administration',
    })
    expect(ICONS.assistant).toContain('M259.92 262.91')
    expect(ICONS.litigation).toMatch(/^data:image\/svg\+xml;utf8,<svg/)
    expect(ICONS.litigation).toContain('ionicon-stroke-width')
  })
})

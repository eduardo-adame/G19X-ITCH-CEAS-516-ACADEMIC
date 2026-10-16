import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { SessionProvider } from '../src/auth/SessionProvider.jsx'
import { AppShell } from '../src/components/layout.jsx'
import { Clock, initialsOf, ThemeToggle, UserBadge } from '../src/components/topbar.jsx'
import { validatePrincipal } from '../src/auth/permissions.js'
import { formatClock } from '../src/shared/presentation.js'
import { initTheme } from '../src/shared/theme.js'

const id = '11111111-1111-4111-8111-111111111111'
const principal = Object.freeze({ id, username: 'analista.norte', displayName: 'Ana Martínez', roles: ['ANALISTA', 'JURIDICO'] })
function mountShell(logout = vi.fn(async () => {})) {
  const snapshot = { status: 'authenticated', principal, generation: 1 }
  const manager = { client: { request: vi.fn(), acquireRead: vi.fn(), abortAll: vi.fn() }, getSnapshot: () => snapshot, subscribe: () => () => {}, restore: vi.fn(), revalidate: vi.fn(async () => true), logout }
  render(<SessionProvider manager={manager}><MemoryRouter><Routes><Route element={<AppShell navigation={[]} />}><Route path="/" element={<h1>Vista sintética</h1>} /></Route></Routes></MemoryRouter></SessionProvider>)
  return logout
}
function setSystemDark(dark) {
  window.matchMedia = vi.fn(() => ({ matches: dark, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
}
beforeEach(() => { document.documentElement.removeAttribute('data-theme'); window.localStorage.clear() })
afterEach(() => { delete window.matchMedia; vi.useRealTimers(); vi.restoreAllMocks() })

describe('SRS_REQUIRED: confirmación al cerrar sesión', () => {
  it('«Cerrar sesión» abre un diálogo con el foco en «Cancelar» y no cierra la sesión', async () => {
    const logout = mountShell()
    await userEvent.click(screen.getAllByRole('button', { name: 'Cerrar sesión' })[0])
    const dialog = screen.getByRole('dialog', { name: '¿Cerrar sesión?' })
    expect(dialog).toHaveTextContent('Se cerrará tu sesión en este navegador. Las consultas y resultados en pantalla no se conservan.')
    expect(within(dialog).getByRole('button', { name: 'Cancelar' })).toHaveFocus()
    expect(logout).not.toHaveBeenCalled()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(logout).not.toHaveBeenCalled()
  })
  it('Escape cancela y confirmar cierra la sesión', async () => {
    const logout = mountShell()
    await userEvent.click(screen.getAllByRole('button', { name: 'Cerrar sesión' })[0])
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await userEvent.click(screen.getAllByRole('button', { name: 'Cerrar sesión' })[0])
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cerrar sesión' }))
    expect(logout).toHaveBeenCalledTimes(1)
  })
  it('un fallo al cerrar se muestra dentro del diálogo', async () => {
    mountShell(vi.fn(async () => { throw new Error('Detalle interno') }))
    await userEvent.click(screen.getAllByRole('button', { name: 'Cerrar sesión' })[0])
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cerrar sesión' }))
    const alert = await within(screen.getByRole('dialog')).findByRole('alert')
    expect(alert).toHaveTextContent('No se pudo cerrar la sesión')
    expect(alert).not.toHaveTextContent('Detalle interno')
  })
})

describe('ROBUSTNESS: usuario y fecha en la barra superior', () => {
  it('muestra nombre asignado, usuario y rol', () => {
    mountShell()
    const topbar = screen.getByText('Ana Martínez').closest('div.flex')
    expect(topbar).toHaveTextContent('analista.norte · Analista · Jurídico')
    expect(initialsOf('Ana Martínez')).toBe('AM')
    expect(initialsOf('analista.norte')).toBe('AN')
  })
  it('el nombre asignado se valida y, si falta, se usa el usuario', () => {
    expect(validatePrincipal({ id, username: 'u.1', display_name: '  Ana  ', roles: ['TI'] }).displayName).toBe('Ana')
    expect(validatePrincipal({ id, username: 'u.1', roles: ['TI'] }).displayName).toBe('u.1')
    expect(validatePrincipal({ id, username: 'u.1', display_name: 7, roles: ['TI'] }).displayName).toBe('u.1')
  })
  it('la versión compacta (móvil) conserva el nombre completo para lectores de pantalla', () => {
    render(<UserBadge principal={principal} compact />)
    expect(screen.getByText('Ana Martínez, usuario analista.norte, Analista · Jurídico')).toHaveClass('sr-only')
  })
  it('fecha y hora con día de la semana, sin «UTC», y cambio al empezar el minuto', () => {
    expect(formatClock(new Date(2026, 9, 16, 10, 42, 30))).toEqual({ long: 'viernes, 16 oct 2026 · 10:42', short: '16 oct, 10:42', iso: '2026-10-16T10:42' })
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] })
    vi.setSystemTime(new Date(2026, 9, 16, 10, 42, 50))
    render(<Clock />)
    expect(screen.getByText('viernes, 16 oct 2026 · 10:42')).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(10000))
    expect(screen.getByText('viernes, 16 oct 2026 · 10:43')).toBeInTheDocument()
    expect(document.querySelector('time')).toHaveAttribute('datetime', '2026-10-16T10:43')
    expect(document.querySelector('time').closest('[aria-live]')).toBeNull()
  })
})

describe('ROBUSTNESS: tema claro/oscuro', () => {
  it('sin elección guardada parte del sistema y no escribe nada', () => {
    setSystemDark(true)
    const write = vi.spyOn(Storage.prototype, 'setItem')
    render(<ThemeToggle />)
    expect(screen.getByRole('button', { name: 'Tema oscuro' })).toHaveAttribute('aria-pressed', 'true')
    expect(write).not.toHaveBeenCalled()
    expect(document.documentElement).not.toHaveAttribute('data-theme')
  })
  it('alternar aplica el tema y guarda solo la preferencia', async () => {
    setSystemDark(false)
    render(<ThemeToggle />)
    const button = screen.getByRole('button', { name: 'Tema oscuro' })
    expect(button).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(button)
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    expect(button).toHaveAttribute('aria-pressed', 'true')
    expect(window.localStorage.getItem('riesgo-legal.tema')).toBe('oscuro')
    expect(window.localStorage.length).toBe(1)
    await userEvent.click(button)
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    expect(window.localStorage.getItem('riesgo-legal.tema')).toBe('claro')
  })
  it('la elección guardada se aplica antes del render y un valor desconocido se ignora', () => {
    window.localStorage.setItem('riesgo-legal.tema', 'oscuro')
    initTheme()
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    document.documentElement.removeAttribute('data-theme')
    window.localStorage.setItem('riesgo-legal.tema', '<script>')
    initTheme()
    expect(document.documentElement).not.toHaveAttribute('data-theme')
  })
  it('sin almacenamiento disponible el botón sigue funcionando', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('bloqueado') })
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('bloqueado') })
    setSystemDark(false)
    render(<ThemeToggle />)
    await userEvent.click(screen.getByRole('button', { name: 'Tema oscuro' }))
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
  })
})

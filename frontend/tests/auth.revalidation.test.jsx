import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useNavigate } from 'react-router-dom'
import { createSessionManager, SESSION_REVALIDATION_FAILED, SessionProvider } from '../src/auth/SessionProvider.jsx'
import { LoginPage } from '../src/auth/LoginPage.jsx'

const principal = { id: '11111111-1111-4111-8111-111111111111', username: 'cuenta-sintetica', roles: ['JURIDICO'] }
const token = { access_token: 'acceso-sintetico-no-operativo', token_type: 'bearer' }
const response = (status, data) => ({ status, ok: status >= 200 && status < 300, json: async () => data })
const notice = 'No fue posible validar tu sesión. Inicia sesión nuevamente.'
function setup(failure) {
  let failed = false
  const fetchImpl = vi.fn(async (path) => {
    if (failed && path.endsWith('/me')) {
      if (failure === 'network') throw new TypeError('Detalle interno sintético que no debe mostrarse')
      return response(failure, { detail: 'Detalle interno sintético que no debe mostrarse' })
    }
    return response(200, path.endsWith('/refresh') || path.endsWith('/login') ? token : principal)
  })
  return { manager: createSessionManager(fetchImpl), fetchImpl, fail() { failed = true }, recover() { failed = false } }
}

describe('SRS_REQUIRED: revalidación fail closed y causa segura', () => {
  it.each([401, 403, 500, 503, 'network'])('retira principal y token tras fallo%s', async (failure) => {
    const { manager, fail } = setup(failure)
    await manager.restore(); const generation = manager.getSnapshot().generation; fail()
    expect(await manager.revalidate()).toBe(false)
    expect(manager.getSnapshot()).toMatchObject({ status: 'anonymous', principal: null, generation: generation + 1 })
    expect(manager.getSnapshot()).not.toHaveProperty('token')
    expect(manager.getSnapshot().sessionReason).toBe([500, 503, 'network'].includes(failure) ? SESSION_REVALIDATION_FAILED : null)
    await expect(manager.client.request('/rag/query', { method: 'POST' })).rejects.toMatchObject({ status: 401 })
  })
  it('muestra y consume el motivo técnico sin revelar el cuerpo ni persistirlo', async () => {
    const { manager, fail } = setup(500); await manager.restore(); fail(); await manager.revalidate()
    render(<SessionProvider manager={manager}><MemoryRouter initialEntries={['/login']}><LoginPage /></MemoryRouter></SessionProvider>)
    expect(await screen.findByRole('alert')).toHaveTextContent(notice)
    expect(screen.queryByText(/Detalle interno/)).not.toBeInTheDocument()
    expect(manager.getSnapshot().sessionReason).toBeNull()
    expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0)
  })
  it('login posterior elimina el motivo y recupera solo la identidad nueva', async () => {
    const { manager, fail, recover } = setup('network'); await manager.restore(); fail(); await manager.revalidate()
    recover(); await manager.login('cuenta-sintetica', 'clave-sintetica')
    expect(manager.getSnapshot()).toMatchObject({ status: 'authenticated', principal, sessionReason: null })
  })
  it('logout normal no se presenta como fallo técnico', async () => {
    const { manager } = setup(500); await manager.restore(); await manager.logout()
    expect(manager.getSnapshot()).toMatchObject({ status: 'anonymous', sessionReason: null, sessionError: null })
  })
})

describe('ROBUSTNESS: consumo y generaciones de revalidación', () => {
  it('conserva causa técnica de me tras renovación401 sin recursión', async () => {
    let failed = false, me = 0
    const fetchImpl = vi.fn(async (path) => {
      if (path.endsWith('/me') && failed) return response(++me === 1 ? 401 : 500)
      return response(200, path.endsWith('/refresh') ? token : principal)
    })
    const manager = createSessionManager(fetchImpl); await manager.restore(); failed = true
    expect(await manager.revalidate()).toBe(false)
    expect(manager.getSnapshot()).toMatchObject({ status: 'anonymous', sessionReason: SESSION_REVALIDATION_FAILED })
    expect(me).toBe(2)
  })
  it('conserva causa técnica de refresh tras me401', async () => {
    let failed = false
    const manager = createSessionManager(async (path) => response(failed ? path.endsWith('/refresh') ? 503 : 401 : 200, path.endsWith('/refresh') ? token : principal))
    await manager.restore(); failed = true; await manager.revalidate()
    expect(manager.getSnapshot().sessionReason).toBe(SESSION_REVALIDATION_FAILED)
  })
  it('una respuesta tardía no borra ni explica una sesión posterior', async () => {
    let failed = false, release
    const pending = new Promise((resolve) => { release = resolve })
    const manager = createSessionManager(async (path) => failed && path.endsWith('/me') ? pending : response(200, path.endsWith('/refresh') || path.endsWith('/login') ? token : principal))
    await manager.restore(); failed = true; const old = manager.revalidate(); failed = false
    await manager.login('cuenta-sintetica', 'clave-sintetica'); const generation = manager.getSnapshot().generation
    release(response(500)); await old
    expect(manager.getSnapshot()).toMatchObject({ status: 'authenticated', principal, generation, sessionReason: null })
  })
  it('solo acepta la razón de la allowlist', async () => {
    const { manager } = setup(500); await manager.restore()
    manager.invalidate('Detalle interno no permitido')
    expect(manager.getSnapshot().sessionReason).toBeNull()
  })
  it('una nueva entrada al login no hereda el aviso consumido', async () => {
    const { manager, fail } = setup(500); await manager.restore(); fail(); await manager.revalidate()
    const mount = () => render(<SessionProvider manager={manager}><MemoryRouter initialEntries={['/login']}><LoginPage /></MemoryRouter></SessionProvider>)
    const view = mount(); expect(await screen.findByText(notice)).toBeVisible(); view.unmount()
    mount(); expect(screen.queryByText(notice)).not.toBeInTheDocument()
  })
  it('invalidación explícita retira el aviso ya mostrado', async () => {
    const { manager, fail } = setup(500); await manager.restore(); fail(); await manager.revalidate()
    render(<SessionProvider manager={manager}><MemoryRouter><LoginPage /></MemoryRouter></SessionProvider>)
    expect(await screen.findByText(notice)).toBeVisible()
    await act(async () => manager.invalidate())
    expect(screen.queryByText(notice)).not.toBeInTheDocument()
  })
  it('Back no restaura el aviso si login permanece montado entre entradas', async () => {
    const { manager, fail } = setup(500); await manager.restore(); fail(); await manager.revalidate()
    function Navigation() {
      const navigate = useNavigate()
      return <><button onClick={() => navigate('/login?entrada=sintetica')}>Otra entrada</button><button onClick={() => navigate(-1)}>Atrás</button><LoginPage /></>
    }
    render(<SessionProvider manager={manager}><MemoryRouter initialEntries={['/login']}><Navigation /></MemoryRouter></SessionProvider>)
    expect(await screen.findByText(notice)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Otra entrada' })); expect(screen.queryByText(notice)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Atrás' })); expect(screen.queryByText(notice)).not.toBeInTheDocument()
  })
})

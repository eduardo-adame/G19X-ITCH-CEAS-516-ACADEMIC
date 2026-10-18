import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { SessionProvider } from '../src/auth/SessionProvider.jsx'
import { AppShell } from '../src/components/layout.jsx'
import { PasswordInput } from '../src/components/controls.jsx'
import { OfflineNotice } from '../src/components/help.jsx'
import { AnswerText, EvidenceCard } from '../src/features/rag/components.jsx'

afterEach(() => { vi.restoreAllMocks(); document.title = '' })
const principal = Object.freeze({ id: '11111111-1111-4111-8111-111111111111', username: 'ana.m', displayName: 'Ana Martínez', roles: ['JURIDICO'], permissions: ['dashboard.read', 'document.query'] })
function shell(path) {
  const snapshot = { status: 'authenticated', principal, generation: 1 }
  const manager = { client: { request: vi.fn(), acquireRead: vi.fn(), abortAll: vi.fn() }, getSnapshot: () => snapshot, subscribe: () => () => {}, restore: vi.fn(), revalidate: vi.fn(async () => true), logout: vi.fn() }
  const navigation = [{ id: 'a', path: '/', label: 'Resumen ejecutivo', capability: 'dashboard.read' }, { id: 'b', path: '/documentos', label: 'Visor documental', capability: 'document.query' }]
  render(<SessionProvider manager={manager}><MemoryRouter initialEntries={[path]}><Routes><Route element={<AppShell navigation={navigation} />}><Route path="/" element={<h1>Inicio</h1>} /><Route path="/documentos" element={<h1>Visor</h1>} /><Route path="*" element={<h1>Otra</h1>} /></Route></Routes></MemoryRouter></SessionProvider>)
}

describe('ROBUSTNESS: título de la pestaña por vista', () => {
  it.each([['/', 'Resumen ejecutivo · Legaltech'], ['/documentos', 'Visor documental · Legaltech'], ['/desconocida', 'Legaltech']])('%s → %s', (path, title) => {
    shell(path)
    expect(document.title).toBe(title)
  })
})

describe('ROBUSTNESS: aviso sin conexión', () => {
  it('aparece al perder la red y desaparece al recuperarla', () => {
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    const { container } = render(<OfflineNotice />)
    const region = container.querySelector('[aria-live="polite"]')
    expect(region).toBeEmptyDOMElement()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    online.mockReturnValue(false); act(() => window.dispatchEvent(new Event('offline')))
    expect(region).toHaveTextContent('Sin conexión de red.')
    expect(screen.getByRole('status')).toHaveTextContent('Sin conexión de red.')
    online.mockReturnValue(true); act(() => window.dispatchEvent(new Event('online')))
    expect(region).toBeEmptyDOMElement()
  })
})

describe('ROBUSTNESS: contraseña con «Mostrar» y Bloq Mayús', () => {
  function Controlled() {
    const [value, setValue] = React.useState('')
    return <form onSubmit={(event) => { event.preventDefault(); setValue('') }}><PasswordInput label="Contraseña" value={value} onChange={(event) => setValue(event.target.value)} /><button type="submit">Enviar</button></form>
  }
  it('muestra y oculta, y vuelve a ocultarse al vaciarse tras enviar', async () => {
    render(<Controlled />)
    const field = screen.getByLabelText('Contraseña')
    expect(field).toHaveAttribute('type', 'password')
    await userEvent.type(field, 'secreto')
    await userEvent.click(screen.getByRole('button', { name: 'Mostrar contraseña' }))
    expect(field).toHaveAttribute('type', 'text')
    expect(screen.getByRole('button', { name: 'Ocultar contraseña' })).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(screen.getByRole('button', { name: 'Enviar' }))
    expect(field).toHaveAttribute('type', 'password')
    expect(field).toHaveValue('')
  })
  it('avisa de Bloq Mayús mientras está activo', () => {
    render(<PasswordInput label="Contraseña" name="password" />)
    const field = screen.getByLabelText('Contraseña')
    fireEvent.keyDown(field, { key: 'A', modifierCapsLock: true })
    expect(screen.getByText('Bloq Mayús está activado.')).toBeVisible()
    expect(field.getAttribute('aria-describedby')).toContain('-caps')
    fireEvent.keyUp(field, { key: 'A', modifierCapsLock: false })
    expect(screen.queryByText('Bloq Mayús está activado.')).not.toBeInTheDocument()
  })
  it('en formularios no controlados se oculta al enviar', async () => {
    render(<form onSubmit={(event) => event.preventDefault()}><PasswordInput label="Contraseña nueva" name="password" /><button type="submit">Aplicar</button></form>)
    await userEvent.click(screen.getByRole('button', { name: 'Mostrar contraseña' }))
    expect(screen.getByLabelText('Contraseña nueva')).toHaveAttribute('type', 'text')
    await userEvent.click(screen.getByRole('button', { name: 'Aplicar' }))
    expect(screen.getByLabelText('Contraseña nueva')).toHaveAttribute('type', 'password')
  })
})

describe('ROBUSTNESS: la marca [En] señala su fuente', () => {
  const fragment = { fragmentId: '33333333-3333-4333-8333-333333333333', documentId: 'DOC-1', documentName: 'Contrato sintético', documentType: 'PDF', documentDate: null, pageStart: 2, pageEnd: 2, section: null, clause: null, text: 'Texto sintético.', usage: 'EVIDENCE' }
  function Answer() {
    const [highlighted, setHighlighted] = React.useState(null)
    return <MemoryRouter><AnswerText text="Respuesta [E1]." citations={[{ handle: 'E1', ...fragment }]} onHighlight={setHighlighted} /><EvidenceCard fragment={fragment} handle="E1" highlighted={highlighted === fragment.fragmentId} /></MemoryRouter>
  }
  it('pasar el cursor o el foco por [E1] resalta la tarjeta de su fuente', () => {
    render(<Answer />)
    const mark = screen.getByRole('button', { name: 'Ir a la fuente E1: Contrato sintético' })
    const card = screen.getByRole('article', { name: 'Fuente E1: Contrato sintético' })
    fireEvent.mouseEnter(mark); expect(card).toHaveClass('source-highlight')
    fireEvent.mouseLeave(mark); expect(card).not.toHaveClass('source-highlight')
    fireEvent.focus(mark); expect(card).toHaveClass('source-highlight')
    fireEvent.blur(mark); expect(card).not.toHaveClass('source-highlight')
  })
})

describe('ROBUSTNESS: aviso en el acceso tras cambiar los propios permisos (certificación O-4)', () => {
  it('la marca caduca a los dos minutos y se consume una sola vez', async () => {
    const { notePermissionChange, consumePermissionChange } = await import('../src/auth/sessionNotice.js')
    notePermissionChange(1000); expect(consumePermissionChange(1000 + 119000)).toBe(true); expect(consumePermissionChange(1000 + 119000)).toBe(false)
    notePermissionChange(1000); expect(consumePermissionChange(1000 + 121000)).toBe(false)
  })
  it('la pantalla de acceso explica el cierre y el aviso desaparece al volver a entrar', async () => {
    const { notePermissionChange } = await import('../src/auth/sessionNotice.js')
    const { LoginPage } = await import('../src/auth/LoginPage.jsx')
    notePermissionChange()
    const snapshot = { status: 'anonymous', principal: null, generation: 2 }
    const manager = { client: { request: vi.fn(), acquireRead: vi.fn(), abortAll: vi.fn() }, getSnapshot: () => snapshot, subscribe: () => () => {}, restore: vi.fn(), revalidate: vi.fn(), login: vi.fn(async () => { throw new Error('x') }) }
    // En modo estricto React repite los inicializadores: el aviso debe sobrevivir a esa repetición.
    render(<React.StrictMode><SessionProvider manager={manager}><MemoryRouter><LoginPage /></MemoryRouter></SessionProvider></React.StrictMode>)
    expect(screen.getByText(/Tu sesión se cerró porque cambiaste permisos que también se aplican a tu cuenta/)).toBeVisible()
    await userEvent.type(screen.getByLabelText('Usuario'), 'ti'); await userEvent.type(screen.getByLabelText('Contraseña', { exact: true }), 'Contrasena-larga')
    await userEvent.click(screen.getByRole('button', { name: 'Iniciar sesión' }))
    expect(screen.queryByText(/Tu sesión se cerró porque cambiaste permisos/)).not.toBeInTheDocument()
  })
})

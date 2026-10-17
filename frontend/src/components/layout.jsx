import React, { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useSession } from '../auth/SessionProvider.jsx'
import { can } from '../auth/permissions.js'
import { Button } from './controls.jsx'
import { ErrorState } from './feedback.jsx'
import { Icon, navigationIcon } from './Icon.jsx'
import { Clock, ThemeToggle, UserBadge } from './topbar.jsx'
import { OfflineNotice } from './help.jsx'

export const APP_NAME = 'Riesgo Legal'
// Título de la pestaña por vista. Nunca incluye nombres de documentos ni datos, para que no queden en el historial.
export function usePageTitle(title) {
  useEffect(() => { document.title = title ? `${title} · ${APP_NAME}` : APP_NAME }, [title])
}

// Contiene un error de renderizado de la vista actual: la navegación sigue disponible y no queda una
// pantalla en blanco. Solo se reinicia tras un error al cambiar de ruta; no remonta las vistas (la consulta
// documental conserva en memoria su resultado al abrir el visor).
class ViewBoundary extends React.Component {
  constructor(props) { super(props); this.state = { failed: false } }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidUpdate(previous) { if (this.state.failed && previous.resetKey !== this.props.resetKey) this.setState({ failed: false }) }
  render() {
    if (!this.state.failed) return this.props.children
    return <section role="alert" className="rounded-panel border border-[var(--critical-border)] bg-[var(--critical-subtle)] p-5"><h2 className="text-sm font-semibold">No se pudo mostrar esta vista</h2><p className="mt-1 text-secondary">Ocurrió un error al presentar la información. Los datos no se modificaron.</p><Button className="mt-3" variant="secondary" onClick={() => window.location.reload()}>Recargar la página</Button></section>
  }
}

export function PageHeader({ title, description, actions }) { return <header className="flex flex-wrap items-end justify-between gap-4 pb-4"><div><h1 className="text-2xl font-semibold tracking-tight">{title}</h1>{description && <p className="mt-1 text-[13px] text-secondary">{description}</p>}</div>{actions}</header> }
export function Modal({ open, title, onClose, children, drawer = false, initialFocus = null }) {
  const panel = useRef(null); const close = useRef(onClose); close.current = onClose
  const titleId = useId()
  useEffect(() => {
    if (!open) return
    const previousFocus = document.activeElement
    const previousOverflow = document.body.style.overflow
    const overlay = panel.current.parentElement
    const siblings = [...document.body.children].filter((element) => element !== overlay)
    const previous = siblings.map((element) => [element, element.inert, element.getAttribute('aria-hidden')])
    siblings.forEach((element) => { element.inert = true; element.setAttribute('aria-hidden', 'true') })
    document.body.style.overflow = 'hidden'
    const focusable = () => [...panel.current.querySelectorAll('button, a[href], input, select, textarea, [tabindex="0"]')].filter((element) => !element.disabled && element.getAttribute('aria-hidden') !== 'true')
    ;(initialFocus?.current || focusable()[0] || panel.current).focus()
    const keyboard = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); close.current(); return }
      if (event.key !== 'Tab') return
      const items = focusable(); const first = items[0]; const last = items.at(-1)
      if (!first) { event.preventDefault(); panel.current.focus() }
      else if (event.shiftKey && (document.activeElement === first || !panel.current.contains(document.activeElement))) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (document.activeElement === last || !panel.current.contains(document.activeElement))) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', keyboard)
    return () => {
      document.removeEventListener('keydown', keyboard); document.body.style.overflow = previousOverflow
      previous.forEach(([element, inert, hidden]) => { element.inert = inert; if (hidden === null) element.removeAttribute('aria-hidden'); else element.setAttribute('aria-hidden', hidden) })
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [open])
  if (!open) return null
  return createPortal(<div className={`fixed inset-0 z-50 flex bg-[var(--overlay)] backdrop-blur-[1px] ${drawer ? 'items-stretch justify-start' : 'items-center justify-center p-4'}`}><section ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className={`${drawer ? 'w-[var(--sidebar-width)]' : 'w-full max-w-lg rounded-panel'} max-h-[var(--modal-max-height)] overflow-y-auto border border-border bg-surface p-5 shadow-subtle`}><div className="mb-4 flex items-center justify-between gap-4"><h2 id={titleId} className="text-base font-semibold">{title}</h2><Button variant="ghost" aria-label="Cerrar" onClick={onClose}><Icon name="close" size={18} /></Button></div>{children}</section></div>, document.body)
}
export function AppShell({ navigation }) {
  const { principal, logout } = useSession()
  const [drawer, setDrawer] = useState(false); const [error, setError] = useState(null)
  const location = useLocation(); const main = useRef(null)
  useEffect(() => { setDrawer(false); main.current?.focus() }, [location.pathname])
  const links = navigation.filter((item) => can(principal, item.capability))
  usePageTitle(links.find((item) => item.path === '/' ? location.pathname === '/' : location.pathname === item.path || location.pathname.startsWith(`${item.path}/`))?.label)
  const menu = <nav aria-label="Navegación principal" className="space-y-1">{links.map((item) => <NavLink key={item.id} to={item.path} end={item.path === '/'} className="nav-link" onClick={() => setDrawer(false)}><Icon name={navigationIcon(item.path)} size={16} />{item.label}</NavLink>)}</nav>
  // El cierre que pide la persona se confirma; el cierre por vencimiento o revocación sigue siendo inmediato.
  const [confirming, setConfirming] = useState(false); const [leaving, setLeaving] = useState(false); const [logoutError, setLogoutError] = useState(null)
  function exit() { setLogoutError(null); setDrawer(false); setConfirming(true) }
  async function confirmExit() { setLeaving(true); setLogoutError(null); try { await logout() } catch (cause) { setLogoutError(cause); setLeaving(false) } }
  const cancelRef = useRef(null)
  return <div className="flex h-dvh w-full overflow-hidden bg-page font-sans text-primary antialiased"><a href="#contenido" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-surface focus:p-3">Ir al contenido</a><aside className="hidden w-[var(--sidebar-width)] shrink-0 flex-col border-r border-border bg-surface md:flex"><div className="flex h-[var(--topbar-height)] items-center px-5 text-sm font-semibold">Riesgo Legal</div><div className="flex-1 overflow-y-auto p-3">{menu}</div><div className="border-t border-border p-3"><Button variant="ghost" className="w-full justify-start text-[var(--critical)]" onClick={exit}><Icon name="logout" size={16} />Cerrar sesión</Button></div></aside><div className="flex min-w-0 flex-1 flex-col"><div className="flex h-[var(--topbar-height)] shrink-0 items-center justify-between border-b border-border bg-surface px-4 md:justify-end md:px-6"><Button variant="ghost" className="md:hidden" aria-label="Abrir navegación" aria-expanded={drawer} onClick={() => setDrawer(true)}><Icon name="menu" size={16} /></Button><div className="flex min-w-0 items-center gap-3"><Clock /><span aria-hidden="true" className="hidden h-5 w-px bg-[var(--border-default)] md:block" /><ThemeToggle /><span aria-hidden="true" className="hidden h-5 w-px bg-[var(--border-default)] md:block" /><div className="hidden md:block"><UserBadge principal={principal} /></div><div className="md:hidden"><UserBadge principal={principal} compact /></div><Button variant="ghost" className="md:hidden" aria-label="Cerrar sesión" onClick={exit}><Icon name="logout" /></Button></div></div><main id="contenido" ref={main} tabIndex={-1} className="relative min-w-0 flex-1 overflow-y-auto overscroll-contain p-6 sm:p-8"><OfflineNotice className="mx-auto max-w-[var(--content-width-standard)]" /><div className="mx-auto max-w-[var(--content-width-standard)] space-y-8">{error && <ErrorState error={error} />}<ViewBoundary resetKey={location.pathname}><Outlet /></ViewBoundary></div></main></div><Modal open={drawer} title="Riesgo Legal" drawer onClose={() => setDrawer(false)}><div className="mb-4 border-b border-border pb-4"><UserBadge principal={principal} /></div>{menu}</Modal><Modal open={confirming} title="¿Cerrar sesión?" initialFocus={cancelRef} onClose={() => { if (!leaving) setConfirming(false) }}><div className="space-y-4"><p className="text-[13px] text-secondary">Se cerrará tu sesión en este navegador. Las consultas y resultados en pantalla no se conservan.</p>{logoutError && <ErrorState error={logoutError} title="No se pudo cerrar la sesión" />}<div className="flex flex-wrap justify-end gap-3"><Button ref={cancelRef} variant="secondary" disabled={leaving} onClick={() => setConfirming(false)}>Cancelar</Button><Button variant="danger" busy={leaving} onClick={confirmExit}>Cerrar sesión</Button></div></div></Modal></div>
}

import React, { useEffect, useState } from 'react'
import { Button } from './controls.jsx'
import { Icon } from './Icon.jsx'
import { roleLabel } from '../shared/labels.js'
import { formatClock } from '../shared/presentation.js'
import { applyTheme, saveTheme, storedTheme, systemTheme } from '../shared/theme.js'

// Hora actual que cambia al empezar cada minuto (alineada al reloj, no cada 60 s desde el montaje).
export function useNow() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    let interval = null
    const timeout = setTimeout(() => { setNow(new Date()); interval = setInterval(() => setNow(new Date()), 60000) }, 60000 - (Date.now() % 60000))
    return () => { clearTimeout(timeout); clearInterval(interval) }
  }, [])
  return now
}

// Fecha y hora del navegador (USER_TIMESTAMP, sin «UTC»). No es una región anunciada: el lector de
// pantalla no la repite cada minuto.
export function Clock() {
  const clock = formatClock(useNow())
  return <time dateTime={clock.iso} className="whitespace-nowrap text-xs text-secondary tabular-nums"><span className="hidden md:inline">{clock.long}</span><span className="md:hidden">{clock.short}</span></time>
}

export function initialsOf(name) {
  const words = String(name || '').trim().split(/[\s._-]+/).filter(Boolean)
  return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || '?').slice(0, 2)).toUpperCase()
}

// Nombre asignado, usuario y rol. En móvil solo las iniciales; el detalle está en el menú lateral.
export function UserBadge({ principal, compact = false }) {
  const roles = principal.roles.map(roleLabel).join(' · ')
  const avatar = <span aria-hidden="true" className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--brand-subtle)] text-[11px] font-semibold text-[var(--nav-active-text)]">{initialsOf(principal.displayName)}</span>
  if (compact) return <span className="inline-flex" title={`${principal.displayName} (${principal.username})`}>{avatar}<span className="sr-only">{`${principal.displayName}, usuario ${principal.username}, ${roles}`}</span></span>
  return <div className="flex min-w-0 items-center gap-2">{avatar}<div className="min-w-0 leading-tight"><p className="truncate text-xs font-medium text-primary">{principal.displayName}</p><p className="truncate text-[12px] text-muted">{principal.username} · {roles}</p></div></div>
}

// Botón de tema: alterna claro/oscuro; la primera vez parte de la preferencia del sistema.
export function ThemeToggle() {
  const [theme, setTheme] = useState(() => storedTheme() ?? systemTheme())
  useEffect(() => {
    if (storedTheme() || typeof window.matchMedia !== 'function') return undefined
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const change = () => { if (!storedTheme()) setTheme(media.matches ? 'dark' : 'light') }
    media.addEventListener?.('change', change)
    return () => media.removeEventListener?.('change', change)
  }, [])
  const dark = theme === 'dark'
  function toggle() { const next = dark ? 'light' : 'dark'; applyTheme(next); saveTheme(next); setTheme(next) }
  return <Button variant="ghost" className="h-8 w-8 px-0" aria-label="Tema oscuro" aria-pressed={dark} title={dark ? 'Desactivar tema oscuro' : 'Activar tema oscuro'} onClick={toggle}><Icon name={dark ? 'sun' : 'moon'} size={16} /></Button>
}

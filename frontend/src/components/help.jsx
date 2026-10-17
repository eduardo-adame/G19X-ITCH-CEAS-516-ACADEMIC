import React, { useEffect, useId, useRef, useState } from 'react'
import { Icon } from './Icon.jsx'

// Ayuda ⓘ flotante: se abre con clic o teclado, se cierra con Escape o al pulsar fuera y no desplaza el diseño
// (las tarjetas de indicadores tienen alturas fijas). Se abre hacia el lado con más espacio dentro del área visible.
const POPOVER_WIDTH = 288
export function InfoPopover({ label, children }) {
  const [open, setOpen] = useState(false)
  const [side, setSide] = useState('start')
  const id = useId()
  const root = useRef(null)
  const button = useRef(null)
  useEffect(() => {
    if (!open) return undefined
    const outside = (event) => { if (!root.current?.contains(event.target)) setOpen(false) }
    const escape = (event) => { if (event.key === 'Escape') { setOpen(false); button.current?.focus() } }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape) }
  }, [open])
  function toggle() {
    if (!open && button.current) {
      const rect = button.current.getBoundingClientRect()
      const area = (button.current.closest('main') ?? document.documentElement).getBoundingClientRect()
      const right = area.right - rect.left; const left = rect.right - area.left
      setSide(right >= POPOVER_WIDTH || right >= left ? 'start' : 'end')
    }
    setOpen((value) => !value)
  }
  return <span ref={root} className="relative inline-flex align-middle">
    <button ref={button} type="button" className="inline-flex items-center rounded-full text-muted hover:text-primary" aria-label={label} title={label} aria-expanded={open} aria-controls={id} onClick={toggle}><Icon name="info" size={14} /></button>
    {open && <span id={id} role="note" className={`info-popover ${side === 'end' ? 'right-0' : 'left-0'}`}>{children}</span>}
  </span>
}

// Aviso mientras el navegador no tiene red: distingue la falta de conexión de un error del sistema.
export function useOnline() {
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine !== false)
  useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false)
    window.addEventListener('online', update); window.addEventListener('offline', update)
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update) }
  }, [])
  return online
}

// La región viva existe siempre (vacía con conexión) para que el cambio se anuncie y no desplace la vista; el rol de
// estado solo lo tiene el aviso, así una región vacía no se confunde con un estado de la vista.
export function OfflineNotice({ className = '' }) {
  const online = useOnline()
  return <div aria-live="polite" className={className}>{!online && <p role="status" className="mb-6 flex items-center gap-2 rounded-control border border-[var(--warning-border)] bg-[var(--warning-subtle)] px-4 py-2.5 text-[13px]"><span className="text-[var(--warning)]"><Icon name="offline" size={16} /></span>Sin conexión de red. No se podrán cargar datos ni enviar operaciones hasta que se restablezca.</p>}</div>
}

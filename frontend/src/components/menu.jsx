import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icon.jsx'

// Menú de acciones de una fila. Se dibuja fuera de la tabla (portal con posición fija) para que el contenedor
// con desplazamiento no lo recorte; se reubica al desplazar la vista y se cierra con Escape, al elegir o al pulsar fuera.
// items: [{ id, label, onSelect, disabled, hint }]
export function ActionMenu({ label, items }) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState(null)
  const button = useRef(null)
  const menu = useRef(null)
  const id = useId()
  const enabled = items.filter((item) => !item.disabled)

  function place() {
    const rect = button.current?.getBoundingClientRect()
    if (!rect) return
    const width = 240
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))
    const below = window.innerHeight - rect.bottom
    setPosition(below > 220 ? { left, top: rect.bottom + 4, width } : { left, bottom: window.innerHeight - rect.top + 4, width })
  }
  useLayoutEffect(() => { if (open) place(); else setPosition(null) }, [open])
  // El foco entra al menú cuando ya está dibujado (necesita su posición).
  const ready = open && Boolean(position)
  useEffect(() => { if (ready) menu.current?.querySelector('[role="menuitem"]:not([aria-disabled="true"])')?.focus() }, [ready])
  useEffect(() => {
    if (!open) return undefined
    const outside = (event) => { if (!menu.current?.contains(event.target) && !button.current?.contains(event.target)) setOpen(false) }
    const escape = (event) => { if (event.key === 'Escape') { event.preventDefault(); setOpen(false); button.current?.focus() } }
    const follow = () => place()
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    window.addEventListener('resize', follow)
    window.addEventListener('scroll', follow, true)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); window.removeEventListener('resize', follow); window.removeEventListener('scroll', follow, true) }
  }, [open])

  function keyboard(event) {
    const entries = [...menu.current.querySelectorAll('[role="menuitem"]:not([aria-disabled="true"])')]
    const index = entries.indexOf(document.activeElement)
    if (event.key === 'ArrowDown') { event.preventDefault(); entries[(index + 1) % entries.length]?.focus() }
    else if (event.key === 'ArrowUp') { event.preventDefault(); entries[(index - 1 + entries.length) % entries.length]?.focus() }
    else if (event.key === 'Tab') setOpen(false)
  }
  // El foco vuelve al botón antes de la acción: un diálogo que se abra lo restaurará ahí al cerrarse.
  function choose(item) { if (item.disabled) return; setOpen(false); button.current?.focus(); item.onSelect() }

  return <>
    <button ref={button} type="button" className="button button-secondary h-8 gap-1 px-2.5 text-xs" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} aria-label={label} disabled={!enabled.length} onClick={() => setOpen((value) => !value)}>Acciones<Icon name="down" size={12} /></button>
    {open && position && createPortal(<div ref={menu} id={id} role="menu" aria-label={label} onKeyDown={keyboard} className="action-menu" style={{ position: 'fixed', ...position }}>
      {items.map((item) => <button key={item.id} type="button" role="menuitem" tabIndex={-1} aria-disabled={item.disabled || undefined} title={item.disabled ? item.hint : undefined} className="action-menu-item" onClick={() => choose(item)}>
        <span>{item.label}</span>{item.disabled && item.hint && <span className="block text-[11px] text-muted">{item.hint}</span>}
      </button>)}
    </div>, document.body)}
  </>
}

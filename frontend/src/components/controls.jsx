import React, { forwardRef, useEffect, useId, useState } from 'react'
import { Icon } from './Icon.jsx'
export const Button = forwardRef(function Button({ variant = 'primary', type = 'button', busy = false, disabled, children, className = '', ...props }, ref) {
  // Clases completas para que Tailwind conserve todas las variantes aprobadas.
  const variants = { primary: 'button-primary', secondary: 'button-secondary', danger: 'button-danger', ghost: 'button-ghost' }
  const variantClass = Object.hasOwn(variants, variant) ? variants[variant] : variants.primary
  return <button {...props} ref={ref} type={type} className={`button ${variantClass} ${className}`} disabled={disabled || busy} aria-busy={busy || undefined}>{children}</button>
})
// Lupa dentro de los campos de búsqueda: indica que el campo sirve para buscar.
export function SearchIcon({ children }) {
  return <span className="search-wrap"><span className="search-icon" aria-hidden="true"><Icon name="search" size={14} /></span>{children}</span>
}
export const Input = forwardRef(function Input({ label, error, compact = false, id: provided, className = '', ...props }, ref) {
  const generated = useId(); const id = provided || generated
  return <div className="field space-y-1"><label htmlFor={id} className="block text-xs font-medium text-secondary">{label}</label>{(() => { const input = <input {...props} ref={ref} id={id} className={`control ${compact ? 'control-compact' : ''} ${className}`} aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : props['aria-describedby']} />; return props.type === 'search' ? <SearchIcon>{input}</SearchIcon> : input })()}{error && <p id={`${id}-error`} role="alert" className="field-error text-xs text-[var(--critical)]">{error}</p>}</div>
})
// Contraseña con «Mostrar» y aviso de Bloq Mayús. Vuelve a ocultarse cuando el valor se vacía (tras enviar) o al
// deshabilitarse; en formularios no controlados (`name` sin `value`) se oculta al enviar.
export const PasswordInput = forwardRef(function PasswordInput({ label, error, id: provided, className = '', onKeyDown, onKeyUp, onBlur, ...props }, ref) {
  const generated = useId(); const id = provided || generated
  const [visible, setVisible] = useState(false)
  const [caps, setCaps] = useState(false)
  useEffect(() => { if (props.value === '' || props.disabled) setVisible(false) }, [props.value, props.disabled])
  useEffect(() => {
    const form = document.getElementById(id)?.form
    if (!form) return undefined
    const hide = () => setVisible(false)
    form.addEventListener('submit', hide)
    return () => form.removeEventListener('submit', hide)
  }, [id])
  const track = (event) => { if (typeof event.getModifierState === 'function') setCaps(event.getModifierState('CapsLock')) }
  const described = [error ? `${id}-error` : null, caps ? `${id}-caps` : null, props['aria-describedby']].filter(Boolean).join(' ') || undefined
  return <div className="field space-y-1"><label htmlFor={id} className="block text-xs font-medium text-secondary">{label}</label>
    <div className="relative"><input {...props} ref={ref} id={id} type={visible ? 'text' : 'password'} className={`control pr-10 ${className}`} aria-invalid={Boolean(error)} aria-describedby={described}
      onKeyDown={(event) => { track(event); onKeyDown?.(event) }} onKeyUp={(event) => { track(event); onKeyUp?.(event) }} onBlur={(event) => { setCaps(false); onBlur?.(event) }} />
      <button type="button" className="absolute inset-y-0 right-0 inline-flex w-10 items-center justify-center text-muted hover:text-primary disabled:opacity-50" aria-label={visible ? 'Ocultar contraseña' : 'Mostrar contraseña'} title={visible ? 'Ocultar contraseña' : 'Mostrar contraseña'} aria-pressed={visible} aria-controls={id} disabled={props.disabled} onClick={() => setVisible((value) => !value)}><Icon name={visible ? 'eyeOff' : 'eye'} size={16} /></button></div>
    {caps && <p id={`${id}-caps`} className="text-xs text-[var(--warning)]">Bloq Mayús está activado.</p>}
    {error && <p id={`${id}-error`} role="alert" className="field-error text-xs text-[var(--critical)]">{error}</p>}</div>
})
export function Select({ label, options, id: provided, compact = true, ...props }) {
  const generated = useId(); const id = provided || generated
  return <div className="field space-y-1"><label htmlFor={id} className="block text-xs font-medium text-secondary">{label}</label><select {...props} id={id} className={`control ${compact ? 'control-compact' : ''}`}>{options.map(({ value, label: text }) => <option key={value} value={value}>{text}</option>)}</select></div>
}
export function FilterBar({ children, count }) { return <div className="flex flex-wrap items-center justify-between gap-4 rounded-control border border-border bg-secondary p-3"><div className="flex flex-1 flex-wrap items-end gap-3">{children}</div>{count !== undefined && <span className="text-xs text-secondary">{count}</span>}</div> }
export function Tabs({ items, active, onChange, label }) {
  return <div role="tablist" aria-label={label} className="flex gap-4 border-b border-border">{items.map((item, index) => <button key={item.id} type="button" role="tab" id={item.id} aria-selected={item.id === active} aria-controls={item.panelId} tabIndex={item.id === active ? 0 : -1} className={`border-b-2 px-1 py-3 text-xs ${item.id === active ? 'border-[var(--brand-strong)] font-medium text-[var(--brand-ink)]' : 'border-transparent text-secondary hover:text-primary'}`} onClick={() => onChange(item.id)} onKeyDown={(event) => {
    const next = event.key === 'ArrowRight' ? (index + 1) % items.length : event.key === 'ArrowLeft' ? (index + items.length - 1) % items.length : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : null
    if (next !== null) { event.preventDefault(); onChange(items[next].id); event.currentTarget.parentElement.querySelectorAll('[role="tab"]')[next].focus() }
  }}>{item.label}</button>)}</div>
}

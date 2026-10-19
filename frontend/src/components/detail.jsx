import React from 'react'
import { Button, CopyButton } from './controls.jsx'
import { Modal } from './layout.jsx'

// Detalle de una fila en un panel lateral (DESIGN §18.1): la tabla conserva su alto y el detalle se lee a todo
// el ancho del panel; en móvil ocupa la pantalla completa. Se cierra con Esc, «Cerrar» o un clic fuera del panel,
// y el foco vuelve al botón de la fila que lo abrió.
export function DetailButton({ subject, onClick }) {
  return <Button variant="secondary" className="h-8 whitespace-nowrap" aria-label={subject ? `Ver detalle de ${subject}` : undefined} onClick={onClick}>Ver detalle</Button>
}
export function DetailPanel({ title, subtitle, onClose, actions, children }) {
  return <Modal open panel title={title} subtitle={subtitle} onClose={onClose}><div className="detail-panel-body">{children}</div>{actions && <div className="detail-panel-actions">{actions}</div>}</Modal>
}
export function DetailSection({ title, children }) {
  return <section className="detail-section"><h3>{title}</h3><dl>{children}</dl></section>
}
// `code` muestra el valor técnico registrado junto a su etiqueta legible, sin ocultarlo; `copy` es el rótulo del
// botón de copiar (solo para identificadores). Un valor ausente se muestra como «—», nunca como cero.
export function DetailField({ label, value, code = null, mono = false, copy = null }) {
  const empty = value === null || value === undefined || value === ''
  return <div className="detail-field"><dt>{label}</dt><dd>{empty ? '—' : <>
    <span className={mono ? 'mono' : undefined}>{value}</span>
    {code && code !== value && <span className="detail-code">{code}</span>}
    {copy && <> <CopyButton value={String(value)} label={copy} /></>}
  </>}</dd></div>
}

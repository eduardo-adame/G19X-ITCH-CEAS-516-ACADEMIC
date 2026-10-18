import React, { useEffect, useState } from 'react'
import { safeError } from '../api/errors.js'
import { Button } from './controls.jsx'
import { Icon } from './Icon.jsx'
import { APP_NAME } from '../shared/brand.js'
export function Loading({ label = 'Cargando…' }) { return <div role="status" aria-live="polite" className="flex items-center gap-3 border border-border bg-secondary p-5 text-secondary"><span aria-hidden="true" className="loading-track loading-track-compact" /><span>{label}</span></div> }

// Comprobación inicial de la sesión: marca con una barra dorada indeterminada. Solo aparece si la comprobación tarda
// más de 300 ms (sin parpadeo) y a los 8 s ofrece reintentar. Con «reducir movimiento» la barra queda quieta.
export function SessionLoading({ label = 'Comprobando tu sesión…', delay = 300, slowAfter = 8000, onRetry = () => window.location.reload() }) {
  const [phase, setPhase] = useState(delay > 0 ? 'waiting' : 'visible')
  useEffect(() => {
    const show = setTimeout(() => setPhase((current) => current === 'waiting' ? 'visible' : current), delay)
    const slow = setTimeout(() => setPhase('slow'), slowAfter)
    return () => { clearTimeout(show); clearTimeout(slow) }
  }, [delay, slowAfter])
  if (phase === 'waiting') return <div role="status" aria-live="polite" className="sr-only">{label}</div>
  return <main className="flex min-h-dvh items-center justify-center bg-page p-6"><div role="status" aria-live="polite" className="grid justify-items-center gap-4 text-center">
    <p className="flex items-center gap-2 text-lg font-semibold text-primary"><span className="text-[var(--brand)]"><Icon name="litigation" size={20} /></span>{APP_NAME}</p>
    <span aria-hidden="true" className="loading-track" />
    <p className="text-[13px] text-secondary">{label}</p>
    {phase === 'slow' && <div className="grid justify-items-center gap-2"><p className="text-xs text-secondary">Está tardando más de lo habitual.</p><Button variant="secondary" onClick={onRetry}>Reintentar</Button></div>}
  </div></main>
}
// Esqueleto con la geometría de una tabla (cabecera + filas) para que la carga no desplace el diseño.
export function TableSkeleton({ label = 'Cargando…', columns = 4, rows = 5 }) {
  return <div role="status" aria-live="polite"><span className="sr-only">{label}</span><div aria-hidden="true" className="table-scroll"><div className="flex gap-4 bg-secondary px-4 py-3">{Array.from({ length: columns }, (_, index) => <div key={index} className="skeleton h-3 flex-1" />)}</div>{Array.from({ length: rows }, (_, row) => <div key={row} className="flex h-[var(--table-row-height)] items-center gap-4 border-t border-border px-4">{Array.from({ length: columns }, (_, index) => <div key={index} className="skeleton h-2.5 flex-1" style={{ maxWidth: `${92 - ((row + index) % 3) * 14}%` }} />)}</div>)}</div></div>
}
// Confirmación visible de una acción completada (DESIGN §16.8): aviso en línea descartable, sin toast.
export function ActionNotice({ title, children, onDismiss }) {
  return <section role="status" className="flex items-start justify-between gap-3 rounded-control border border-[var(--success-border)] bg-[var(--success-subtle)] px-4 py-3"><div className="flex min-w-0 items-start gap-2"><span className="mt-0.5 text-[var(--success)]"><Icon name="success" size={16} /></span><div className="min-w-0 text-[13px]"><p className="font-medium">{title}</p>{children && <div className="mt-0.5 text-xs text-secondary">{children}</div>}</div></div>{onDismiss && <Button variant="ghost" className="h-7 px-2" aria-label="Cerrar aviso" onClick={onDismiss}><Icon name="close" size={14} /></Button>}</section>
}
export function EmptyState({ title = 'Sin resultados', message, action }) { return <section className="rounded-panel border border-border bg-surface p-8 text-center"><h2 className="text-sm font-semibold">{title}</h2>{message && <p className="mx-auto mt-1 max-w-md text-[13px] text-secondary">{message}</p>}{action && <div className="mt-4">{action}</div>}</section> }
// Qué puede hacer la persona según el tipo de fallo; no sustituye el mensaje seguro del error.
function nextStep(safe) {
  if (safe.cancelled) return null
  if (safe.uncertain) return null
  if (safe.status === 422) return 'Revisa los datos e inténtalo de nuevo.'
  if (safe.recoverable) return 'Intenta de nuevo en unos segundos. Si el problema continúa, avisa al equipo de TI.'
  return null
}
// context nombra lo que no pudo completarse («los indicadores», «la cuarentena»); title lo sustituye por completo.
export function ErrorState({ error, onRetry, context, title }) {
  const safe = safeError(error)
  const heading = title || (safe.status === 403 ? 'Sin autorización' : context ? `Error al cargar ${context}` : 'No se pudo completar la solicitud')
  const step = nextStep(safe)
  return <section role="alert" className="rounded-panel border border-[var(--critical-border)] bg-[var(--critical-subtle)] p-5"><h2 className="text-sm font-semibold">{heading}</h2><p className="mt-1 text-secondary">{safe.message}</p>{step && <p className="mt-1 text-xs text-secondary">{step}</p>}{onRetry && safe.recoverable && !safe.uncertain && <Button className="mt-3" variant="secondary" onClick={onRetry}>Reintentar</Button>}</section>
}
// skeleton='table' conserva la forma de la tabla al cargar; empty da contexto y siguiente paso al vacío.
export function ResourceState({ resource, children, context, skeleton, empty }) {
  if (resource.state === 'loading') return skeleton === 'table' ? <TableSkeleton label={context ? `Cargando ${context}…` : undefined} /> : <Loading />
  if (resource.state === 'empty') return <EmptyState {...empty} />
  if (resource.state === 'cancelled') return <EmptyState title="Consulta cancelada" />
  if (resource.error) return <ErrorState error={resource.error} onRetry={resource.reload} context={context} />
  return children(resource.data)
}

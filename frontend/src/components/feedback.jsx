import React from 'react'
import { safeError } from '../api/errors.js'
import { Button } from './controls.jsx'
export function Loading({ label = 'Cargando…' }) { return <div role="status" aria-live="polite" className="border border-border bg-secondary p-5 text-secondary">{label}</div> }
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
export function ResourceState({ resource, children, context }) {
  if (resource.state === 'loading') return <Loading />
  if (resource.state === 'empty') return <EmptyState />
  if (resource.state === 'cancelled') return <EmptyState title="Consulta cancelada" />
  if (resource.error) return <ErrorState error={resource.error} onRetry={resource.reload} context={context} />
  return children(resource.data)
}

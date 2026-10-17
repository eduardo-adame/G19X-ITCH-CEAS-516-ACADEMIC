import React, { useState } from 'react'
import { Button, Input } from '../../components/controls.jsx'
import { Modal } from '../../components/layout.jsx'
import { Badge } from '../../components/data.jsx'
import { ErrorState } from '../../components/feedback.jsx'
import { ApiError } from '../../api/errors.js'
import { object } from './adapters.js'
import { newOperationId, useOperation } from './api.js'

// El formulario solo se ofrece cuando todos los valores son texto o nulos: así reproduce exactamente
// el mismo payload que su JSON equivalente. Cualquier otra forma se corrige en modo JSON.
export function formFields(payload) {
  if (!object(payload) || !Object.keys(payload).length || !Object.values(payload).every((value) => value === null || typeof value === 'string')) return null
  return Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, value ?? '']))
}
// Un campo originalmente nulo que se deja vacío vuelve a ser nulo; el resto conserva el texto escrito.
export function payloadFromFields(fields, source) {
  return Object.fromEntries(Object.keys(fields).map((key) => [key, fields[key] === '' && source[key] === null ? null : fields[key]]))
}
const shown = (value) => value === null ? 'Sin valor' : value === '' ? 'Vacío' : typeof value === 'string' ? value : JSON.stringify(value)
// Campos cuyo valor corregido difiere del registro rechazado (o que no existían en él).
export function changedKeys(candidate, original) {
  if (!object(candidate)) return []
  const source = object(original) ? original : {}
  return Object.keys(candidate).filter((key) => !Object.hasOwn(source, key) || JSON.stringify(candidate[key]) !== JSON.stringify(source[key]))
}

// nextPending: devuelve el siguiente elemento corregible de la página (o null); onNext lo abre.
// Tras reinyectar, abre el siguiente pendiente de la página sin volver a la tabla.
function NextPending({ nextPending, onNext }) {
  const next = nextPending?.()
  if (!onNext) return null
  return next ? <Button variant="secondary" onClick={() => onNext(next)}>Corregir siguiente pendiente</Button> : <p className="self-center text-xs text-secondary">No quedan pendientes por corregir en esta página.</p>
}
export function QuarantineEditor({ item, onClose, onConfirmed, nextPending, onNext }) {
  const source = item.candidate_payload ?? item.original_payload
  const initialFields = formFields(source)
  const [mode, setMode] = useState(initialFields ? 'form' : 'json')
  const [fields, setFields] = useState(initialFields)
  const [base, setBase] = useState(source)
  const [candidate, setCandidate] = useState(() => JSON.stringify(source, null, 2))
  const [inputError, setInputError] = useState(null)
  const [modeError, setModeError] = useState(null)
  const [identity] = useState(newOperationId)
  const mutation = useOperation()
  // Comparación con el original rechazado para marcar qué se cambió antes de reinyectar.
  let current = null
  if (mode === 'form' && fields) current = payloadFromFields(fields, base)
  else { try { current = JSON.parse(candidate) } catch { current = null } }
  const changed = current === null ? null : changedKeys(current, item.original_payload)
  const original = object(item.original_payload) ? item.original_payload : {}
  const locked = mutation.busy || Boolean(mutation.result) || Boolean(mutation.error && ![403, 409, 422].includes(mutation.error.status))
  function toJson() { setCandidate(JSON.stringify(payloadFromFields(fields, base), null, 2)); setMode('json'); setModeError(null) }
  function toForm() {
    let parsed = null
    try { parsed = JSON.parse(candidate) } catch { /* Se informa abajo sin perder el texto escrito. */ }
    const next = formFields(parsed)
    if (!next) { setModeError('El JSON debe ser un objeto con valores de texto o vacíos para editarlo como formulario.'); return }
    setFields(next); setBase(parsed); setMode('form'); setModeError(null)
  }
  async function submit(event) {
    event.preventDefault(); if (locked || !item.canCorrect) return
    let corrected
    if (mode === 'form') corrected = payloadFromFields(fields, base)
    else {
      try { corrected = JSON.parse(candidate); if (!object(corrected) || !Object.keys(corrected).length) throw new Error() } catch { setInputError(new ApiError(422)); return }
    }
    setInputError(null)
    const result = await mutation.execute('quarantine.reinject', (api) => api.reinject(item.id, corrected, identity))
    if (result) { setCandidate(''); onConfirmed(result) }
  }
  return <Modal open title="Corregir registro pendiente" onClose={onClose}><form onSubmit={submit} className="space-y-4">
    <div className="space-y-1 rounded-control border border-[var(--warning-border)] bg-[var(--warning-subtle)] p-3"><Badge variant="warning">Causa</Badge><p className="text-[13px]">{item.cause_description}</p>{item.row_number !== null && item.row_number !== undefined && <p className="text-xs text-secondary">Fila {item.row_number} del archivo de origen.</p>}</div>
    <details className="technical-details"><summary>Original rechazado — solo lectura</summary><div className="technical-details-body">{object(item.original_payload) ? <dl>{Object.entries(item.original_payload).map(([key, value]) => <React.Fragment key={key}><dt>{key}</dt><dd>{shown(value)}</dd></React.Fragment>)}</dl> : <p>Sin registro original disponible.</p>}</div></details>
    {mode === 'form' ? <fieldset className="space-y-3" disabled={locked}><legend className="text-xs font-medium text-secondary">Valores corregidos</legend>{Object.keys(fields).map((key) => <div key={key} className={changed?.includes(key) ? 'field-changed' : undefined}><Input label={key} value={fields[key]} placeholder={base[key] === null ? 'Sin valor' : undefined} onChange={(event) => setFields({ ...fields, [key]: event.target.value })} />{changed?.includes(key) && <p className="mt-1 text-xs text-secondary"><span className="font-medium text-[var(--brand-ink)]">Modificado</span> · Original: {Object.hasOwn(original, key) ? shown(original[key]) : 'No existía'}</p>}</div>)}</fieldset>
      : <div className="space-y-1"><label htmlFor="corrected-candidate" className="block text-xs font-medium text-secondary">Candidato corregido (JSON)</label><textarea id="corrected-candidate" className="control min-h-48 resize-y py-2 font-mono text-xs" required disabled={locked} value={candidate} onChange={(e) => setCandidate(e.target.value)} /></div>}
    <div className="flex flex-wrap items-center gap-3 text-xs">{mode === 'form' ? <Button variant="ghost" disabled={locked} onClick={toJson}>Editar como JSON</Button> : <Button variant="ghost" disabled={locked} onClick={toForm}>Editar como formulario</Button>}{!initialFields && mode === 'json' && <span className="text-muted">Este registro contiene valores que solo pueden corregirse en JSON.</span>}</div>
    {modeError && <p role="alert" className="text-xs text-[var(--critical)]">{modeError}</p>}
    {changed !== null && <p role="status" className={`text-xs ${changed.length ? 'text-secondary' : 'text-[var(--warning)]'}`}>{changed.length ? `${changed.length} ${changed.length === 1 ? 'campo modificado' : 'campos modificados'} respecto al original: ${changed.join(', ')}.` : 'Sin cambios respecto al original: el registro probablemente vuelva a rechazarse.'}</p>}
    <p className="text-xs text-muted">La validación del dominio corresponde al servidor; el original no se modifica.</p>
    {inputError && <ErrorState error={inputError} title="El JSON no es válido" />}
    {mutation.error && <ErrorState error={mutation.error} title={mutation.error.status === 403 ? undefined : 'No se pudo reinyectar el registro'} />}
    {mutation.result && <p role="status">{mutation.result.message}</p>}
    {mutation.error && locked && <p className="text-sm">Consulta el estado antes de repetir. No se creó otro intento.</p>}
    <div className="flex flex-wrap gap-3"><Button type="submit" busy={mutation.busy} disabled={locked || !item.canCorrect}>Validar y reinyectar</Button>{mutation.result && <NextPending nextPending={nextPending} onNext={onNext} />}<Button variant="secondary" onClick={onClose}>Cerrar</Button></div>
  </form></Modal>
}

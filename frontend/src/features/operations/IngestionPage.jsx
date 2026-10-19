import React, { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useSession } from '../../auth/SessionProvider.jsx'
import { can } from '../../auth/permissions.js'
import { ApiError } from '../../api/errors.js'
import { PageHeader, useLeaveGuard } from '../../components/layout.jsx'
import { Button, Input, Select } from '../../components/controls.jsx'
import { DataTable, Badge } from '../../components/data.jsx'
import { DetailButton, DetailField, DetailPanel, DetailSection } from '../../components/detail.jsx'
import { InfoPopover } from '../../components/help.jsx'
import { ErrorState } from '../../components/feedback.jsx'
import { Icon } from '../../components/Icon.jsx'
import { dispatchStateLabel, isDocumentFile, locations, technicalResult } from './adapters.js'
import { newOperationId, useOperation, useOperationsRead } from './api.js'
import { OcrPanel } from './OcrPanel.jsx'
import { DATA_FORMATS, formatProblem, GENERAL_FORMAT_NOTES } from './dataFormats.js'

const LEAVE_MESSAGE = 'Hay una operación de ingesta en curso. Si sales ahora no verás su resultado en esta pantalla; podrás consultarlo en Auditoría.'

// Formato esperado de la ubicación elegida, desplegable para no ocupar espacio.
function FormatHelp({ location, label }) {
  const formats = DATA_FORMATS[location] ?? []
  return <details className="technical-details"><summary>Formato esperado para «{label}»</summary><div className="technical-details-body space-y-3 text-xs">
    <p>Archivos CSV o XLSX con estas columnas en la primera fila:</p>
    {formats.map((format) => <div key={format.title} className="space-y-1"><p className="font-medium text-primary">{format.title}</p><p>Obligatorias: <span className="mono">{format.required.join(', ')}</span></p>{format.optional.length > 0 && <p>Opcionales: <span className="mono">{format.optional.join(', ')}</span></p>}{format.notes.map((note) => <p key={note}>{note}</p>)}</div>)}
    <ul className="list-disc space-y-0.5 pl-4">{GENERAL_FORMAT_NOTES.map((note) => <li key={note}>{note}</li>)}</ul>
    <p className="text-muted">El sistema valida cada registro al recibirlo; los que no cumplan quedan en Zona de cuarentena.</p>
  </div></details>
}

const MAX_BYTES = 52428800
// Título del error según la acción que falló (UX-045); el mensaje seguro del error se conserva debajo.
const ACTION_ERRORS = Object.freeze({ upload: 'No se pudo recibir el archivo', run: 'No se pudo procesar la ubicación', dispatch: 'No se pudo confirmar el procesamiento' })

// Calidad técnica de OCR (KPI-CD-03, solo TI) en una tarjeta al inicio de la vista: valor destacado, qué mide y
// cuándo se calculó. La barra solo representa el porcentaje recibido; no añade metas ni umbrales propios.
function TechnicalMetric() {
  const resource = useOperationsRead('/technical/kpis/KPI-CD-03', technicalResult)
  const data = resource.state === 'success' ? resource.data : null
  const percent = data?.availability === 'DISPONIBLE' && data.value !== null ? Math.min(100, Math.max(0, Number(data.value))) : null
  return <section aria-labelledby="ocr-quality-title" className="rounded-panel border border-border bg-surface p-5 sm:p-6">
    <div className="grid grid-cols-1 items-center gap-5 md:grid-cols-[minmax(0,1fr)_auto]">
      <div className="min-w-0 space-y-1.5">
        <h2 id="ocr-quality-title" className="flex items-center gap-1.5 text-base font-semibold">Calidad técnica de OCR<InfoPopover label="Qué mide: Tasa de éxito OCR">Porcentaje de documentos procesados con OCR cuyo resultado más reciente alcanza al menos 80 % de confianza. Los reintentos no se cuentan dos veces.</InfoPopover></h2>
        <p className="text-[13px] text-secondary">Tasa de éxito OCR: documentos digitalizados que se leyeron con confianza suficiente.</p>
        {data && <p className="text-xs text-muted">Calculado: {data.calculatedLabel}</p>}
      </div>
      <div className="min-w-0 md:w-64">
        {resource.state === 'loading' ? <div role="status" aria-label="Cargando la calidad técnica de OCR" className="space-y-3"><div className="skeleton h-8 w-28" /><div className="skeleton h-2 w-full" /></div>
          : resource.error ? <ErrorState error={resource.error} onRetry={resource.reload} context="la calidad técnica de OCR" />
          : data && <div className="space-y-3"><p className={`font-semibold tabular-nums leading-none tracking-tight ${percent === null ? 'text-[15px] text-secondary' : 'text-[34px]'}`}>{data.displayValue}</p>{percent !== null && <div aria-hidden="true" className="h-2 overflow-hidden rounded-full bg-[var(--background-selected)]"><div className="h-full rounded-full bg-[var(--brand)]" style={{ width: `${percent}%` }} /></div>}</div>}
      </div>
    </div>
  </section>
}

function fileSize(bytes) {
  const mib = bytes / 1048576
  return mib >= 1 ? `${mib.toLocaleString('es-MX', { maximumFractionDigits: 1 })} MiB` : `${Math.max(1, Math.round(bytes / 1024)).toLocaleString('es-MX')} KiB`
}

// Zona de carga: arrastrar y soltar o elegir con el teclado; el control nativo conserva su nombre accesible.
function FileDropZone({ inputKey, file, disabled, onFile, error }) {
  const [over, setOver] = useState(false)
  const input = useRef(null)
  function drop(event) {
    event.preventDefault(); setOver(false)
    const dropped = event.dataTransfer?.files?.[0]
    if (!disabled && dropped) onFile(dropped)
  }
  return <div onDragOver={(event) => { event.preventDefault(); if (!disabled) setOver(true) }} onDragLeave={() => setOver(false)} onDrop={drop}
    className={`flex flex-col items-center gap-2 rounded-panel border border-dashed p-6 text-center md:col-span-2 ${over ? 'border-[var(--text-primary)] bg-[var(--background-selected)]' : 'border-[var(--border-strong)] bg-surface'}`}>
    <span className="text-secondary"><Icon name="upload" size={22} /></span>
    <p className="text-[13px]">Arrastra un archivo aquí o <Button variant="secondary" className="ml-1 h-8" disabled={disabled} onClick={() => input.current?.click()}>Elegir archivo</Button></p>
    <input key={inputKey} ref={input} type="file" className="sr-only" tabIndex={-1} aria-label="Archivo (máximo 50 MiB)" disabled={disabled} accept=".csv,.xlsx,.pdf,.docx" onChange={(event) => onFile(event.target.files[0] || null)} />
    <p className="text-xs text-muted">CSV, XLSX, PDF o DOCX · máximo 50 MiB</p>
    {error && <p role="alert" className="text-xs text-[var(--critical)]">{error}</p>}
    {file && <p className="max-w-full break-words text-xs" aria-live="polite">Seleccionado: <span className="font-medium">{file.name}</span> · {fileSize(file.size)}</p>}
  </div>
}

// Seguimiento por etapas: recepción → procesamiento → revisión. No afirma el resultado de validación de
// los registros (F-27-B): ese resultado se consulta en Zona de cuarentena y Auditoría.
function IngestionStages({ row, canQuarantine }) {
  const reception = { COMPLETADO: ['Recibido', 'success'], CUARENTENA: ['Retenido en cuarentena', 'warning'], RECHAZADO: ['Rechazado', 'critical'] }[row.state]
  const eligible = row.state === 'COMPLETADO' && row.routing_target !== 'NONE'
  const processing = row.dispatch ? dispatchStateLabel(row.dispatch.state) : eligible ? { label: 'Sin confirmación de procesamiento', variant: 'neutral' } : null
  const review = canQuarantine && (row.dispatch?.state === 'COMPLETED' || row.state === 'CUARENTENA')
  const steps = [<Badge key="reception" variant={reception[1]}>{reception[0]}</Badge>, processing && <Badge key="processing" variant={processing.variant}>{processing.label}</Badge>, review && <Link key="review" className="text-xs font-medium underline" to={`/cuarentena?ingest_file_id=${encodeURIComponent(row.file_id)}`}>Revisar en cuarentena</Link>].filter(Boolean)
  return <ol aria-label="Seguimiento" className="flex flex-wrap items-center gap-x-2 gap-y-1">{steps.map((step, index) => <li key={index} className="inline-flex items-center gap-2">{index > 0 && <span aria-hidden="true" className="text-muted">→</span>}{step}</li>)}</ol>
}

export function IngestionPage() {
  const { principal, generation } = useSession()
  if (!can(principal, 'ingest.upload')) return <ErrorState error={new ApiError(403)} />
  return <IngestionWorkspace key={generation} principal={principal} />
}
// Detalle de un archivo de esta sesión: resultado de la recepción y los identificadores para rastrearlo en Auditoría.
function IngestionDetailPanel({ row, onClose }) {
  if (!row) return null
  return <DetailPanel title={row.fileName || 'Archivo de la ubicación'} subtitle={row.reception} onClose={onClose}>
    <DetailSection title="Recepción">
      <DetailField label="Resultado" value={row.reception} code={row.state} />
      <DetailField label="Familia" value={row.familyText} />
      <DetailField label="Fecha del documento" value={row.documentDateText} />
      {row.safe_cause_code && <DetailField label="Causa" value={row.safe_cause_code} mono />}
    </DetailSection>
    <DetailSection title="Identificadores">
      <DetailField label="Archivo recibido" value={row.file_id} mono copy="Copiar archivo recibido" />
      <DetailField label="Operación" value={row.operation_id} mono copy="Copiar operación" />
      <DetailField label="Correlación" value={row.correlation_id} mono copy="Copiar correlación" />
    </DetailSection>
  </DetailPanel>
}
function IngestionWorkspace({ principal }) {
  const [file, setFile] = useState(null); const [location, setLocation] = useState(locations[0].value)
  const [rows, setRows] = useState([]); const [inputKey, setInputKey] = useState(0); const [documentDate, setDocumentDate] = useState('')
  const [action, setAction] = useState(null); const [detailId, setDetailId] = useState(null)
  const documentSelected = isDocumentFile(file)
  const [ocrRefreshKey, setOcrRefreshKey] = useState(0); const [technicalRefreshKey, setTechnicalRefreshKey] = useState(0)
  const mutation = useOperation()
  useLeaveGuard(mutation.busy, LEAVE_MESSAGE)
  const [fileError, setFileError] = useState(null)
  // Un formato no admitido se rechaza al elegir o soltar el archivo, antes de enviar nada.
  function chooseFile(next) {
    const problem = formatProblem(next)
    setFileError(problem); setFile(problem ? null : next)
    if (problem) setInputKey((value) => value + 1)
  }
  const blocked = mutation.busy || Boolean(mutation.error && ![403, 409, 422].includes(mutation.error.status))
  const canQuarantine = can(principal, 'quarantine.read')
  async function dispatch(rowsToDispatch) {
    const outcomes = []
    for (const row of rowsToDispatch) {
      if (row.state !== 'COMPLETADO' || row.routing_target === 'NONE') continue
      setAction('dispatch')
      const data = await mutation.execute('ingest.execute', (api) => api.dispatch(row.file_id, row.correlation_id))
      if (!data) break
      outcomes.push({ fileId: row.file_id, dispatch: data })
      setRows((current) => current.map((item) => item.file_id === row.file_id ? { ...item, dispatch: data } : item))
      // Sólo la confirmación documental durable invalida las lecturas técnicas.
      if (data.downstream_target === 'DOCUMENT' && data.state === 'COMPLETED') {
        setOcrRefreshKey((value) => value + 1); setTechnicalRefreshKey((value) => value + 1)
      }
    }
    return outcomes
  }
  async function upload(event) {
    event.preventDefault(); if (blocked || !file || file.size > MAX_BYTES) return
    setAction('upload')
    // El nombre lo conoce el navegador al subir; el servidor no lo devuelve en el resultado.
    const fileName = file.name
    const result = await mutation.execute('ingest.upload', (api) => api.upload(file, location, newOperationId(), documentSelected ? documentDate : ''))
    if (!result) return
    setRows([{ ...result, fileName }]); setFile(null); setDocumentDate(''); setInputKey((v) => v + 1)
    // La recepción y el despacho conservan resultados separados incluso si falla el segundo.
    if (can(principal, 'ingest.execute')) await dispatch([result])
  }
  async function run() {
    if (blocked) return
    setAction('run')
    const results = await mutation.execute('ingest.execute', (api) => api.run(location))
    if (results) { setRows(results); await dispatch(results) }
  }
  const locationLabel = locations.find((item) => item.value === location)?.label
  return <>
    <PageHeader title="Operaciones de ingesta" description="Recepción y procesamiento de archivos en ubicaciones controladas." actions={can(principal, 'audit.read.own') && <Link className="text-sm underline" to="/auditoria">Consultar auditoría</Link>} />
    {principal.roles.includes('TI') && <TechnicalMetric key={technicalRefreshKey} />}
    <section className="space-y-4"><h2 className="text-base font-semibold">Recibir archivo</h2>
      <form onSubmit={upload} className="grid grid-cols-1 items-start gap-4 md:grid-cols-2">
        <div className="space-y-2"><Select label="Ubicación controlada" options={locations} value={location} disabled={blocked} onChange={(e) => setLocation(e.target.value)} /><FormatHelp location={location} label={locationLabel} /></div>
        <div className="space-y-1"><Input label="Fecha del documento (PDF/DOCX, opcional)" type="date" value={documentSelected ? documentDate : ''} disabled={blocked || !documentSelected} onChange={(e) => setDocumentDate(e.target.value)} aria-describedby="document-date-help" />
          <p id="document-date-help" className="text-xs text-secondary">Fecha que consta en el documento. Si se omite, el documento se procesa sin fecha y sus citas quedan incompletas; no se infiere de metadatos del archivo.</p></div>
        <FileDropZone inputKey={inputKey} file={file} disabled={blocked} onFile={chooseFile} error={fileError} />
        <div className="flex flex-wrap items-center gap-3 md:col-span-2"><Button type="submit" busy={mutation.busy && action === 'upload'} disabled={blocked || !file || file.size > MAX_BYTES}>Recibir y procesar</Button>{can(principal, 'ingest.execute') && <Button variant="secondary" busy={mutation.busy && action === 'run'} disabled={blocked} onClick={run} aria-describedby="run-help">Procesar pendientes de la ubicación</Button>}</div>
        {can(principal, 'ingest.execute') && <p id="run-help" className="text-xs text-muted md:col-span-2">Procesa los archivos que ya están en la ubicación «{locationLabel}», sin subir uno nuevo.</p>}
      </form>
      {file?.size > MAX_BYTES && <p role="alert" className="text-[var(--critical)]">El archivo supera 50 MiB.</p>}
      {mutation.busy && <p role="status" className="text-xs text-secondary">Procesando solicitud…</p>}
      {mutation.error && <ErrorState error={mutation.error} title={mutation.error.status === 403 ? undefined : ACTION_ERRORS[action]} />}
      {blocked && !mutation.busy && <p className="text-sm text-secondary">Resultado incierto. Consulta Auditoría antes de iniciar otra operación; no se repetirá automáticamente.</p>}
    </section>
    <section className="space-y-3"><h2 className="text-base font-semibold">Archivos de esta sesión</h2><DataTable caption="Archivos recibidos en esta sesión" rowKey="file_id" rows={rows} empty={{ title: 'Aún no has recibido archivos en esta sesión', message: 'Los archivos que recibas o proceses aparecerán aquí con su seguimiento.' }} columns={[
      { key: 'fileName', label: 'Archivo', wide: true, render: (row) => row.fileName ? <span className="break-words font-medium">{row.fileName}</span> : <span className="text-secondary">Archivo de la ubicación{row.format ? ` (${row.format})` : ''}</span> },
      { key: 'familyText', label: 'Familia', nowrap: true }, { key: 'documentDateText', label: 'Fecha del documento', nowrap: true },
      { key: 'stages', label: 'Seguimiento', render: (row) => <IngestionStages row={row} canQuarantine={canQuarantine} /> },
      { key: 'detail', label: 'Detalle', fit: true, render: (row) => <DetailButton subject={row.fileName || 'el archivo de la ubicación'} onClick={() => setDetailId(row.file_id)} /> },
    ]} selectedKey={detailId} /><IngestionDetailPanel row={rows.find((item) => item.file_id === detailId)} onClose={() => setDetailId(null)} />{rows.some((row) => row.dispatch) && <p className="text-xs text-secondary">El procesamiento indica si el archivo se procesó, no el resultado de su validación: los registros aceptados o enviados a cuarentena se consultan en Zona de cuarentena y Auditoría.</p>}<p className="text-xs text-muted">Esta vista no representa un historial persistente.</p></section>
    {can(principal, 'document.manage') && <OcrPanel refreshKey={ocrRefreshKey} onProcessingCompleted={() => setTechnicalRefreshKey((value) => value + 1)} />}
  </>
}

import React, { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useSession } from '../../auth/SessionProvider.jsx'
import { can } from '../../auth/permissions.js'
import { ApiError } from '../../api/errors.js'
import { Button, Input, Select, FilterBar } from '../../components/controls.jsx'
import { Modal } from '../../components/layout.jsx'
import { DataTable, StatusBadge, TechnicalDetails } from '../../components/data.jsx'
import { localDayBoundary, localDayOf } from '../../shared/presentation.js'
import { ResourceState, ErrorState } from '../../components/feedback.jsx'
import { ocrPage, readFilters, changeFilters, filterQuery } from './adapters.js'
import { newOperationId, queryPath, useOperation, useOperationsRead } from './api.js'

export function OcrPanel({ refreshKey = 0, onProcessingCompleted } = {}) {
  const session = useSession()
  if (!can(session.principal, 'document.manage')) return <ErrorState error={new ApiError(403)} />
  return <OcrWorkspace key={session.generation} refreshKey={refreshKey} onProcessingCompleted={onProcessingCompleted} />
}
function OcrWorkspace({ refreshKey, onProcessingCompleted }) {
  const [params, setParams] = useSearchParams(); const filters = readFilters(params.toString(), 'ocr')
  const [selected, setSelected] = useState(null); const [requestId, setRequestId] = useState(null); const [notice, setNotice] = useState(null); const [filterError, setFilterError] = useState(null)
  const resource = useOperationsRead(queryPath('ocr', filters), ocrPage); const mutation = useOperation()
  const previousRefreshKey = useRef(refreshKey); const reload = useRef(resource.reload); reload.current = resource.reload
  useEffect(() => {
    if (previousRefreshKey.current === refreshKey) return
    previousRefreshKey.current = refreshKey
    // Refrescar datos no desmonta una confirmación OCR ni modifica la consulta.
    reload.current()
  }, [refreshKey])
  function change(patch) { try { setParams(filterQuery(changeFilters(filters, patch), 'ocr')); setFilterError(null); setSelected(null) } catch (e) { setFilterError(e) } }
  async function reprocess() {
    if (!selected?.reprocess_eligible || mutation.busy || mutation.result || mutation.error) return
    const result = await mutation.execute('document.manage', (api) => api.reprocess(selected, requestId))
    if (result) {
      setNotice(`${result.message}${result.pending ? ' Trabajo posterior pendiente.' : ''}`); resource.reload()
      if (!result.pending && ['LISTA', 'RECHAZADA', 'FALLIDA'].includes(result.processing_state)) onProcessingCompleted?.()
    }
  }
  return <section className="space-y-4"><h2 className="text-base font-semibold">Gestión OCR</h2>
    <FilterBar><Input label="Documento conocido" compact defaultValue={filters.document_id || ''} key={`document-${filters.document_id || ''}`} onBlur={(e) => change({ document_id: e.target.value })} /><Select label="Estado OCR" value={filters.state || ''} options={[{ value: '', label: 'Todos' }, { value: 'Pendiente', label: 'Pendiente' }, { value: 'Rechazado por baja confianza', label: 'Rechazado por baja confianza' }]} onChange={(e) => change({ state: e.target.value })} /><Input key={`ocr-from-${filters.processed_from || ''}`} label="Procesado desde" type="date" compact defaultValue={localDayOf(filters.processed_from)} onChange={(e) => change({ processed_from: localDayBoundary(e.target.value) })} /><Input key={`ocr-to-${filters.processed_to || ''}`} label="Procesado hasta" type="date" compact defaultValue={localDayOf(filters.processed_to)} onChange={(e) => change({ processed_to: localDayBoundary(e.target.value, { end: true }) })} /><Button variant="secondary" onClick={() => { resource.reload(); mutation.clear(); setSelected(null) }}>Consultar estado OCR</Button></FilterBar>
    {filterError && <ErrorState error={filterError} />}{notice && <p role="status">{notice}</p>}
    <ResourceState resource={resource} context="el estado OCR">{(data) => <div className="space-y-3"><DataTable caption="Resultados operativos OCR" rows={data.items} columns={[
      { key: 'document_name', label: 'Documento' }, { key: 'processing_state', label: 'Procesamiento', render: (row) => <StatusBadge kind="processing" value={row.processing_state} /> }, { key: 'ocrStateLabel', label: 'Estado OCR', render: (row) => <StatusBadge kind="ocr" value={row.ocrStateLabel} /> }, { key: 'confidenceLabel', label: 'Confianza', numeric: true }, { key: 'processedLabel', label: 'Procesado' }, { key: 'action', label: 'Acción', render: (row) => row.reprocess_eligible ? <Button variant="secondary" disabled={mutation.busy} onClick={() => { setSelected(row); setRequestId(newOperationId()); mutation.clear() }}>Reprocesar</Button> : <span className="text-xs text-muted">Sin acciones</span> },
      { key: 'detail', label: 'Detalle', render: (row) => <TechnicalDetails summary="Ver"><dl><dt>Archivo</dt><dd>{row.file_name ?? '—'}</dd><dt>Documento</dt><dd className="mono">{row.document_id}</dd><dt>Versión</dt><dd className="mono">{row.document_version_id}</dd><dt>Confianza recibida</dt><dd className="mono">{row.confidenceRaw}</dd><dt>Estado de procesamiento</dt><dd className="mono">{row.processing_state}</dd></dl></TechnicalDetails> },
    ]} />{data.next_cursor && <Button variant="secondary" onClick={() => setParams(filterQuery({ ...filters, cursor: data.next_cursor }, 'ocr'))}>Siguiente página OCR</Button>}</div>}</ResourceState>
    <Modal open={Boolean(selected) && !resource.error} title="Confirmar reproceso OCR" onClose={() => setSelected(null)}><div className="space-y-4"><p className="text-sm">Se reprocesará la versión seleccionada. Una pérdida de respuesta no autoriza un intento nuevo.</p>{mutation.error && <ErrorState error={mutation.error} />}{mutation.result && <p role="status">{mutation.result.message}{mutation.result.pending && ' El recálculo sigue pendiente.'}</p>}<Button onClick={reprocess} busy={mutation.busy} disabled={Boolean(mutation.result || mutation.error)}>Confirmar reproceso</Button></div></Modal>
  </section>
}

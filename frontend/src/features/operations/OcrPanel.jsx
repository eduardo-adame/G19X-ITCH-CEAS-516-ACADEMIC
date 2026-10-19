import React, { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useSession } from '../../auth/SessionProvider.jsx'
import { can } from '../../auth/permissions.js'
import { ApiError } from '../../api/errors.js'
import { Button, Select } from '../../components/controls.jsx'
import { CursorPager, DateRangeFields, FilterToolbar, RefreshButton, ResultsSummary, SearchField, useCursorHistory, useDebouncedCallback } from '../../components/filters.jsx'
import { Modal } from '../../components/layout.jsx'
import { DataTable, StatusBadge } from '../../components/data.jsx'
import { DetailButton, DetailField, DetailPanel, DetailSection } from '../../components/detail.jsx'
import { formatDayRange, localDayBoundary, localDayOf } from '../../shared/presentation.js'
import { ActionNotice, ResourceState, ErrorState } from '../../components/feedback.jsx'
import { ocrPage, readFilters, changeFilters, filterQuery, pageKey } from './adapters.js'
import { newOperationId, queryPath, useOperation, useOperationsRead } from './api.js'

// Detalle OCR de una versión: estados con su valor registrado, la confianza tal como llegó y los identificadores.
function OcrDetailPanel({ row, onClose }) {
  if (!row) return null
  return <DetailPanel title={row.document_name} subtitle="Detalle OCR de la versión" onClose={onClose}>
    <DetailSection title="Resultado OCR">
      <DetailField label="Estado de procesamiento" value={<StatusBadge kind="processing" value={row.processing_state} />} code={row.processing_state} />
      <DetailField label="Estado OCR" value={<StatusBadge kind="ocr" value={row.ocrStateLabel} />} />
      <DetailField label="Confianza" value={row.confidenceLabel} />
      <DetailField label="Confianza recibida" value={row.confidenceRaw} mono />
      <DetailField label="Procesado" value={row.processedLabel} />
    </DetailSection>
    <DetailSection title="Identificadores">
      <DetailField label="Archivo" value={row.file_name} />
      <DetailField label="Documento" value={row.document_id} mono copy="Copiar documento" />
      <DetailField label="Versión" value={row.document_version_id} mono copy="Copiar versión" />
    </DetailSection>
  </DetailPanel>
}
export function OcrPanel({ refreshKey = 0, onProcessingCompleted } = {}) {
  const session = useSession()
  if (!can(session.principal, 'document.manage')) return <ErrorState error={new ApiError(403)} />
  return <OcrWorkspace key={session.generation} refreshKey={refreshKey} onProcessingCompleted={onProcessingCompleted} />
}
function OcrWorkspace({ refreshKey, onProcessingCompleted }) {
  const [params, setParams] = useSearchParams(); const filters = readFilters(params.toString(), 'ocr')
  const [detailId, setDetailId] = useState(null)
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
  const schedule = useDebouncedCallback(change, 250)
  const withoutCursor = ({ cursor, ...rest }) => rest
  // Clave canónica (incluye el límite por defecto) para que pasar de página no reinicie el historial.
  const pages = useCursorHistory(pageKey(withoutCursor(filters), 'ocr'))
  const from = localDayOf(filters.processed_from); const to = localDayOf(filters.processed_to)
  const chips = [
    ...(filters.state ? [{ id: 'state', label: `Estado OCR: ${filters.state}`, onRemove: () => change({ state: '' }) }] : []),
    ...(from || to ? [{ id: 'range', label: `Procesado: ${formatDayRange(from, to)}`, onRemove: () => change({ processed_from: '', processed_to: '' }) }] : []),
    ...(filters.document_id ? [{ id: 'document', label: `Documento: ${filters.document_id}`, onRemove: () => change({ document_id: '' }) }] : []),
  ]
  async function reprocess() {
    if (!selected?.reprocess_eligible || mutation.busy || mutation.result || mutation.error) return
    const result = await mutation.execute('document.manage', (api) => api.reprocess(selected, requestId))
    if (result) {
      setNotice(`${result.message}${result.pending ? ' Trabajo posterior pendiente.' : ''}`); resource.reload()
      if (!result.pending && ['LISTA', 'RECHAZADA', 'FALLIDA'].includes(result.processing_state)) onProcessingCompleted?.()
    }
  }
  return <section className="space-y-4"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-base font-semibold">Gestión OCR</h2><RefreshButton onClick={() => { resource.reload(); mutation.clear(); setSelected(null) }} /></div>
    <FilterToolbar label="Filtros de OCR" chips={chips} onClearAll={() => change({ document_id: '', state: '', processed_from: '', processed_to: '' })} secondaryActive={filters.document_id ? 1 : 0}
      primary={<>
        <Select label="Estado OCR" value={filters.state || ''} options={[{ value: '', label: 'Todos' }, { value: 'Pendiente', label: 'Pendiente' }, { value: 'Rechazado por baja confianza', label: 'Rechazado por baja confianza' }]} onChange={(e) => schedule({ state: e.target.value })} />
        <DateRangeFields fromLabel="Procesado desde" toLabel="Procesado hasta" from={from} to={to} onChange={(range) => change({ processed_from: localDayBoundary(range.from), processed_to: localDayBoundary(range.to, { end: true }) })} />
      </>}
      secondary={<SearchField label="Documento conocido" value={filters.document_id || ''} maxLength={256} onApply={(value) => change({ document_id: value })} />} />
    {filterError && <ErrorState error={filterError} />}{notice && <ActionNotice title={notice} onDismiss={() => setNotice(null)} />}
    <ResourceState resource={resource} context="el estado OCR" skeleton="table" empty={{ title: 'Sin documentos para estos filtros', message: 'No hay documentos con resultado OCR que coincidan con la selección.' }}>{(data) => <div className="space-y-3"><ResultsSummary count={data.items.length} hasMore={Boolean(data.next_cursor)} noun={['documento', 'documentos']} /><DataTable caption="Resultados operativos OCR" rows={data.items} columns={[
      { key: 'document_name', label: 'Documento' }, { key: 'processing_state', label: 'Procesamiento', render: (row) => <div className="space-y-1"><StatusBadge kind="processing" value={row.processing_state} />{row.processing_state === 'PROCESANDO' && <p className="max-w-[220px] text-xs text-secondary">En procesamiento. Si permanece así, avisa al equipo de TI.</p>}</div> }, { key: 'ocrStateLabel', label: 'Estado OCR', render: (row) => <StatusBadge kind="ocr" value={row.ocrStateLabel} /> }, { key: 'confidenceLabel', label: 'Confianza', numeric: true }, { key: 'processedLabel', label: 'Procesado', nowrapWide: true }, { key: 'action', label: 'Acción', fit: true, sticky: true, render: (row) => row.reprocess_eligible ? <Button variant="secondary" disabled={mutation.busy} onClick={() => { setSelected(row); setRequestId(newOperationId()); mutation.clear() }}>Reprocesar</Button> : <span className="text-xs text-muted">Sin acciones</span> },
      { key: 'detail', label: 'Detalle', fit: true, render: (row) => <DetailButton subject={row.document_name} onClick={() => setDetailId(row.id)} /> },
    ]} selectedKey={detailId} /><OcrDetailPanel row={data.items.find((item) => item.id === detailId)} onClose={() => setDetailId(null)} /><CursorPager hasNext={Boolean(data.next_cursor)} hasPrevious={pages.canGoBack} atDeepLink={Boolean(filters.cursor) && !pages.canGoBack}
      onNext={() => { pages.push(filters.cursor); setParams(filterQuery({ ...filters, cursor: data.next_cursor }, 'ocr')) }}
      onPrevious={() => { const previous = pages.pop(); setParams(filterQuery(previous ? { ...withoutCursor(filters), cursor: previous } : withoutCursor(filters), 'ocr')) }}
      onFirst={() => setParams(filterQuery(withoutCursor(filters), 'ocr'))} /></div>}</ResourceState>
    <Modal open={Boolean(selected) && !resource.error} title="Confirmar reproceso OCR" onClose={() => setSelected(null)}><div className="space-y-4"><p className="text-sm">Se reprocesará la versión seleccionada. Una pérdida de respuesta no autoriza un intento nuevo.</p>{mutation.error && <ErrorState error={mutation.error} title={mutation.error.status === 403 ? undefined : 'No se pudo reprocesar el documento'} />}{mutation.result && <p role="status">{mutation.result.message}{mutation.result.pending && ' El recálculo sigue pendiente.'}</p>}<Button onClick={reprocess} busy={mutation.busy} disabled={Boolean(mutation.result || mutation.error)}>Confirmar reproceso</Button></div></Modal>
  </section>
}

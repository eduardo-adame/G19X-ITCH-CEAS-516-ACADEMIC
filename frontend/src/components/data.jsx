import React from 'react'
import { EmptyState } from './feedback.jsx'
import { Icon } from './Icon.jsx'
import { statusPresentation } from '../shared/labels.js'
export function Badge({ variant = 'neutral', children }) {
  const semantic = ['critical', 'warning', 'success', 'information'].includes(variant)
  return <span className="badge" style={semantic ? { color: `var(--${variant})`, background: `var(--${variant}-subtle)`, borderColor: `var(--${variant}-border)` } : undefined}>{children}</span>
}
// Estado de sistema con rótulo legible y variante semántica (labels.statusPresentation).
export function StatusBadge({ kind, value }) {
  const { label, variant } = statusPresentation(kind, value)
  return <Badge variant={variant}>{label}</Badge>
}
// Metadatos técnicos plegados: identificadores, códigos y textos registrados que no son la lectura principal.
export function TechnicalDetails({ summary = 'Detalle técnico', children, className = '' }) {
  return <details className={`technical-details ${className}`}><summary>{summary}</summary><div className="technical-details-body">{children}</div></details>
}
export function RiskBadge({ level }) { return <Badge variant={{ Alto: 'critical', Medio: 'warning', Bajo: 'success' }[level] || 'neutral'}><span aria-hidden="true" className="mr-1.5 h-1.5 w-1.5 rounded-full bg-current opacity-80" />{level}</Badge> }
export function KpiMetric({ label, displayValue, shortContext, delta, previousContext, state, accessibleValue, valueKind, entryIndex }) {
  const compact = valueKind === 'state' || (valueKind === undefined && !/^[\d$−-]/.test(displayValue || ''))
  const expandedValue = accessibleValue && accessibleValue !== displayValue
  const hasEntry = Number.isInteger(entryIndex) && entryIndex >= 0
  return <div role="group" aria-label={label} data-state={state} className={`kpi-metric min-w-0 py-1${hasEntry ? ' kpi-entry' : ''}`} style={hasEntry ? { '--kpi-entry-index': Math.min(entryIndex, 4) } : undefined}><div className="h-[var(--kpi-title-slot-height)] text-xs font-medium leading-[18px] text-secondary"><span className="line-clamp-2">{label}</span></div><div className="kpi-value-slot mt-1 flex h-[var(--kpi-value-slot-height)] items-baseline gap-1.5"><span aria-hidden={expandedValue ? true : undefined} className={`min-w-0 truncate font-semibold tracking-tight tabular-nums text-primary ${compact ? 'text-[14px] leading-5' : 'text-[26px] leading-none'}`}>{displayValue}</span>{expandedValue && <span className="sr-only">{accessibleValue}</span>}{shortContext && <span className="shrink-0 truncate text-xs text-secondary">{shortContext}</span>}</div><div className="kpi-delta-slot mt-2 flex h-[var(--kpi-delta-slot-height)] items-center overflow-hidden text-xs">{delta ?? <span className="text-muted">—</span>}</div><div className="mt-1 h-[var(--kpi-previous-slot-height)] truncate text-xs leading-4 text-muted">{previousContext}</div></div>
}
export function KpiSkeleton({ label }) {
  return <div aria-hidden="true" data-state="LOADING" data-label={label} className="kpi-metric min-w-0 py-1"><div className="h-[var(--kpi-title-slot-height)]"><div className="skeleton h-3 w-4/5" /></div><div className="mt-1 h-[var(--kpi-value-slot-height)]"><div className="skeleton h-6 w-1/2" /></div><div className="mt-2 h-[var(--kpi-delta-slot-height)]"><div className="skeleton h-3 w-3/4" /></div><div className="mt-1 h-[var(--kpi-previous-slot-height)]"><div className="skeleton h-2 w-2/3" /></div></div>
}
export function KpiRow({ children }) { return <div className="mb-8 border-b border-border pb-6"><div className={`kpi-row ${React.Children.count(children) === 5 ? 'kpi-row-five' : ''}`}>{children}</div></div> }
export function Delta({ text, sentiment = 'neutral', direction = 'flat' }) {
  const color = { positive: 'var(--success)', negative: 'var(--critical)', neutral: 'var(--text-secondary)' }[sentiment] || 'var(--text-secondary)'
  return <span className="inline-flex items-center gap-1 font-medium" style={{ color }}>{direction !== 'flat' && <Icon name={direction === 'up' ? 'up' : 'down'} size={12} />}{text}</span>
}
// Distribución por tipo de columna: numéricas alineadas a la derecha (encabezado incluido) y sin partir;
// `nowrap` para fechas, periodos y rótulos cortos; `wide` reserva ancho a textos largos para que no se
// aplasten en pantallas estrechas (la tabla se desplaza dentro de su marco en lugar de comprimirse).
// `fit` ajusta la columna a su contenido (detalle plegado, botones de acción) sin ancho mínimo.
const cellClass = (column) => [column.numeric ? 'text-right font-mono tabular-nums whitespace-nowrap' : column.fit ? '' : 'cell-text', column.nowrap ? 'whitespace-nowrap' : '', column.wide ? 'cell-wide' : '', column.medium ? 'cell-medium' : '', column.sticky ? 'cell-sticky' : '', column.nowrapWide ? 'cell-nowrap-wide' : ''].filter(Boolean).join(' ')
export function DataTable({ caption, columns: declared, rows, rowKey = 'id', sort, onSort, empty, compact = false }) {
  if (!rows.length) return <EmptyState {...empty} />
  // Las columnas de acción fijas (`sticky`) van al final y quedan visibles aunque la tabla se desplace.
  const columns = [...declared.filter((column) => !column.sticky), ...declared.filter((column) => column.sticky)]
  return <div className="table-scroll" tabIndex={0} role="region" aria-label={caption}><table className={`data-table${compact ? ' data-table-compact' : ''}`}><caption className="sr-only">{caption}</caption><thead><tr>{columns.map((column) => <th key={column.key} scope="col" className={[column.numeric ? 'text-right' : '', column.sticky ? 'cell-sticky' : ''].filter(Boolean).join(' ') || undefined} aria-sort={sort?.key === column.key ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined}>{column.sortable && onSort ? <button type="button" className="inline-flex items-center gap-1" onClick={() => onSort(column.key)}>{column.label}<Icon name={sort?.key === column.key ? (sort.direction === 'asc' ? 'up' : 'down') : 'sort'} size={12} /></button> : column.label}</th>)}</tr></thead><tbody>{rows.map((row) => <tr key={row[rowKey]}>{columns.map((column) => <td key={column.key} className={cellClass(column)}>{column.render ? column.render(row) : row[column.key] ?? '—'}</td>)}</tr>)}</tbody></table></div>
}

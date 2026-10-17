import { ApiError } from '../../api/errors.js'
import { formatTimestamp } from '../../shared/formatters.js'
import { formatUserTimestamp } from '../../shared/presentation.js'
import { families, object, uuid } from './adapters.js'

// Consultas administrativas de solo lectura (RF-068, SRS 0.26). Se valida el contrato antes de presentar:
// una respuesta inesperada se trata como fallo técnico, nunca se muestra a medias.
export const ROLES = Object.freeze(['JURIDICO', 'ANALISTA', 'TI'])
export const ACCOUNT_READ_CAPABILITIES = Object.freeze(['user.update', 'user.disable', 'user.reset_access', 'role.assign'])
const text = (value) => typeof value === 'string'
const timestamp = (value) => text(value) && formatTimestamp(value) !== '—'
const assert = (condition) => { if (!condition) throw new ApiError(503) }
const page = (data) => { assert(object(data) && Array.isArray(data.items) && (data.next_cursor === null || data.next_cursor === undefined || text(data.next_cursor))); return data.next_cursor ?? null }

function query(values) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) if (value !== '' && value !== null && value !== undefined) params.set(key, String(value))
  return params.toString()
}
export function accountsPath({ q = '', state = '', role = '', cursor = '', limit = 25 } = {}) {
  if (Array.from(q).length > 100 || /[\u0000-\u001f\u007f]/u.test(q) || state && !['ACTIVE', 'DISABLED'].includes(state) || role && !ROLES.includes(role)) throw new ApiError(422)
  return `/security/users?${query({ q: q.trim(), state, role, limit, cursor })}`
}
export function exceptionsPath({ subject = '', role_id = '', document_id = '', account_id = '', cursor = '', limit = 25 } = {}) {
  if (subject && !['USER', 'ROLE'].includes(subject) || role_id && !ROLES.includes(role_id) || account_id && !uuid(account_id) || Array.from(document_id).length > 256) throw new ApiError(422)
  return `/security/document-exceptions?${query({ subject, role_id, document_id: document_id.trim(), account_id, limit, cursor })}`
}
export const SCOPES_PATH = '/security/document-scopes'

export function accountPage(data) {
  const next = page(data)
  return {
    nextCursor: next,
    items: data.items.map((item) => {
      assert(object(item) && uuid(item.id) && text(item.username) && item.username && text(item.display_name) && ['ACTIVE', 'DISABLED'].includes(item.state)
        && Array.isArray(item.roles) && item.roles.every((role) => ROLES.includes(role)) && timestamp(item.created_at) && (item.disabled_at === null || timestamp(item.disabled_at)))
      return { id: item.id, username: item.username, displayName: item.display_name || item.username, state: item.state, roles: [...item.roles], createdLabel: formatUserTimestamp(item.created_at) }
    }),
  }
}
export function scopeList(data) {
  assert(object(data) && Array.isArray(data.items))
  const granted = new Set()
  for (const item of data.items) {
    assert(object(item) && ROLES.includes(item.role_id) && families.includes(item.source_family) && typeof item.active === 'boolean')
    if (item.active) granted.add(`${item.role_id}|${item.source_family}`)
  }
  // Sin registro activo no hay acceso: la autorización documental es «denegar por defecto».
  return { has: (role, family) => granted.has(`${role}|${family}`) }
}
export function exceptionPage(data) {
  const next = page(data)
  return {
    nextCursor: next,
    items: data.items.map((item) => {
      assert(object(item) && uuid(item.id) && ['USER', 'ROLE'].includes(item.subject_type) && text(item.document_id) && item.document_id && ['ALLOW', 'DENY'].includes(item.decision) && timestamp(item.created_at))
      if (item.subject_type === 'USER') assert(uuid(item.account_id) && text(item.username))
      else assert(ROLES.includes(item.role_id))
      return { id: item.id, subject: item.subject_type, accountId: item.account_id ?? null, username: item.username ?? null, displayName: item.display_name || item.username || null, roleId: item.role_id ?? null, documentId: item.document_id, decision: item.decision, createdLabel: formatUserTimestamp(item.created_at) }
    }),
  }
}

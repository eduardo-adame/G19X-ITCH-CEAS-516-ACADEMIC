import { useEffect, useRef, useState } from 'react'
import { useSession } from '../../auth/SessionProvider.jsx'
import { useLocation } from 'react-router-dom'
import { ApiError, safeError } from '../../api/errors.js'
import { isUuid } from '../rag/adapters.js'
import { adaptCatalog, adaptDocument, families, validDocumentId } from './adapters.js'

export function catalogPath({ q = '', source_family = '', document_type = '', cursor = '' } = {}) {
  if (typeof q !== 'string' || Array.from(q).length > 200 || /[\u0000-\u001f\u007f]/u.test(q) || source_family && !families.some((item) => item.value === source_family) || document_type && !['PDF', 'DOCX'].includes(document_type) || typeof cursor !== 'string' || cursor.length > 2048) throw new ApiError(422)
  const query = new URLSearchParams({ limit: '25' })
  for (const [key, value] of Object.entries({ q, source_family, document_type, cursor })) if (value) query.set(key, value)
  return `/documents/viewer?${query}`
}
export function documentPath(id, version = null, original = false) {
  if (!validDocumentId(id) || version !== null && !isUuid(version) || original && !version) throw new ApiError(422)
  return `/documents/viewer/${encodeURIComponent(id)}${original ? '/original' : ''}${version ? `?version_id=${encodeURIComponent(version)}` : ''}`
}
export async function readCatalog(client, filters, signal) {
  return adaptCatalog(await client.request(catalogPath(filters), { signal }))
}
export async function readDocument(client, id, version, signal) {
  const result = adaptDocument(await client.request(documentPath(id, version), { signal }))
  if (result.documentId !== id || version && result.versionId !== version) throw new ApiError(503)
  return result
}
export async function readOriginal(client, id, version, signal) {
  const result = await client.request(documentPath(id, version, true), { signal, responseType: 'blob' })
  if (!(result instanceof Blob) || result.type.toLowerCase() !== 'application/pdf' || result.size < 1 || result.size > 50 * 1024 * 1024) throw new ApiError(503)
  return result
}

export function useViewerRead(key, read, enabled) {
  const session = useSession()
  const owner = `${session.principal?.id ?? ''}:${session.generation}`
  const permitted = enabled && session.status === 'authenticated'
  const latest = useRef({ owner, key, permitted })
  latest.current = { owner, key, permitted }
  const readRef = useRef(read); readRef.current = read
  const epoch = useRef(0)
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState({ state: 'loading', data: null, error: null })
  useEffect(() => {
    const current = ++epoch.current
    const controller = new AbortController()
    setResult({ state: 'loading', data: null, error: null, owner, key })
    if (permitted && key) {
      Promise.resolve().then(() => {
        if (controller.signal.aborted) throw new ApiError(0, { cancelled: true })
        return readRef.current(session.client, controller.signal)
      }).then((data) => {
        if (current === epoch.current && !controller.signal.aborted && latest.current.owner === owner && latest.current.key === key && latest.current.permitted) setResult({ state: 'success', data, error: null, owner, key })
      }).catch((cause) => {
        if (current === epoch.current && !controller.signal.aborted && latest.current.owner === owner && latest.current.key === key && latest.current.permitted) setResult({ state: 'error', data: null, error: safeError(cause), owner, key })
      })
    }
    return () => { epoch.current++; controller.abort() }
  }, [owner, key, permitted, session.client, attempt])
  const compatible = permitted && key && result.owner === owner && result.key === key
  return { ...(compatible ? result : { state: 'loading', data: null, error: null }), reload: () => setAttempt((value) => value + 1) }
}

export function useViewerAccess() {
  const session = useSession()
  const location = useLocation()
  const owner = `${session.principal?.id ?? ''}:${session.generation}`
  const [verification, setVerification] = useState(null)
  useEffect(() => {
    let active = true
    let sequence = 0
    const verify = () => {
      const current = ++sequence
      setVerification({ owner, location: location.key, pending: true, allowed: false })
      Promise.resolve().then(() => session.revalidate()).then((allowed) => {
        if (active && current === sequence) setVerification({ owner, location: location.key, pending: false, allowed: allowed === true })
      }).catch(() => {
        if (active && current === sequence) setVerification({ owner, location: location.key, pending: false, allowed: false })
      })
    }
    const visible = () => { if (document.visibilityState === 'visible') verify() }
    verify(); window.addEventListener('focus', visible); document.addEventListener('visibilitychange', visible)
    return () => { active = false; window.removeEventListener('focus', visible); document.removeEventListener('visibilitychange', visible) }
  }, [owner, location.key, session.revalidate])
  const compatible = session.status === 'authenticated' && verification?.owner === owner && verification?.location === location.key
  return compatible ? verification : { pending: true, allowed: false }
}

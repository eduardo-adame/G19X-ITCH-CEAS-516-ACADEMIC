import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { useSession } from '../../auth/SessionProvider.jsx'
import { Loading } from '../../components/feedback.jsx'
import { ApiError } from '../../api/errors.js'
import { createRagSubmission, requestRag, validateRagQuery } from './api.js'
import { getLocalInteraction } from './localInteraction.js'

const RagContext = createContext(null)
export function RagLayout() {
  const session = useSession()
  const location = useLocation()
  const owner = `${session.principal?.id || ''}:${session.generation}`
  const [snapshot, setSnapshot] = useState({ result: null, error: null, busy: false, submission: null, owner })
  const [localSnapshot, setLocalSnapshot] = useState(null)
  const [verified, setVerified] = useState(null)
  const [accessPending, setAccessPending] = useState(true)
  const epoch = useRef(0)
  const controller = useRef(null)
  const currentOwner = useRef(owner)
  currentOwner.current = owner
  const clear = useCallback(() => {
    epoch.current++; controller.current?.abort(); controller.current = null
    setSnapshot({ result: null, error: null, busy: false, submission: null, owner: currentOwner.current })
    setLocalSnapshot(null)
  }, [])
  useEffect(() => { clear() }, [owner, clear])
  useEffect(() => {
    let mounted = true
    let verification = 0
    setVerified(null)
    const verify = () => {
      const expected = ++verification
      setAccessPending(true)
      // Suspender la presentación conserva la consulta sin exponer evidencia durante la revalidación.
      Promise.resolve().then(() => session.revalidate()).then((valid) => {
        if (!mounted || expected !== verification) return
        if (!valid) clear()
        setVerified(location.key); setAccessPending(false)
      }).catch(() => {
        if (!mounted || expected !== verification) return
        clear(); setVerified(location.key); setAccessPending(false)
      })
    }
    const visible = () => { if (document.visibilityState === 'visible') verify() }
    verify()
    window.addEventListener('focus', visible); document.addEventListener('visibilitychange', visible)
    return () => {
      mounted = false
      window.removeEventListener('focus', visible); document.removeEventListener('visibilitychange', visible)
    }
  }, [owner, location.key, session.revalidate, clear])
  useEffect(() => () => clear(), [clear])
  async function execute(submission) {
    clear()
    const expected = epoch.current
    const startedOwner = currentOwner.current
    controller.current = new AbortController()
    setSnapshot({ result: null, error: null, busy: true, submission, owner: startedOwner })
    try {
      const result = await requestRag(session.client, submission, controller.current.signal)
      if (expected === epoch.current && startedOwner === currentOwner.current) setSnapshot({ result, error: null, busy: false, submission, owner: startedOwner })
    } catch (cause) {
      if (expected !== epoch.current || startedOwner !== currentOwner.current) return
      const error = cause instanceof ApiError ? cause : new ApiError(503)
      setSnapshot({ result: null, error, busy: false, submission: [401, 403, 409, 422].includes(error.status) ? null : submission, owner: startedOwner })
    }
  }
  function submit(query, contextId) {
    if (accessPending || session.status !== 'authenticated') return
    validateRagQuery(query)
    const local = getLocalInteraction(query)
    if (local) {
      clear()
      setLocalSnapshot({ ...local, query, owner: currentOwner.current })
      return
    }
    return execute(createRagSubmission(query, contextId))
  }
  const visible = snapshot.owner === owner && session.status === 'authenticated' ? snapshot : { result: null, error: null, busy: false, submission: null }
  const local = localSnapshot?.owner === owner && session.status === 'authenticated' ? localSnapshot : null
  const value = { ...visible, result: accessPending ? null : visible.result, error: accessPending ? null : visible.error, local: accessPending ? null : local, hasInteraction: Boolean(local || visible.submission || visible.result || visible.error), accessPending, clear, submit, retry: () => !accessPending && visible.submission && execute(visible.submission) }
  return <RagContext.Provider value={value}>{verified === location.key ? <Outlet /> : <Loading label="Comprobando acceso a la consulta…" />}</RagContext.Provider>
}
export function useRag() {
  const context = useContext(RagContext)
  if (!context) throw new Error('La vista requiere el contexto de consulta.')
  return context
}

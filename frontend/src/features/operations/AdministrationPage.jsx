import React, { useEffect, useRef, useState } from 'react'
import { useSession } from '../../auth/SessionProvider.jsx'
import { can } from '../../auth/permissions.js'
import { ApiError } from '../../api/errors.js'
import { PageHeader, Modal } from '../../components/layout.jsx'
import { Button, Input, PasswordInput, SearchIcon, Select, Tabs } from '../../components/controls.jsx'
import { Badge, DataTable, TechnicalDetails } from '../../components/data.jsx'
import { ActionNotice, EmptyState, ErrorState, TableSkeleton } from '../../components/feedback.jsx'
import { CursorPager, FilterToolbar, ResultsSummary, SearchField } from '../../components/filters.jsx'
import { Icon } from '../../components/Icon.jsx'
import { ActionMenu } from '../../components/menu.jsx'
import { families, uuid } from './adapters.js'
import { familyLabel, roleLabel } from '../../shared/labels.js'
import { useOperation, useOperationsRead } from './api.js'
import { ACCOUNT_READ_CAPABILITIES, accountPage, accountsPath, exceptionPage, exceptionsPath, ROLES, SCOPES_PATH, scopeList } from './directory.js'

// Cada operación se abre en un diálogo sobre la lista desde la que se eligió (DESIGN §22): la lista sigue a la
// vista, la confirmación es un segundo paso del mismo diálogo y al terminar la lista se actualiza.
export const adminActions = [
  { value: 'create', label: 'Nueva cuenta', capability: 'user.create' },
  { value: 'update', label: 'Editar nombre', capability: 'user.update' },
  { value: 'activate', label: 'Activar cuenta', capability: 'user.update' },
  { value: 'disable', label: 'Deshabilitar cuenta', capability: 'user.disable' },
  { value: 'reset', label: 'Restablecer acceso', capability: 'user.reset_access' },
  { value: 'roles', label: 'Asignar roles', capability: 'role.assign' },
  { value: 'scope', label: 'Alcance por familia', capability: 'document_acl.manage' },
  { value: 'exception', label: 'Excepción documental', capability: 'document_acl.manage' },
]
const SECTIONS = Object.freeze([{ id: 'accounts', label: 'Cuentas', tab: 'admin-cuentas' }, { id: 'permissions', label: 'Permisos concedidos', tab: 'admin-permisos' }])
const accountText = (account) => account ? `${account.displayName} (${account.username})` : ''
const decisionLabel = (decision) => decision === 'ALLOW' ? 'Autorizar' : 'Denegar'
const actionOf = (value) => adminActions.find((item) => item.value === value)

// Operaciones que piden revisar un resumen antes de aplicarse. La contraseña nunca entra en el resumen ni en el
// estado React: se lee del formulario (que sigue montado, oculto) solo al confirmar.
const REVIEW = Object.freeze({
  disable: { button: 'Deshabilitar cuenta', variant: 'danger', text: (fields, account) => <>Se deshabilitará la cuenta <span className="font-medium text-primary">{accountText(account)}</span> y se invalidarán sus sesiones. No se elimina la cuenta; el servidor impide deshabilitar al último TI activo.</> },
  roles: { button: 'Asignar roles', variant: 'primary', text: (fields, account) => <>La cuenta <span className="font-medium text-primary">{accountText(account)}</span> quedará exactamente con: <span className="font-medium text-primary">{fields.roles.map(roleLabel).join(' · ')}</span>. Sus roles actuales se sustituyen y sus sesiones abiertas se cerrarán.</> },
  reset: { button: 'Restablecer acceso', variant: 'danger', text: (fields, account) => <>Se asignará la contraseña nueva a la cuenta <span className="font-medium text-primary">{accountText(account)}</span> y se cerrarán sus sesiones abiertas.</> },
})
function doneMessage(action, fields, account) {
  const name = account?.displayName
  return {
    update: `Nombre de ${name} actualizado.`, activate: `Cuenta de ${name} activada.`, disable: `Cuenta de ${name} deshabilitada.`,
    reset: `Acceso de ${name} restablecido.`, roles: `Roles de ${name} actualizados.`,
    scope: `Alcance actualizado: ${roleLabel(fields.role_id)} ${fields.active ? 'con' : 'sin'} acceso a ${familyLabel(fields.source_family)}.`,
    'user-exception': `Excepción de ${fields.document_id} ${fields.active ? 'guardada' : 'retirada'}.`, 'role-exception': `Excepción de ${fields.document_id} ${fields.active ? 'guardada' : 'retirada'}.`,
  }[action]
}

export function AdministrationPage() {
  const { principal, generation } = useSession()
  if (!principal?.roles.includes('TI') || !can(principal, 'user.create')) return <ErrorState error={new ApiError(403)} />
  return <AdministrationWorkspace key={generation} principal={principal} />
}

// Paginación por cursor local a una tabla: el historial permite volver atrás.
function useLocalPages(dependency) {
  const [cursor, setCursor] = useState(''); const [history, setHistory] = useState([])
  useEffect(() => { setCursor(''); setHistory([]) }, [dependency])
  return {
    cursor,
    pager: (next) => ({ hasNext: Boolean(next), hasPrevious: history.length > 0, onNext: () => { setHistory([...history, cursor]); setCursor(next) }, onPrevious: () => { setCursor(history.at(-1)); setHistory(history.slice(0, -1)) }, onFirst: () => { setCursor(''); setHistory([]) } }),
  }
}
function readPath(build, values) { try { return { path: build(values), error: null } } catch (error) { return { path: null, error } } }
// Relee una lista cuando cambia refreshKey (tras una operación), sin hacerlo al montar.
function useRefresh(resource, refreshKey) {
  const first = useRef(true)
  useEffect(() => { if (first.current) { first.current = false; return } resource.reload() }, [refreshKey])
}
function SectionHeader({ id, title, children }) {
  return <div className="flex flex-wrap items-center justify-between gap-3"><h2 id={id} className="text-base font-semibold">{title}</h2>{children}</div>
}

// Lista de cuentas (RF-068, SRS 0.26): búsqueda, filtros y acciones por fila.
function AccountDirectory({ principal, refreshKey, onAction }) {
  const [filters, setFilters] = useState({ q: '', state: '', role: '' })
  const pages = useLocalPages(JSON.stringify(filters))
  const { path, error } = readPath(accountsPath, { ...filters, cursor: pages.cursor })
  const resource = useOperationsRead(path, accountPage)
  useRefresh(resource, refreshKey)
  const change = (patch) => setFilters((current) => ({ ...current, ...patch }))
  const chips = [
    ...(filters.q ? [{ id: 'q', label: `Búsqueda: ${filters.q}`, onRemove: () => change({ q: '' }) }] : []),
    ...(filters.state ? [{ id: 'state', label: `Estado: ${filters.state === 'ACTIVE' ? 'Activas' : 'Deshabilitadas'}`, onRemove: () => change({ state: '' }) }] : []),
    ...(filters.role ? [{ id: 'role', label: `Rol: ${roleLabel(filters.role)}`, onRemove: () => change({ role: '' }) }] : []),
  ]
  function menu(account) {
    const own = account.id.toLowerCase() === principal.id.toLowerCase()
    return [
      can(principal, 'user.update') && { id: 'update', label: 'Editar nombre', onSelect: () => onAction('update', { account }) },
      can(principal, 'role.assign') && { id: 'roles', label: 'Asignar roles', disabled: own, hint: 'No puedes modificar tus propios roles', onSelect: () => onAction('roles', { account }) },
      can(principal, 'user.reset_access') && { id: 'reset', label: 'Restablecer acceso', onSelect: () => onAction('reset', { account }) },
      account.state === 'DISABLED' ? can(principal, 'user.update') && { id: 'activate', label: 'Activar cuenta', onSelect: () => onAction('activate', { account }) } : can(principal, 'user.disable') && { id: 'disable', label: 'Deshabilitar cuenta', onSelect: () => onAction('disable', { account }) },
      can(principal, 'document_acl.manage') && { id: 'exception', label: 'Excepción documental', onSelect: () => onAction('exception', { account, subject: 'USER' }) },
    ].filter(Boolean)
  }
  const data = resource.data
  return <section className="space-y-4" aria-labelledby="cuentas-registradas">
    <SectionHeader id="cuentas-registradas" title="Cuentas registradas">{can(principal, 'user.create') && <Button onClick={() => onAction('create', {})}><Icon name="zoomIn" size={16} />Nueva cuenta</Button>}</SectionHeader>
    <FilterToolbar label="Filtros de cuentas" chips={chips} onClearAll={() => setFilters({ q: '', state: '', role: '' })} primary={<>
      <SearchField label="Buscar por usuario o nombre" value={filters.q} maxLength={100} onApply={(value) => change({ q: value })} />
      <Select label="Estado" value={filters.state} options={[{ value: '', label: 'Todas' }, { value: 'ACTIVE', label: 'Activas' }, { value: 'DISABLED', label: 'Deshabilitadas' }]} onChange={(event) => change({ state: event.target.value })} />
      <Select label="Rol" value={filters.role} options={[{ value: '', label: 'Todos' }, ...ROLES.map((value) => ({ value, label: roleLabel(value) }))]} onChange={(event) => change({ role: event.target.value })} />
    </>} />
    {error ? <ErrorState error={error} /> : resource.state === 'loading' ? <TableSkeleton label="Cargando cuentas…" columns={5} /> : resource.error ? <ErrorState error={resource.error} onRetry={resource.reload} context="las cuentas" /> : !data?.items.length ? <EmptyState title="Sin cuentas para estos filtros" message="Prueba con otra búsqueda o retira algún filtro." /> : <div className="space-y-4">
      <ResultsSummary count={data.items.length} hasMore={Boolean(data.nextCursor)} noun={['cuenta', 'cuentas']} />
      <DataTable caption="Cuentas registradas" rows={data.items} columns={[
        { key: 'displayName', label: 'Nombre', wide: true, render: (row) => <span className="font-medium">{row.displayName}{row.id.toLowerCase() === principal.id.toLowerCase() && <span className="ml-2 text-xs font-normal text-muted">(tú)</span>}</span> },
        { key: 'username', label: 'Usuario', nowrap: true },
        { key: 'roles', label: 'Roles', render: (row) => row.roles.length ? row.roles.map(roleLabel).join(' · ') : <span className="text-muted">Sin roles activos</span> },
        { key: 'state', label: 'Estado', render: (row) => <Badge variant={row.state === 'ACTIVE' ? 'success' : 'neutral'}>{row.state === 'ACTIVE' ? 'Activa' : 'Deshabilitada'}</Badge> },
        { key: 'createdLabel', label: 'Creada', nowrap: true },
        { key: 'actions', label: 'Acciones', fit: true, sticky: true, render: (row) => <ActionMenu label={`Acciones para ${row.displayName}`} items={menu(row)} /> },
      ]} />
      <CursorPager {...pages.pager(data.nextCursor)} />
    </div>}
  </section>
}

// Elegir una cuenta por búsqueda (excepciones por cuenta) sin pegar identificadores.
function AccountPicker({ onPick }) {
  const [q, setQ] = useState('')
  const { path } = readPath(accountsPath, { q, limit: 6 })
  const resource = useOperationsRead(q.trim() ? path : null, accountPage)
  return <div className="space-y-2"><div className="field space-y-1"><label htmlFor="account-picker" className="block text-xs font-medium text-secondary">Cuenta</label><SearchIcon><input id="account-picker" type="search" className="control" placeholder="Escribe el usuario o el nombre" value={q} maxLength={100} autoComplete="off" onChange={(event) => setQ(event.target.value)} /></SearchIcon></div>
    {q.trim() && (resource.state === 'loading' ? <p role="status" className="text-xs text-secondary">Buscando cuentas…</p> : resource.error ? <ErrorState error={resource.error} context="las cuentas" /> : resource.data?.items.length ? <ul aria-label="Cuentas encontradas" className="divide-y divide-[var(--border-default)] rounded-control border border-border">{resource.data.items.map((account) => <li key={account.id}><button type="button" className="w-full px-3 py-2 text-left text-[13px] hover:bg-[var(--background-selected)]" onClick={() => onPick(account)}><span className="font-medium">{account.displayName}</span> <span className="text-secondary">· {account.username} · {account.roles.map(roleLabel).join(' · ') || 'Sin roles'}</span></button></li>)}</ul> : <p className="text-xs text-secondary">Ninguna cuenta coincide.</p>)}
  </div>
}

function SelectedAccount({ account, onChange }) {
  return <div className="flex flex-wrap items-center justify-between gap-3 rounded-control border border-border bg-secondary px-4 py-3" aria-label="Cuenta seleccionada" role="group">
    <div className="min-w-0 text-[13px]"><p className="font-medium">{account.displayName}</p><p className="text-xs text-secondary">{account.username}{account.roles.length > 0 && ` · ${account.roles.map(roleLabel).join(' · ')}`}{account.state && ` · ${account.state === 'ACTIVE' ? 'Activa' : 'Deshabilitada'}`}</p>
      <TechnicalDetails className="mt-1"><dl><dt>Identificador de la cuenta</dt><dd className="mono">{account.id}</dd></dl></TechnicalDetails></div>
    {onChange && <Button variant="ghost" className="h-8" onClick={onChange}>Cambiar cuenta</Button>}
  </div>
}

// Alcance documental por rol y familia: sin registro activo no hay acceso (denegar por defecto).
function ScopeMatrix({ refreshKey, onChange }) {
  const resource = useOperationsRead(SCOPES_PATH, scopeList)
  useRefresh(resource, refreshKey)
  return <section className="space-y-3" aria-labelledby="alcance-vigente"><SectionHeader id="alcance-vigente" title="Alcance por familia" /><p className="text-xs text-secondary">Qué familias documentales puede consultar cada rol. Sin acceso es el valor predeterminado.</p>
    {resource.state === 'loading' ? <TableSkeleton label="Cargando alcances…" columns={5} rows={3} /> : resource.error ? <ErrorState error={resource.error} onRetry={resource.reload} context="los alcances" /> : resource.data && <DataTable caption="Alcance por familia vigente" rowKey="role" rows={ROLES.map((role) => ({ role }))} columns={[
      { key: 'role', label: 'Rol', render: (row) => <span className="font-medium">{roleLabel(row.role)}</span> },
      ...families.map((family) => ({ key: family, label: familyLabel(family), render: (row) => { const granted = resource.data.has(row.role, family); return <span className="inline-flex flex-wrap items-center gap-2"><Badge variant={granted ? 'success' : 'neutral'}>{granted ? 'Con acceso' : 'Sin acceso'}</Badge><button type="button" className="text-xs underline" aria-label={`${granted ? 'Quitar' : 'Dar'} acceso a ${roleLabel(row.role)} en ${familyLabel(family)}`} onClick={() => onChange({ role_id: row.role, source_family: family, active: !granted })}>{granted ? 'Quitar' : 'Dar'}</button></span> } })),
    ]} />}
  </section>
}

// Excepciones documentales vigentes por cuenta o por rol; el documento se identifica solo por su identificador.
function ExceptionDirectory({ refreshKey, onAction }) {
  const [filters, setFilters] = useState({ subject: '', role_id: '', document_id: '' })
  const pages = useLocalPages(JSON.stringify(filters))
  const { path, error } = readPath(exceptionsPath, { ...filters, cursor: pages.cursor })
  const resource = useOperationsRead(path, exceptionPage)
  useRefresh(resource, refreshKey)
  const change = (patch) => setFilters((current) => ({ ...current, ...patch }))
  const chips = [
    ...(filters.subject ? [{ id: 'subject', label: filters.subject === 'USER' ? 'Por cuenta' : 'Por rol', onRemove: () => change({ subject: '' }) }] : []),
    ...(filters.role_id ? [{ id: 'role', label: `Rol: ${roleLabel(filters.role_id)}`, onRemove: () => change({ role_id: '' }) }] : []),
    ...(filters.document_id ? [{ id: 'document', label: `Documento: ${filters.document_id}`, onRemove: () => change({ document_id: '' }) }] : []),
  ]
  const preset = (row, patch) => ({ subject: row.subject, account: row.subject === 'USER' ? { id: row.accountId, username: row.username, displayName: row.displayName, roles: [] } : null, values: { role_id: row.roleId, document_id: row.documentId, decision: row.decision, active: true, ...patch } })
  const data = resource.data
  return <section className="space-y-4" aria-labelledby="excepciones-vigentes">
    <SectionHeader id="excepciones-vigentes" title="Excepciones vigentes"><Button onClick={() => onAction('exception', {})}><Icon name="zoomIn" size={16} />Nueva excepción</Button></SectionHeader>
    <FilterToolbar label="Filtros de excepciones" chips={chips} onClearAll={() => setFilters({ subject: '', role_id: '', document_id: '' })} primary={<>
      <Select label="Aplica a" value={filters.subject} options={[{ value: '', label: 'Cuentas y roles' }, { value: 'USER', label: 'Cuentas' }, { value: 'ROLE', label: 'Roles' }]} onChange={(event) => change({ subject: event.target.value })} />
      <Select label="Rol" value={filters.role_id} options={[{ value: '', label: 'Todos' }, ...ROLES.map((value) => ({ value, label: roleLabel(value) }))]} onChange={(event) => change({ role_id: event.target.value })} />
      <SearchField label="Documento (identificador)" value={filters.document_id} maxLength={256} onApply={(value) => change({ document_id: value })} />
    </>} />
    {error ? <ErrorState error={error} /> : resource.state === 'loading' ? <TableSkeleton label="Cargando excepciones…" columns={5} /> : resource.error ? <ErrorState error={resource.error} onRetry={resource.reload} context="las excepciones" /> : !data?.items.length ? <EmptyState title="Sin excepciones vigentes" message="Las excepciones por documento que autorices o deniegues aparecerán aquí." /> : <div className="space-y-4">
      <ResultsSummary count={data.items.length} hasMore={Boolean(data.nextCursor)} noun={['excepción', 'excepciones']} />
      <DataTable caption="Excepciones documentales vigentes" rows={data.items} columns={[
        { key: 'documentId', label: 'Documento', wide: true, render: (row) => <span className="mono break-all">{row.documentId}</span> },
        { key: 'subject', label: 'Aplica a', render: (row) => row.subject === 'USER' ? <span>{row.displayName}<span className="block text-xs text-muted">{row.username}</span></span> : <span>Rol {roleLabel(row.roleId)}</span> },
        { key: 'decision', label: 'Decisión', render: (row) => <Badge variant={row.decision === 'ALLOW' ? 'success' : 'critical'}>{decisionLabel(row.decision)}</Badge> },
        { key: 'createdLabel', label: 'Vigente desde', nowrap: true },
        { key: 'actions', label: 'Acciones', fit: true, sticky: true, render: (row) => <ActionMenu label={`Acciones para la excepción de ${row.documentId}`} items={[
          { id: 'switch', label: `Cambiar a ${decisionLabel(row.decision === 'ALLOW' ? 'DENY' : 'ALLOW')}`, onSelect: () => onAction('exception', preset(row, { decision: row.decision === 'ALLOW' ? 'DENY' : 'ALLOW' })) },
          { id: 'revoke', label: 'Retirar excepción', onSelect: () => onAction('exception', preset(row, { active: false })) },
        ]} /> },
      ]} />
      <CursorPager {...pages.pager(data.nextCursor)} />
    </div>}
  </section>
}

// Tras crear una cuenta su identificador se puede copiar; la cuenta ya aparece en la lista.
function CreatedIdentifier({ id }) {
  const [copy, setCopy] = useState(null)
  async function copyId() { try { await navigator.clipboard.writeText(id); setCopy('Identificador copiado.') } catch { setCopy('No se pudo copiar; selecciónalo y cópialo manualmente.') } }
  return <div className="mt-2 space-y-2"><p>Identificador creado: <span className="select-all break-all font-mono text-[12px] text-primary">{id}</span></p><p>La cuenta ya aparece en la lista de cuentas registradas.</p><div className="flex flex-wrap items-center gap-3"><Button variant="secondary" className="h-8" onClick={copyId}>Copiar identificador</Button>{copy && <span aria-live="polite">{copy}</span>}</div></div>
}

// Diálogo de una operación: formulario → (revisión, si aplica) → resultado. El formulario sigue montado durante la
// revisión para leer la contraseña solo al confirmar.
function OperationDialog({ principal, request, onClose, onDone }) {
  const { action: requested, account: initialAccount = null, subject: initialSubject = null, values = {} } = request
  const [account, setAccount] = useState(initialAccount)
  const [subject, setSubject] = useState(initialSubject ?? 'USER')
  const [step, setStep] = useState('form'); const [pending, setPending] = useState(null); const [error, setError] = useState(null); const [created, setCreated] = useState(null)
  const formRef = useRef(null); const backRef = useRef(null)
  const mutation = useOperation()
  const action = requested === 'exception' ? (subject === 'ROLE' ? 'role-exception' : 'user-exception') : requested
  const capability = actionOf(requested).capability
  const needsAccount = ['update', 'activate', 'disable', 'reset', 'roles', 'user-exception'].includes(action)
  const requiresPassword = ['create', 'reset'].includes(action)
  const blocked = mutation.busy || Boolean(mutation.error && ![403, 409, 422].includes(mutation.error.status))
  // Una excepción elegida en su tabla conserva a quién aplica y su documento.
  const fixedException = Boolean(values.document_id)
  const title = requested === 'exception' ? (fixedException ? `Excepción de ${values.document_id}` : initialAccount ? `Excepción documental · ${initialAccount.displayName}` : 'Nueva excepción') : requested === 'scope' ? `${values.active ? 'Dar' : 'Quitar'} acceso` : initialAccount ? `${actionOf(requested).label} · ${initialAccount.displayName}` : actionOf(requested).label
  // El foco va al primer campo (el diálogo enfoca antes su botón de cierre).
  useEffect(() => { const timer = setTimeout(() => formRef.current?.querySelector('input:not([type="hidden"]), select, textarea, button[type="submit"]')?.focus(), 0); return () => clearTimeout(timer) }, [])
  useEffect(() => { if (step === 'review') backRef.current?.focus() }, [step])

  async function perform(fields) {
    setError(null)
    const result = await mutation.execute(capability, (api) => api.administer(action, fields))
    if (Object.hasOwn(fields, 'password')) fields.password = ''
    if (formRef.current?.elements.password) formRef.current.elements.password.value = ''
    if (!result) { setStep('form'); setPending(null); return }
    if (action === 'create') { setCreated({ id: result.id, username: fields.username }); onDone(`Cuenta ${fields.username} creada.`, { close: false }); return }
    onDone(doneMessage(action, fields, account), { close: true })
  }
  async function confirm() {
    const fields = { ...pending }
    if (requiresPassword) { const element = formRef.current?.elements.password; fields.password = element?.value ?? '' }
    try { await perform(fields) } catch (cause) { fields.password = ''; setError(cause) }
  }
  async function submit(event) {
    event.preventDefault(); if (blocked) return
    const form = event.currentTarget; const data = new FormData(form)
    const fields = Object.fromEntries(data); fields.roles = data.getAll('roles'); fields.active = fields.active === 'true'
    try {
      if (needsAccount && !uuid(fields.account_id)) throw new ApiError(422)
      if (action === 'roles' && fields.account_id.toLowerCase() === principal.id.toLowerCase()) throw new ApiError(403)
      if (['create', 'roles'].includes(action) && !fields.roles.length) throw new ApiError(422)
      setError(null)
      if (REVIEW[action]) { const { password, ...summary } = fields; setPending(summary); setStep('review'); return }
      await perform(fields)
    } catch (cause) { fields.password = ''; if (requiresPassword) form.elements.password.value = ''; setError(cause) }
  }
  const failure = error || mutation.error
  const close = () => { if (!mutation.busy) onClose() }
  const failureView = failure && <ErrorState error={failure} title={failure.status === 403 ? undefined : `No se pudo completar «${actionOf(requested).label}»`} />
  return <Modal open title={title} onClose={close}><div className="space-y-4">
    {created ? <>
      <ActionNotice title={`Cuenta ${created.username} creada.`}><CreatedIdentifier id={created.id} /></ActionNotice>
      <div className="flex justify-end"><Button onClick={onClose}>Listo</Button></div>
    </> : <>
      <form ref={formRef} onSubmit={submit} hidden={step === 'review'} className="space-y-4">
        {requested === 'exception' && !fixedException && !initialAccount && <fieldset className="space-y-2"><legend className="text-xs font-medium text-secondary">Aplica a</legend><div className="flex flex-wrap gap-4 text-sm">{[['USER', 'Una cuenta'], ['ROLE', 'Un rol']].map(([value, text]) => <label key={value} className="inline-flex items-center gap-2"><input type="radio" name="subject" value={value} checked={subject === value} onChange={() => { setSubject(value); setAccount(null) }} />{text}</label>)}</div></fieldset>}
        {needsAccount && (account ? <><input type="hidden" name="account_id" value={account.id} /><SelectedAccount account={account} onChange={initialAccount ? null : () => setAccount(null)} /></> : <AccountPicker onPick={setAccount} />)}
        {action === 'create' && <Input label="Usuario" name="username" required maxLength={256} autoComplete="off" disabled={blocked} />}
        {['create', 'update'].includes(action) && <Input label="Nombre visible" name="display_name" required maxLength={256} disabled={blocked} defaultValue={action === 'update' ? account?.displayName : undefined} />}
        {requiresPassword && <PasswordInput label="Contraseña nueva" name="password" autoComplete="new-password" minLength={1} maxLength={128} required disabled={blocked} />}
        {['create', 'roles'].includes(action) && <fieldset className="space-y-2"><legend className="text-xs font-medium text-secondary">Roles activos</legend>{ROLES.map((value) => <label key={value} className="mr-4 inline-flex items-center gap-2 text-sm"><input type="checkbox" name="roles" value={value} disabled={blocked} defaultChecked={action === 'roles' && Boolean(account?.roles.includes(value))} />{roleLabel(value)}</label>)}</fieldset>}
        {action === 'activate' && <p className="text-[13px] text-secondary">La cuenta podrá volver a iniciar sesión con sus roles actuales.</p>}
        {action === 'scope' && <><input type="hidden" name="role_id" value={values.role_id} /><input type="hidden" name="source_family" value={values.source_family} /><input type="hidden" name="active" value={String(Boolean(values.active))} /><p className="text-[13px] text-secondary">El rol <span className="font-medium text-primary">{roleLabel(values.role_id)}</span> {values.active ? 'podrá consultar' : 'dejará de consultar'} los documentos de <span className="font-medium text-primary">{familyLabel(values.source_family)}</span>. Las sesiones abiertas de las cuentas con ese rol se cerrarán para aplicar el cambio.</p></>}
        {action === 'role-exception' && (fixedException ? <><input type="hidden" name="role_id" value={values.role_id} /><p className="text-[13px] text-secondary">Aplica al rol <span className="font-medium text-primary">{roleLabel(values.role_id)}</span>.</p></> : <Select label="Rol" name="role_id" options={ROLES.map((v) => ({ value: v, label: roleLabel(v) }))} disabled={blocked} />)}
        {['user-exception', 'role-exception'].includes(action) && <p className="text-[13px] text-secondary">Al guardar se cerrarán las sesiones abiertas de {action === 'user-exception' ? 'la cuenta' : 'las cuentas con ese rol'} para aplicar el cambio.</p>}
        {['user-exception', 'role-exception'].includes(action) && <><Input label="Identificador del documento" name="document_id" required maxLength={256} disabled={blocked} readOnly={fixedException} defaultValue={values.document_id} /><Select label="Decisión documental" name="decision" defaultValue={values.decision} options={[{ value: 'DENY', label: 'Denegar' }, { value: 'ALLOW', label: 'Autorizar' }]} disabled={blocked} /><Select label="Vigencia" name="active" defaultValue={values.active === false ? 'false' : 'true'} options={[{ value: 'true', label: 'Vigente' }, { value: 'false', label: 'Retirada' }]} disabled={blocked} /></>}
        {failureView}
        {blocked && !mutation.busy && <p className="text-sm">Resultado incierto. Revisa Auditoría antes de realizar otra operación.</p>}
        <div className="flex flex-wrap justify-end gap-3"><Button variant="secondary" disabled={mutation.busy} onClick={close}>Cancelar</Button><Button type="submit" busy={mutation.busy} disabled={blocked || needsAccount && !account}>{REVIEW[action] ? 'Revisar' : action === 'scope' ? (values.active ? 'Dar acceso' : 'Quitar acceso') : action === 'create' ? 'Crear cuenta' : action === 'activate' ? 'Activar cuenta' : 'Guardar'}</Button></div>
      </form>
      {step === 'review' && pending && <div className="space-y-4" role="group" aria-label="Revisión"><p className="text-sm text-secondary">{REVIEW[action].text(pending, account)}</p>
        {failureView}
        <div className="flex flex-wrap justify-end gap-3"><Button ref={backRef} variant="secondary" disabled={mutation.busy} onClick={() => { setStep('form'); setPending(null) }}>Volver</Button><Button variant={REVIEW[action].variant} busy={mutation.busy} onClick={confirm}>{REVIEW[action].button}</Button></div></div>}
    </>}
  </div></Modal>
}

function AdministrationWorkspace({ principal }) {
  const sections = SECTIONS.filter((section) => section.id === 'accounts' ? ACCOUNT_READ_CAPABILITIES.some((capability) => can(principal, capability)) || can(principal, 'user.create') : can(principal, 'document_acl.manage'))
  const [section, setSection] = useState(sections[0]?.id ?? 'accounts')
  const [dialog, setDialog] = useState(null); const [notice, setNotice] = useState(null); const [refreshKey, setRefreshKey] = useState(0)
  const open = (action, request) => { setNotice(null); setDialog({ action, ...request }) }
  // Al terminar: aviso sobre la lista y relectura; el diálogo se cierra salvo al crear (muestra el identificador).
  function done(message, { close }) { setNotice(message); setRefreshKey((value) => value + 1); if (close) setDialog(null) }
  const tab = SECTIONS.find((item) => item.id === section).tab
  return <>
    <PageHeader title="Administración" description="Cuentas, roles y permisos documentales del sistema." />
    {sections.length > 1 && <Tabs label="Secciones de administración" items={sections.map((item) => ({ id: item.tab, label: item.label, panelId: 'admin-seccion' }))} active={tab} onChange={(next) => { setNotice(null); setSection(SECTIONS.find((item) => item.tab === next).id) }} />}
    <div id="admin-seccion" role={sections.length > 1 ? 'tabpanel' : undefined} aria-labelledby={sections.length > 1 ? tab : undefined} className="space-y-8">
      {notice && <ActionNotice title={notice} onDismiss={() => setNotice(null)} />}
      {section === 'accounts' && <AccountDirectory principal={principal} refreshKey={refreshKey} onAction={open} />}
      {section === 'permissions' && <><ScopeMatrix refreshKey={refreshKey} onChange={(values) => open('scope', { values })} /><ExceptionDirectory refreshKey={refreshKey} onAction={open} /></>}
    </div>
    {dialog && <OperationDialog principal={principal} request={dialog} onClose={() => setDialog(null)} onDone={done} />}
  </>
}

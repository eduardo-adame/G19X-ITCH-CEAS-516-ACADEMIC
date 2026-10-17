import React, { useRef, useState } from 'react'
import { useSession } from '../../auth/SessionProvider.jsx'
import { can } from '../../auth/permissions.js'
import { ApiError } from '../../api/errors.js'
import { PageHeader, Modal } from '../../components/layout.jsx'
import { Button, Input, PasswordInput, Select, Tabs } from '../../components/controls.jsx'
import { ActionNotice, ErrorState } from '../../components/feedback.jsx'
import { families, uuid } from './adapters.js'
import { familyLabel, roleLabel } from '../../shared/labels.js'
import { useOperation } from './api.js'

export const adminActions = [
  { value: 'create', label: 'Crear cuenta', capability: 'user.create', section: 'accounts' },
  { value: 'update', label: 'Editar nombre', capability: 'user.update', section: 'accounts' },
  { value: 'activate', label: 'Activar cuenta', capability: 'user.update', section: 'accounts' },
  { value: 'disable', label: 'Deshabilitar cuenta', capability: 'user.disable', section: 'accounts' },
  { value: 'reset', label: 'Restablecer acceso', capability: 'user.reset_access', section: 'accounts' },
  { value: 'roles', label: 'Asignar roles', capability: 'role.assign', section: 'accounts' },
  { value: 'scope', label: 'Alcance por familia', capability: 'document_acl.manage', section: 'permissions' },
  { value: 'user-exception', label: 'Excepción documental por cuenta', capability: 'document_acl.manage', section: 'permissions' },
  { value: 'role-exception', label: 'Excepción documental por rol', capability: 'document_acl.manage', section: 'permissions' },
]
const SECTIONS = Object.freeze([{ id: 'accounts', label: 'Cuentas', tab: 'admin-cuentas' }, { id: 'permissions', label: 'Permisos documentales', tab: 'admin-permisos' }])

// La API no lista cuentas (F-11): el identificador creado se muestra con «Copiar» para reutilizarlo después.
function CreatedIdentifier({ id }) {
  const [copy, setCopy] = useState(null)
  async function copyId() { try { await navigator.clipboard.writeText(id); setCopy('Identificador copiado.') } catch { setCopy('No se pudo copiar; selecciónalo y cópialo manualmente.') } }
  return <div className="mt-2 space-y-2"><p>Identificador creado: <span className="select-all break-all font-mono text-[12px] text-primary">{id}</span></p><p>Guárdalo: lo necesitarás para editar la cuenta, asignar roles o restablecer su acceso.</p><div className="flex flex-wrap items-center gap-3"><Button variant="secondary" className="h-8" onClick={copyId}>Copiar identificador</Button>{copy && <span aria-live="polite">{copy}</span>}</div></div>
}
const roles = ['JURIDICO', 'ANALISTA', 'TI']
// Operaciones que se confirman con un resumen antes de aplicarse. La contraseña nunca entra en el resumen ni en
// el estado React: se lee del formulario solo al confirmar.
const CONFIRMATIONS = Object.freeze({
  disable: { title: 'Confirmar deshabilitación', button: 'Confirmar deshabilitación', variant: 'danger', text: () => 'Se invalidarán las sesiones afectadas. No se elimina la cuenta.' },
  roles: { title: 'Confirmar asignación de roles', button: 'Asignar roles', variant: 'primary', text: (fields) => <>La cuenta <span className="mono break-all">{fields.account_id}</span> quedará exactamente con: <span className="font-medium text-primary">{fields.roles.map(roleLabel).join(' · ')}</span>. Sus roles actuales se sustituyen y sus sesiones abiertas se cerrarán.</> },
  reset: { title: 'Confirmar restablecimiento de acceso', button: 'Restablecer acceso', variant: 'danger', text: (fields) => <>Se asignará la contraseña nueva a la cuenta <span className="mono break-all">{fields.account_id}</span> y se cerrarán sus sesiones abiertas.</> },
})
export function AdministrationPage() {
  const { principal, generation } = useSession()
  if (!principal?.roles.includes('TI') || !can(principal, 'user.create')) return <ErrorState error={new ApiError(403)} />
  return <AdministrationWorkspace key={generation} principal={principal} />
}
function AdministrationWorkspace({ principal }) {
  const available = adminActions.filter((item) => can(principal, item.capability))
  const sections = SECTIONS.filter((section) => available.some((item) => item.section === section.id))
  const [action, setAction] = useState('create'); const [formKey, setFormKey] = useState(0); const [error, setError] = useState(null); const [pending, setPending] = useState(null)
  const formRef = useRef(null); const cancelRef = useRef(null)
  const section = adminActions.find((item) => item.value === action).section
  function choose(next) { setAction(next); setFormKey((v) => v + 1); setError(null); mutation.clear(); setPending(null) }
  const mutation = useOperation()
  const account = ['update', 'activate', 'disable', 'reset', 'roles', 'user-exception'].includes(action)
  const role = ['scope', 'role-exception'].includes(action)
  const requiresPassword = ['create', 'reset'].includes(action)
  const blocked = mutation.busy || Boolean(mutation.error && ![403, 409, 422].includes(mutation.error.status))
  async function perform(fields) {
    setError(null)
    const result = await mutation.execute(adminActions.find((item) => item.value === action).capability, (api) => api.administer(action, fields))
    // La contraseña nunca forma parte del resultado ni del estado React.
    if (Object.hasOwn(fields, 'password')) fields.password = ''
    setFormKey((v) => v + 1); setPending(null)
    return result
  }
  // Al confirmar se recupera la contraseña del formulario (si aplica) y se borra del control visible.
  async function confirmPending() {
    const fields = { ...pending }
    if (requiresPassword) { const element = formRef.current?.elements.password; fields.password = element?.value ?? ''; if (element) element.value = '' }
    try { await perform(fields) } catch (cause) { fields.password = ''; setPending(null); setError(cause) }
  }
  async function submit(event) {
    event.preventDefault(); if (blocked) return
    const form = event.currentTarget; const data = new FormData(form)
    const fields = Object.fromEntries(data); fields.roles = data.getAll('roles'); fields.active = fields.active === 'true'
    try {
      if (account && !uuid(fields.account_id)) throw new ApiError(422)
      if (action === 'roles' && fields.account_id.toLowerCase() === principal.id.toLowerCase()) throw new ApiError(403)
      if (['create', 'roles'].includes(action) && !fields.roles.length) throw new ApiError(422)
      setError(null)
      if (CONFIRMATIONS[action]) { const { password, ...summary } = fields; setPending(summary); return }
      // Borrar de inmediato el control visible; el transporte solo lo retiene hasta completar la petición.
      if (requiresPassword) form.elements.password.value = ''
      await perform(fields)
    } catch (cause) { fields.password = ''; if (requiresPassword) form.elements.password.value = ''; setError(cause) }
  }
  return <>
    <PageHeader title="Administración" description="Operaciones TI sobre cuentas e identificadores conocidos. No existe un catálogo de búsqueda en esta API." />
    {sections.length > 1 && <Tabs label="Secciones de administración" items={sections.map((item) => ({ id: item.tab, label: item.label, panelId: 'admin-operacion' }))} active={SECTIONS.find((item) => item.id === section).tab} onChange={(tab) => { if (!mutation.busy) choose(available.find((item) => item.section === SECTIONS.find((entry) => entry.tab === tab).id).value) }} />}
    <div id="admin-operacion" role={sections.length > 1 ? 'tabpanel' : undefined} aria-labelledby={sections.length > 1 ? SECTIONS.find((item) => item.id === section).tab : undefined} className="space-y-6">
    <Select label="Operación administrativa" value={action} disabled={mutation.busy} options={available.filter((item) => item.section === section)} onChange={(e) => choose(e.target.value)} />
    <form ref={formRef} key={`${action}:${formKey}`} onSubmit={submit} className="grid grid-cols-1 items-end gap-4 md:grid-cols-2">
      {account && <Input label="Identificador conocido de cuenta (UUID)" name="account_id" required disabled={blocked} />}
      {action === 'create' && <Input label="Usuario" name="username" required maxLength={256} autoComplete="off" disabled={blocked} />}
      {['create', 'update'].includes(action) && <Input label="Nombre visible" name="display_name" required maxLength={256} disabled={blocked} />}
      {requiresPassword && <PasswordInput label="Contraseña nueva" name="password" autoComplete="new-password" minLength={1} maxLength={128} required disabled={blocked} />}
      {['create', 'roles'].includes(action) && <fieldset className="space-y-2"><legend className="text-xs font-medium text-secondary">Roles activos</legend>{roles.map((value) => <label key={value} className="mr-4 inline-flex items-center gap-2 text-sm"><input type="checkbox" name="roles" value={value} disabled={blocked} />{roleLabel(value)}</label>)}</fieldset>}
      {role && <Select label="Rol" name="role_id" options={roles.map((v) => ({ value: v, label: roleLabel(v) }))} disabled={blocked} />}
      {action === 'scope' && <Select label="Familia documental" name="source_family" options={families.map((v) => ({ value: v, label: familyLabel(v) }))} disabled={blocked} />}
      {['user-exception', 'role-exception'].includes(action) && <><Input label="Identificador conocido de documento" name="document_id" required maxLength={256} disabled={blocked} /><Select label="Decisión documental" name="decision" options={[{ value: 'DENY', label: 'Denegar' }, { value: 'ALLOW', label: 'Autorizar' }]} disabled={blocked} /></>}
      {['scope', 'user-exception', 'role-exception'].includes(action) && <Select label="Vigencia del permiso" name="active" options={[{ value: 'true', label: 'Activo' }, { value: 'false', label: 'Inactivo' }]} disabled={blocked} />}
      <div className="md:col-span-2"><Button type="submit" busy={mutation.busy} disabled={blocked}>Aplicar operación</Button></div>
    </form>
    {action === 'roles' && <p className="text-sm text-secondary">No puedes modificar tus propios roles.</p>}
    {action === 'disable' && <p className="text-sm text-secondary">El servidor impide deshabilitar al último TI activo y conserva las referencias históricas.</p>}
    {(error || mutation.error) && <ErrorState error={error || mutation.error} title={(error || mutation.error).status === 403 ? undefined : `No se pudo completar «${adminActions.find((item) => item.value === action).label}»`} />}
    {blocked && !mutation.busy && <p className="text-sm">Resultado incierto. Revisa Auditoría antes de realizar otra mutación.</p>}
    {mutation.result && <ActionNotice title={`${adminActions.find((item) => item.value === action).label}: operación confirmada.`}>{mutation.result.id && <CreatedIdentifier id={mutation.result.id} />}</ActionNotice>}
    </div>
    <Modal open={Boolean(pending)} title={CONFIRMATIONS[action]?.title ?? ''} initialFocus={cancelRef} onClose={() => { if (!mutation.busy) setPending(null) }}><div className="space-y-4"><p className="text-sm text-secondary">{pending && CONFIRMATIONS[action]?.text(pending)}</p><div className="flex flex-wrap justify-end gap-3"><Button ref={cancelRef} variant="secondary" disabled={mutation.busy} onClick={() => setPending(null)}>Cancelar</Button><Button variant={CONFIRMATIONS[action]?.variant} busy={mutation.busy} onClick={confirmPending}>{CONFIRMATIONS[action]?.button}</Button></div></div></Modal>
  </>
}

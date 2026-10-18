// Aviso de por qué se cerró la sesión cuando la propia persona cambió permisos que afectan a su cuenta
// (RF-069 cierra esas sesiones). Solo vive en memoria y caduca a los dos minutos; nunca se guarda.
const WINDOW_MS = 120000
let markedAt = 0

export function notePermissionChange(now = Date.now()) { markedAt = now }

// Lectura sin efectos (segura aunque React la ejecute dos veces en modo estricto) y borrado por separado.
export function hasPermissionChange(now = Date.now()) { return markedAt > 0 && now - markedAt < WINDOW_MS }
export function clearPermissionChange() { markedAt = 0 }

// Devuelve si hay un cambio reciente y lo consume: el aviso se muestra una sola vez.
export function consumePermissionChange(now = Date.now()) {
  const recent = hasPermissionChange(now)
  clearPermissionChange()
  return recent
}

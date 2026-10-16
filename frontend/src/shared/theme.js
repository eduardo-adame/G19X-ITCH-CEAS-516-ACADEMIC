// Tema claro/oscuro (DESIGN §20). Sin elección guardada se sigue al sistema operativo mediante CSS
// (prefers-color-scheme), sin parpadeo; la elección explícita se guarda solo como preferencia de interfaz
// («claro»/«oscuro»), nunca junto a datos de sesión, consultas o resultados.
const KEY = 'riesgo-legal.tema'
const STORED = Object.freeze({ claro: 'light', oscuro: 'dark' })
const STORED_NAME = Object.freeze({ light: 'claro', dark: 'oscuro' })

export function storedTheme() {
  try { return STORED[window.localStorage.getItem(KEY)] ?? null } catch { return null }
}
export function systemTheme() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}
export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme
}
export function saveTheme(theme) {
  try { window.localStorage.setItem(KEY, STORED_NAME[theme]) } catch { /* Sin almacenamiento disponible: el tema dura lo que la página. */ }
}
// Se ejecuta antes del primer render para que la elección guardada no parpadee.
export function initTheme() {
  const stored = storedTheme()
  if (stored) applyTheme(stored)
}

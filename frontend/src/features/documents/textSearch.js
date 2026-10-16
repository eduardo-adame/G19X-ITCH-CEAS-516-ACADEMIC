// Búsqueda local en el texto ya entregado por el visor: sin distinguir mayúsculas ni acentos.
// Se normaliza carácter por carácter para traducir cada coincidencia a posiciones del texto original.
export const MIN_SEARCH_LENGTH = 2
export const MAX_MATCHES = 1000

function fold(value) {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('es-MX')
}

export function foldedIndex(text) {
  let folded = ''
  const origin = []
  let index = 0
  for (const char of text) {
    const part = fold(char)
    for (let step = 0; step < part.length; step++) origin.push(index)
    folded += part
    index += char.length
  }
  origin.push(index)
  return { folded, origin }
}

// Devuelve [inicio, fin) en el texto original; se limita para no bloquear documentos extensos.
export function findMatches(text, query, index = foldedIndex(text || '')) {
  const needle = fold(String(query || '').trim())
  if (!text || Array.from(needle).length < MIN_SEARCH_LENGTH) return []
  const matches = []
  let from = 0
  while (matches.length < MAX_MATCHES) {
    const found = index.folded.indexOf(needle, from)
    if (found < 0) break
    matches.push([index.origin[found], index.origin[found + needle.length]])
    from = found + needle.length
  }
  return matches
}

// Divide el texto en tramos normales y coincidencias para resaltarlos sin HTML.
export function segments(text, matches) {
  const parts = []
  let cursor = 0
  matches.forEach(([start, end], match) => {
    if (start > cursor) parts.push({ text: text.slice(cursor, start) })
    parts.push({ text: text.slice(start, end), match })
    cursor = end
  })
  if (cursor < text.length) parts.push({ text: text.slice(cursor) })
  return parts
}

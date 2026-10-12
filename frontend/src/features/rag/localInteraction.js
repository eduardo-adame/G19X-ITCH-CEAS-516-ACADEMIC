const greetings = new Set(['hola', 'buenos días', 'buenas tardes', 'buenas noches', 'qué tal', 'que tal'])
const help = new Set(['ayuda', 'qué puedes hacer', 'que puedes hacer', 'cómo funciona', 'como funciona', 'cómo puedo consultar', 'como puedo consultar'])
const thanks = new Set(['gracias', 'muchas gracias', 'perfecto gracias'])

const responses = Object.freeze({
  GREETING: 'Hola. Puedo ayudarte a consultar la documentación jurídica a la que tienes acceso.\n\nPuedes preguntarme sobre cláusulas, obligaciones, fechas, contratos, litigios, cumplimiento y otra evidencia disponible.',
  HELP: 'Puedo buscar información en los documentos a los que tienes acceso, mostrar la evidencia utilizada y llevarte al fragmento correspondiente.\n\nPuedes indicar un documento, asunto, fecha, obligación o cláusula.',
  THANKS: 'Con gusto. Puedes realizar otra consulta cuando quieras.',
})

export const suggestedQuestions = Object.freeze([
  '¿Qué obligaciones aparecen en los documentos disponibles?',
  '¿Qué fechas relevantes aparecen en la documentación?',
  '¿Qué cláusulas relacionadas con terminación están disponibles?',
  '¿Qué información existe sobre un asunto específico?',
])

export function classifyLocalInteraction(query) {
  if (typeof query !== 'string') return 'RAG'
  // La comparación es completa: un saludo seguido de otra consulta conserva el flujo documental.
  const comparison = query.trim().normalize('NFC').toLowerCase().replace(/^[¿¡]/u, '').replace(/[.!?¡¿]+$/u, '').trim()
  if (greetings.has(comparison)) return 'GREETING'
  if (help.has(comparison)) return 'HELP'
  if (thanks.has(comparison)) return 'THANKS'
  return 'RAG'
}

export function getLocalInteraction(query) {
  const kind = classifyLocalInteraction(query)
  return kind === 'RAG' ? null : { kind, message: responses[kind] }
}

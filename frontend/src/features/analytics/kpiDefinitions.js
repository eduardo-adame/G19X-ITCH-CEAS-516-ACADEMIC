// Definición de cada indicador en lenguaje llano, tomada del catálogo de indicadores del SRS (Tabla KPI-01, §1.3.2); no añade
// reglas ni fórmulas propias. Se muestra en la ayuda ⓘ de cada tarjeta.
export const KPI_DEFINITIONS = Object.freeze({
  'KPI-RC-03': 'Contratos cuya revisión no ha iniciado y que vencen entre hoy y los próximos 60 días, ambos incluidos. Los contratos ya vencidos no se cuentan.',
  'KPI-RC-01': 'Promedio de días entre la solicitud y la firma, para contratos con ambas fechas válidas.',
  'KPI-LI-01': 'Suma del monto de exposición de los litigios activos, por severidad (alto, medio y bajo). Si el expediente tiene una estimación interna, se usa en lugar del monto reclamado.',
  'KPI-LI-05': 'Litigios abiertos en el periodo, para compararlos con periodos anteriores.',
  'KPI-CN-02': 'Obligaciones regulatorias cuya fecha límite ya pasó sin evidencia de cumplimiento registrada.',
  'KPI-CN-03': 'Incidentes de incumplimiento normativo detectados en el periodo, por área y severidad.',
  'KPI-EO-01': 'Asuntos jurídicos (contratos, consultas, litigios y trámites) abiertos, en proceso y cerrados en el periodo, por tipo y estado.',
})

// Vista de dominio de cada indicador del resumen; cumplimiento y eficiencia no tienen vista propia.
export const KPI_DOMAIN_VIEWS = Object.freeze({
  'KPI-RC-03': Object.freeze({ path: '/contratos', label: 'Riesgo contractual' }),
  'KPI-LI-01': Object.freeze({ path: '/litigios', label: 'Gestión de litigios' }),
  'KPI-LI-05': Object.freeze({ path: '/litigios', label: 'Gestión de litigios' }),
})

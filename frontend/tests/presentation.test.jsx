import React from 'react'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import * as charts from '../src/features/analytics/charts.jsx'
import { EvidenceCard, RagStateBanner } from '../src/features/rag/components.jsx'
import { RiskBadge } from '../src/components/data.jsx'

const fragment = Object.freeze({ fragmentId: '11111111-1111-4111-8111-111111111111', documentId: 'DOC-1', documentName: 'Contrato sintético', documentType: 'DOCX', documentDate: null, pageStart: 1, pageEnd: 1, section: null, clause: null, text: 'Texto sintético citado.', usage: 'EVIDENCE' })

describe('ROBUSTNESS: presentación conforme a Legal Minimal sin datos inventados', () => {
  it('no ofrece superficies de exposición por tipo sin dimensión contractual', () => {
    expect(Object.keys(charts).some((name) => /ExposureType/.test(name))).toBe(false)
  })

  it.each([
    ['EVIDENCIA_SUFICIENTE', 'Evidencia suficiente'],
    ['EVIDENCIA_INSUFICIENTE', 'Evidencia insuficiente'],
    ['SIN_EVIDENCIA', 'Sin evidencia'],
    ['SIN_AUTORIZACION', 'Sin autorización'],
  ])('conserva el banner canónico %s sin copy adicional', (state, label) => {
    render(<MemoryRouter><RagStateBanner state={state} /></MemoryRouter>)
    expect(screen.getByRole('status').textContent).toBe(label)
  })

  it('la cita conserva enlace al visor y texto citado diferenciado sin divisores', () => {
    const { container } = render(<MemoryRouter><EvidenceCard fragment={fragment} handle="E1" /></MemoryRouter>)
    expect(screen.getByRole('link', { name: 'Ver fragmento en visor' })).toHaveAttribute('href', `/documentos?fragment_id=${fragment.fragmentId}`)
    expect(container.querySelector('blockquote')).toHaveClass('italic')
    expect(container.querySelector('.border-b')).toBeNull()
  })

  it('la severidad muestra un punto indicador decorativo y conserva el texto', () => {
    render(<RiskBadge level="Alto" />)
    expect(screen.getByText('Alto')).toBeVisible()
    expect(document.querySelector('[aria-hidden="true"].rounded-full')).not.toBeNull()
  })
})

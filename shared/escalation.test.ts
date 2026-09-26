import { describe, expect, it } from 'vitest'
import {
  authorityKindFor,
  buildComplaint,
  DEFAULT_ESCALATION_RULES,
  mailtoLink,
  shouldEscalate,
  type Authority,
  type Escalation,
} from '@shared/escalation'
import type { PhotoReport, Segment, SegmentStatus } from '@shared/contract'

const AUTHORITY: Authority = {
  kind: 'municipal',
  name: 'The Commissioner, Municipal Corporation',
  email: '',
}

function segment(overrides: Partial<Segment> = {}): Segment {
  return {
    id: 42,
    name: 'Test Road',
    highway: 'residential',
    roadClass: 'local',
    lengthM: 50,
    nearSensitive: false,
    busRoute: false,
    path: [
      [76.575, 30.768],
      [76.5754, 30.768],
    ],
    center: [76.5752, 30.768],
    ...overrides,
  }
}

function status(overrides: Partial<SegmentStatus> = {}): SegmentStatus {
  return {
    id: 42,
    score: 28,
    band: 'critical',
    risk30: 0.9,
    risk60: 0.95,
    risk90: 0.98,
    priority: 3,
    trend30: -0.4,
    estimatedCostInr: 125000,
    repairType: 'resurfacing',
    breakdown: {
      base: 100,
      bumpPenalty: 40,
      roughnessPenalty: 32,
      photoPenalty: 0,
    },
    bumpsLast7Days: 20,
    photoReportCount: 0,
    ...overrides,
  }
}

function photo(overrides: Partial<PhotoReport> = {}): PhotoReport {
  return {
    id: 'PR-001',
    segmentId: 42,
    segmentName: 'Test Road',
    imageUrl: '/mock-photos/road-1.svg',
    label: 'pothole',
    confidence: 0.9,
    box: { x: 0.2, y: 0.2, w: 0.2, h: 0.2 },
    severity: 'severe',
    status: 'approved',
    createdAt: new Date().toISOString(),
    reporter: 'A. Sharma',
    ...overrides,
  }
}

describe('deciding what is worth reporting', () => {
  it('reports a failing road that several drivers have hit', () => {
    const decision = shouldEscalate({
      segment: segment(),
      status: status(),
      approvedPhotos: [],
      lastEscalatedAt: null,
    })
    expect(decision.escalate).toBe(true)
  })

  it('refuses to report a road nobody has actually hit', () => {
    // The single most important rule. One phone reporting one impact could be
    // a speed bump, a manhole cover or a driver braking hard, and a complaint
    // built on that wastes a public official's time.
    const decision = shouldEscalate({
      segment: segment(),
      status: status({ bumpsLast7Days: 1 }),
      approvedPhotos: [],
      lastEscalatedAt: null,
    })
    expect(decision.escalate).toBe(false)
    expect(decision.reason).toContain('not enough to report')
  })

  it('accepts an approved photograph in place of impact counts', () => {
    const decision = shouldEscalate({
      segment: segment(),
      status: status({ bumpsLast7Days: 0 }),
      approvedPhotos: [photo()],
      lastEscalatedAt: null,
    })
    expect(decision.escalate).toBe(true)
  })

  it('leaves a road in decent condition alone', () => {
    const decision = shouldEscalate({
      segment: segment(),
      status: status({ score: 75, band: 'good', risk30: 0.05 }),
      approvedPhotos: [photo()],
      lastEscalatedAt: null,
    })
    expect(decision.escalate).toBe(false)
    expect(decision.reason).toContain('below the reporting threshold')
  })

  it('does not report the same road twice in a month', () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString()
    const decision = shouldEscalate({
      segment: segment(),
      status: status(),
      approvedPhotos: [],
      lastEscalatedAt: tenDaysAgo,
    })
    expect(decision.escalate).toBe(false)
    expect(decision.reason).toContain('cooldown')
  })

  it('reports again once the cooldown has passed', () => {
    const longAgo = new Date(Date.now() - 45 * 86_400_000).toISOString()
    const decision = shouldEscalate({
      segment: segment(),
      status: status(),
      approvedPhotos: [],
      lastEscalatedAt: longAgo,
    })
    expect(decision.escalate).toBe(true)
  })

  it('caps a run so the recipient can actually act on it', () => {
    expect(DEFAULT_ESCALATION_RULES.maxPerRun).toBeLessThanOrEqual(25)
  })
})

describe('routing to the right office', () => {
  it('sends a national highway to NHAI and a lane to the corporation', () => {
    expect(authorityKindFor(segment({ highway: 'trunk' }))).toBe('national')
    expect(authorityKindFor(segment({ highway: 'primary' }))).toBe('state')
    expect(authorityKindFor(segment({ highway: 'residential' }))).toBe(
      'municipal',
    )
  })
})

describe('the complaint itself', () => {
  const built = buildComplaint({
    segment: segment({ nearSensitive: true }),
    status: status(),
    authority: AUTHORITY,
    approvedPhotos: [photo()],
    reference: 'IP-2026-0042',
  })

  it('names the road and carries a reference', () => {
    expect(built.subject).toContain('Test Road')
    expect(built.subject).toContain('IP-2026-0042')
  })

  it('gives a crew somewhere to go, not just a score', () => {
    expect(built.body).toContain('30.768')
    expect(built.body).toContain('google.com/maps')
    expect(built.body).toContain('50 metres')
  })

  it('flags a school or hospital, which changes the priority', () => {
    expect(built.body).toContain('school or hospital')
  })

  it('states the evidence and the likely cost', () => {
    expect(built.body).toContain('PR-001')
    expect(built.body).toContain('Rs 1,25,000')
    expect(built.body).toContain('Resurfacing')
  })

  it('says a person reviewed it, because one did', () => {
    expect(built.body).toContain('reviewed by an engineer')
  })

  it('avoids jargon the recipient has no reason to know', () => {
    // No scores out of a hundred, no talk of models or risk percentages: a
    // junior engineer should be able to act on this or forward it as-is.
    for (const jargon of ['risk30', 'priority', 'band', 'score of']) {
      expect(built.body.toLowerCase()).not.toContain(jargon.toLowerCase())
    }
  })
})

describe('handing off to a mail client', () => {
  it('builds a mailto with the subject and body filled in', () => {
    const escalation = {
      id: 'IP-2026-0042',
      authority: { ...AUTHORITY, email: 'roads@example.test' },
      subject: 'Road damage report: Test Road',
      body: 'Sir / Madam,\n\nPlease repair this road.',
    } as Escalation

    const link = mailtoLink(escalation)
    expect(link.startsWith('mailto:roads@example.test?')).toBe(true)

    const query = new URLSearchParams(link.split('?')[1])
    expect(query.get('subject')).toBe(escalation.subject)
    // Newlines have to survive the round trip or the letter arrives as a blob.
    expect(query.get('body')).toBe(escalation.body)
  })
})

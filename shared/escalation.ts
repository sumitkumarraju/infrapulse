import type { PhotoReport, Segment, SegmentStatus } from './contract'
import { potholesFor } from './potholes'

/* Turning a failing road into a complaint someone can act on.
 *
 * The rules below decide when a segment has earned an official report, and the
 * builder turns it into text a works department can read without knowing
 * anything about this system. Both live in shared/ because the server generates
 * drafts and the client previews them, and a preview that did not match what
 * actually gets sent would be worse than no preview.
 *
 * Nothing here sends anything. Escalations are drafted, reviewed by a person,
 * and only then delivered — see server/src/escalation/Notifier.ts for why.
 */

export type EscalationStatus = 'draft' | 'approved' | 'sent' | 'dismissed'

/** Who is responsible for a road depends on what kind of road it is. */
export type AuthorityKind = 'national' | 'state' | 'municipal'

export interface Authority {
  kind: AuthorityKind
  name: string
  /** Empty until an operator configures it. Nothing sends without one. */
  email: string
  /** Optional public grievance portal, quoted in the draft for reference. */
  portal?: string
}

export interface Escalation {
  id: string
  segmentId: number
  segmentName: string
  status: EscalationStatus
  authority: Authority
  subject: string
  body: string
  /** Where the works crew should actually go. */
  location: { lat: number; lon: number; mapsUrl: string }
  severity: 'critical' | 'watch'
  /** Evidence ids, so a reply can be traced back to the data behind it. */
  photoReportIds: string[]
  estimatedCostInr: number
  createdAt: string
  approvedAt?: string
  sentAt?: string
  /** Set when a person declines to send it, with their reason. */
  dismissedReason?: string
}

/* ---------------------------------------------------------------------- */
/* When a road has earned a complaint                                      */
/* ---------------------------------------------------------------------- */

export interface EscalationRules {
  /** Below this score a segment is a candidate. */
  scoreBelow: number
  /** Or above this 30-day failure risk, even if the score is not yet critical. */
  risk30Above: number
  /**
   * Corroboration required before anything leaves the building.
   *
   * One phone reporting an impact is noise — a speed bump, a manhole, a driver
   * braking hard. Several independent readings on the same 50m, or a
   * photograph an engineer has approved, is evidence. This threshold is the
   * difference between a useful report and wasting a public official's time.
   */
  minBumpsLast7Days: number
  /** An approved photo report substitutes for the bump count. */
  photoCountsAsEvidence: boolean
  /** Do not report the same segment again within this many days. */
  cooldownDays: number
  /**
   * How many complaints one run may produce.
   *
   * A works department that receives two hundred reports in a morning will act
   * on none of them. Escalation is only useful if it arrives at the rate the
   * recipient can absorb, so a run takes the worst few and the rest wait their
   * turn — which is also what an engineer sending these by hand would do.
   */
  maxPerRun: number
}

export const DEFAULT_ESCALATION_RULES: EscalationRules = {
  scoreBelow: 40,
  risk30Above: 0.75,
  minBumpsLast7Days: 8,
  photoCountsAsEvidence: true,
  cooldownDays: 30,
  maxPerRun: 10,
}

export interface EscalationCandidate {
  segment: Segment
  status: SegmentStatus
  approvedPhotos: PhotoReport[]
  /** Most recent escalation for this segment, if any. */
  lastEscalatedAt: string | null
}

export type EscalationDecision =
  { escalate: true; reason: string } | { escalate: false; reason: string }

/** Why a segment is, or is not, worth reporting. The reason is shown to the reviewer. */
export function shouldEscalate(
  candidate: EscalationCandidate,
  rules: EscalationRules = DEFAULT_ESCALATION_RULES,
  now: Date = new Date(),
): EscalationDecision {
  const { segment, status, approvedPhotos, lastEscalatedAt } = candidate

  if (lastEscalatedAt) {
    const days =
      (now.getTime() - new Date(lastEscalatedAt).getTime()) / 86_400_000
    if (days < rules.cooldownDays) {
      return {
        escalate: false,
        reason: `Reported ${Math.floor(days)} days ago; waiting out the ${rules.cooldownDays}-day cooldown.`,
      }
    }
  }

  const badEnough =
    status.score < rules.scoreBelow || status.risk30 > rules.risk30Above
  if (!badEnough) {
    return {
      escalate: false,
      reason: `Score ${status.score.toFixed(0)} and ${Math.round(status.risk30 * 100)}% risk are below the reporting threshold.`,
    }
  }

  const corroborated =
    status.bumpsLast7Days >= rules.minBumpsLast7Days ||
    (rules.photoCountsAsEvidence && approvedPhotos.length > 0)

  if (!corroborated) {
    return {
      escalate: false,
      reason: `Only ${status.bumpsLast7Days} impacts in 7 days and no approved photograph — not enough to report.`,
    }
  }

  const evidence =
    approvedPhotos.length > 0
      ? `${approvedPhotos.length} approved photo report${approvedPhotos.length > 1 ? 's' : ''}`
      : `${status.bumpsLast7Days} impacts in 7 days`

  return {
    escalate: true,
    reason: `Score ${status.score.toFixed(0)}, ${Math.round(status.risk30 * 100)}% risk of failure within 30 days, ${evidence}${segment.nearSensitive ? ', near a school or hospital' : ''}.`,
  }
}

/* ---------------------------------------------------------------------- */
/* The complaint itself                                                    */
/* ---------------------------------------------------------------------- */

/** Roads are owned by different bodies depending on their class. */
export function authorityKindFor(segment: Segment): AuthorityKind {
  if (segment.highway === 'motorway' || segment.highway === 'trunk') {
    return 'national'
  }
  if (segment.highway === 'primary' || segment.highway === 'secondary') {
    return 'state'
  }
  return 'municipal'
}

function formatInr(value: number): string {
  return `Rs ${Math.round(value).toLocaleString('en-IN')}`
}

function mapsUrl(lat: number, lon: number): string {
  return `https://www.google.com/maps?q=${lat.toFixed(6)},${lon.toFixed(6)}`
}

export interface ComplaintInput {
  segment: Segment
  status: SegmentStatus
  authority: Authority
  approvedPhotos: PhotoReport[]
  reference: string
  /** Where the draft can be viewed with its evidence, if the app is reachable. */
  dashboardUrl?: string
}

/**
 * A complaint written for someone who has never heard of this system.
 *
 * Deliberately plain: what road, exactly where, how bad, what evidence exists,
 * and what it is likely to cost. No scores out of a hundred without explaining
 * them, no talk of models or forecasts — a junior engineer at a works
 * department should be able to act on this or forward it without translation.
 */
export function buildComplaint(input: ComplaintInput): {
  subject: string
  body: string
} {
  const { segment, status, authority, approvedPhotos, reference } = input
  const [lon, lat] = segment.center
  const defects = potholesFor(segment, status.score)
  const severe = defects.filter((d) => d.severity === 'severe')
  const worst = defects[0]

  const subject = `Road damage report: ${segment.name} (ref ${reference})`

  const lines: string[] = []

  lines.push(`To: ${authority.name}`)
  lines.push('')
  lines.push('Sir / Madam,')
  lines.push('')
  lines.push(
    `We wish to report damaged road surface on ${segment.name}, a ${segment.roadClass} road under your jurisdiction.`,
  )
  lines.push('')

  lines.push('LOCATION')
  lines.push(`  ${segment.name}`)
  lines.push(`  Latitude ${lat.toFixed(6)}, Longitude ${lon.toFixed(6)}`)
  lines.push(`  Map: ${mapsUrl(lat, lon)}`)
  lines.push(
    `  Affected stretch: approximately ${segment.lengthM.toFixed(0)} metres`,
  )
  if (segment.nearSensitive) {
    lines.push(
      '  NOTE: this stretch lies within 300 metres of a school or hospital.',
    )
  }
  lines.push('')

  lines.push('CONDITION')
  if (worst) {
    lines.push(
      `  ${defects.length} distinct defects identified, of which ${severe.length} are severe.`,
    )
    lines.push(
      `  Largest measures approximately ${worst.depthCm.toFixed(0)} cm deep and ${worst.widthCm} cm across.`,
    )
  }
  lines.push(
    `  ${status.bumpsLast7Days} impacts recorded by passing vehicles in the last seven days.`,
  )
  lines.push(
    `  On present trend this stretch is likely to become impassable within ${status.risk30 > 0.75 ? '30' : '60'} days.`,
  )
  lines.push('')

  if (approvedPhotos.length > 0) {
    lines.push('EVIDENCE')
    for (const photo of approvedPhotos.slice(0, 5)) {
      lines.push(
        `  ${photo.id} — ${photo.label}, ${photo.severity}, reported ${new Date(photo.createdAt).toLocaleDateString('en-IN')} by ${photo.reporter}`,
      )
    }
    lines.push('')
  }

  lines.push('RECOMMENDED ACTION')
  lines.push(
    `  ${status.repairType === 'resurfacing' ? 'Resurfacing' : 'Pothole patching'} of the affected stretch.`,
  )
  lines.push(`  Indicative cost: ${formatInr(status.estimatedCostInr)}.`)
  lines.push('')

  lines.push(
    'We request that this stretch be inspected and taken up for repair at the earliest.',
  )
  lines.push('')

  if (authority.portal) {
    lines.push(
      `A copy of this report may also be filed at: ${authority.portal}`,
    )
    lines.push('')
  }

  if (input.dashboardUrl) {
    lines.push(`Supporting data: ${input.dashboardUrl}`)
    lines.push('')
  }

  lines.push('Yours faithfully,')
  lines.push('InfraPulse road condition monitoring')
  lines.push(`Reference: ${reference}`)
  lines.push('')
  lines.push(
    'This report was prepared from vehicle-mounted sensor readings and citizen photographs, and reviewed by an engineer before sending.',
  )

  return { subject, body: lines.join('\n') }
}

/**
 * A `mailto:` link that opens the reviewer's own mail client with everything
 * filled in.
 *
 * This is how a report actually gets sent today: from a real person's mailbox,
 * where it can be edited first and where the reply goes somewhere a human
 * reads. An automated server sending mail to a government address — with no
 * mailbox behind it and no one watching for the response — would be worse,
 * not more advanced.
 */
export function mailtoLink(escalation: Escalation): string {
  const params = new URLSearchParams({
    subject: escalation.subject,
    body: escalation.body,
  })
  return `mailto:${escalation.authority.email}?${params.toString()}`
}

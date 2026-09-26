import {
  CRITICAL_LINE,
  estimateCostInr,
  forecastFor,
  impactOf,
  riskAt,
} from '@shared/simulate'
import { scoreBand } from '@shared/bands'
import { clamp, linearTrend } from '@shared/stats'
import type {
  DailyScore,
  ForecastPoint,
  Kpis,
  Segment,
  SegmentStatus,
  WorkOrder,
} from '@shared/contract'

/* Scoring belongs on the server.
 *
 * In the mock, a segment's score came from a simulation. Here it is derived
 * from what was actually observed: how many impacts phones reported on that
 * stretch, how rough the trend says it is, and how many photo reports survived
 * review. The client is left to render the number, not to decide it — two
 * dashboards must never disagree about which road is worst.
 */

/** Points lost per impact reported in the trailing window. */
const PENALTY_PER_BUMP = 0.45
/** Points lost per approved photo report. */
const PENALTY_PER_PHOTO = 2.5
/** Impacts above this are treated as one bad event, not many. */
const BUMP_CAP = 60

export interface ScoreInputs {
  /** The score carried forward from yesterday's history. */
  baselineScore: number
  bumpsInWindow: number
  approvedPhotoCount: number
  /** Points already attributed to gradual wear, from the history trend. */
  roughnessPenalty: number
}

export interface ScoredSegment {
  score: number
  bumpPenalty: number
  photoPenalty: number
  roughnessPenalty: number
}

/**
 * Today's score for one segment.
 *
 * The three penalties are kept separate rather than folded together because
 * the drawer shows them as a waterfall — an engineer asked to spend ₹2.5 lakh
 * on resurfacing will want to know whether the number came from impacts,
 * from the long-term trend, or from someone's photograph.
 */
export function scoreSegment(inputs: ScoreInputs): ScoredSegment {
  const bumpPenalty =
    Math.min(inputs.bumpsInWindow, BUMP_CAP) * PENALTY_PER_BUMP
  const photoPenalty = inputs.approvedPhotoCount * PENALTY_PER_PHOTO
  const roughnessPenalty = Math.max(0, inputs.roughnessPenalty)

  const score = clamp(inputs.baselineScore - bumpPenalty - photoPenalty, 0, 100)

  // The waterfall has to reconcile with the score it explains, and the score
  // clamps at zero, so the parts are scaled to the drop that actually happened.
  const drop = 100 - score
  const raw = bumpPenalty + photoPenalty + roughnessPenalty
  const scale = raw > 0 ? drop / raw : 0
  const round = (v: number) => Math.round(v * scale * 10) / 10

  return {
    score: Math.round(score * 10) / 10,
    bumpPenalty: round(bumpPenalty),
    photoPenalty: round(photoPenalty),
    roughnessPenalty: round(roughnessPenalty),
  }
}

export interface StatusInputs {
  segment: Segment
  history: DailyScore[]
  bumpsLast7Days: number
  photoReportCount: number
  approvedPhotoCount: number
}

/** The full status row the dashboard ranks and filters by. */
export function buildStatus(inputs: StatusInputs): SegmentStatus {
  const { segment, history } = inputs
  const recent = history.slice(-30).map((d) => d.score)
  const { slope } = linearTrend(recent)
  const baseline = recent[recent.length - 1] ?? 100

  // Gradual wear is what the trend has already taken out of the score; it is
  // read back from the history rather than tracked separately, so importing a
  // segment's history from elsewhere still produces a sensible breakdown.
  const roughnessPenalty = Math.max(0, 100 - baseline)

  const scored = scoreSegment({
    baselineScore: baseline,
    bumpsInWindow: inputs.bumpsLast7Days,
    approvedPhotoCount: inputs.approvedPhotoCount,
    roughnessPenalty,
  })

  const withToday: DailyScore[] = [
    ...history.slice(0, -1),
    { day: history[history.length - 1]?.day ?? today(), score: scored.score },
  ]

  const risk30 = riskAt(withToday, 30)
  const { costInr, repairType } = estimateCostInr(segment, scored.score)

  return {
    id: segment.id,
    score: scored.score,
    band: scoreBand(scored.score),
    risk30,
    risk60: riskAt(withToday, 60),
    risk90: riskAt(withToday, 90),
    priority: risk30 * impactOf(segment) * (1 + (100 - scored.score) / 100),
    trend30: Math.round(slope * 1000) / 1000,
    estimatedCostInr: costInr,
    repairType,
    breakdown: {
      base: 100,
      bumpPenalty: scored.bumpPenalty,
      roughnessPenalty: scored.roughnessPenalty,
      photoPenalty: scored.photoPenalty,
    },
    bumpsLast7Days: inputs.bumpsLast7Days,
    photoReportCount: inputs.photoReportCount,
  }
}

export function buildForecast(history: DailyScore[]): ForecastPoint[] {
  return forecastFor(history)
}

export function buildKpis(
  statuses: SegmentStatus[],
  histories: Map<number, DailyScore[]>,
  workOrders: WorkOrder[],
  bumpsToday: number,
): Kpis {
  const critical = statuses.filter((s) => s.band === 'critical')
  const watch = statuses.filter((s) => s.band === 'watch')

  const sample = [...histories.values()].filter((_, i) => i % 7 === 0)
  const healthTrend: number[] = []
  const length = sample[0]?.length ?? 0

  for (let d = Math.max(0, length - 30); d < length; d++) {
    const scores = sample.map((h) => h[d]?.score ?? 0)
    healthTrend.push(
      Math.round(
        (scores.reduce((a, b) => a + b, 0) / Math.max(1, scores.length)) * 10,
      ) / 10,
    )
  }

  return {
    cityHealthIndex:
      Math.round(
        (statuses.reduce((a, s) => a + s.score, 0) /
          Math.max(1, statuses.length)) *
          10,
      ) / 10,
    criticalCount: critical.length,
    watchCount: watch.length,
    goodCount: statuses.length - critical.length - watch.length,
    bumpsToday,
    costExposureInr: [...critical, ...watch].reduce(
      (a, s) => a + s.estimatedCostInr,
      0,
    ),
    openWorkOrders: workOrders.filter(
      (w) => w.status === 'open' || w.status === 'in-progress',
    ).length,
    healthTrend,
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

export { CRITICAL_LINE }

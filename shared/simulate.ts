/* Deterministic simulated data.
 *
 * Shared between the browser mock and the server's seed, so both produce
 * byte-identical roads, histories and reports from the same seed. Without that
 * the app would look different depending on which data source it was pointed
 * at, and a bug in one would be invisible in the other.
 *
 * Everything below is a pure function of the segment geometry and the seed, so
 * the demo is identical on every machine and every run. Nothing here calls
 * Date.now() except `today()`, which is quantised to the day.
 */

import seedrandom from 'seedrandom'
import type {
  DailyScore,
  ForecastPoint,
  Kpis,
  PhotoReport,
  PhotoSeverity,
  RoadClass,
  ScoreBreakdown,
  Segment,
  SegmentStatus,
  WorkOrder,
  WorkOrderStatus,
} from './contract'
import { clamp, linearTrend, mean, normalCdf } from './stats'
import { scoreBand } from './bands'
import { PHOTO_BOXES } from './photoBoxes'

export const SEED = 'infrapulse-demo'
export const HISTORY_DAYS = 180
export const FORECAST_DAYS = 90
/** The score at which a road is considered failed. */
export const CRITICAL_LINE = 30

/* Tuned against the target mix in CLAUDE.md 4.3: about 15% critical, about 5%
   watch-and-falling-fast, the rest mostly good. `npm run calibrate` prints the
   achieved mix; the unit tests assert it stays in range. */
const CONFIG = {
  startMin: 72,
  startMax: 100,
  /** Points lost per day on an average local road outside the monsoon. */
  baseDecay: 0.03,
  monsoonMultiplier: 2.5,
  classFactor: { arterial: 1.35, collector: 1.0, local: 0.78 } as Record<
    RoadClass,
    number
  >,
  /* Per-segment susceptibility: drainage, subgrade, build quality. Skewed,
     not uniform — most roads in a district are fine and a minority are much
     worse than average, which is what gives the map its bimodal look instead
     of a wash of amber. */
  vulnerabilityMin: 0.22,
  vulnerabilityRange: 3.4,
  vulnerabilitySkew: 2.2,
  shockChancePerDay: 0.0049,
  shockMin: 10,
  shockMax: 25,
  repairChancePerDay: 0.0055,
  repairBelow: 52,
  noise: 0.45,
}

/** Monsoon months, when decay multiplies (CLAUDE.md 4.3). */
function isMonsoon(date: Date): boolean {
  const m = date.getUTCMonth()
  return m === 6 || m === 7 || m === 8 // Jul, Aug, Sep
}

/** Today at UTC midnight, so the dataset is stable within a day. */
export function today(): Date {
  const now = new Date()
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  )
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000)
}

/* ---------------------------------------------------------------------- */
/* Segments                                                                */
/* ---------------------------------------------------------------------- */

interface RawFeature {
  geometry: { coordinates: [number, number][] }
  properties: {
    id: number
    name: string
    highway: string
    roadClass: RoadClass
    lengthM: number
    nearSensitive: boolean
    busRoute: boolean
  }
}

/**
 * The point half way along a polyline, measured by length.
 *
 * `path[floor(length / 2)]` is not that. For a straight two-point chunk it
 * returns the *end* — which is the next segment's start, so a marker sits on
 * the boundary and an impact there is as close to one segment as the other.
 * PostGIS reports both at 0.00m from such a point. Up to 25m of error on
 * something a crew is dispatched to.
 */
export function midpointOf(path: [number, number][]): [number, number] {
  if (path.length === 0) return [0, 0]
  if (path.length === 1) return path[0]

  const spans: number[] = []
  let total = 0
  for (let i = 1; i < path.length; i++) {
    // Planar is fine over 50 metres; the projection error is millimetres.
    const d = Math.hypot(
      path[i][0] - path[i - 1][0],
      path[i][1] - path[i - 1][1],
    )
    spans.push(d)
    total += d
  }
  if (total === 0) return path[0]

  let remaining = total / 2
  for (let i = 0; i < spans.length; i++) {
    if (remaining <= spans[i]) {
      const t = spans[i] === 0 ? 0 : remaining / spans[i]
      return [
        path[i][0] + (path[i + 1][0] - path[i][0]) * t,
        path[i][1] + (path[i + 1][1] - path[i][1]) * t,
      ]
    }
    remaining -= spans[i]
  }
  return path[path.length - 1]
}

export function segmentsFromGeoJson(json: {
  features: RawFeature[]
}): Segment[] {
  return json.features.map((f) => {
    const path = f.geometry.coordinates
    return {
      id: f.properties.id,
      name: f.properties.name,
      highway: f.properties.highway,
      roadClass: f.properties.roadClass,
      lengthM: f.properties.lengthM,
      nearSensitive: f.properties.nearSensitive,
      busRoute: f.properties.busRoute,
      path,
      center: midpointOf(path),
    }
  })
}

/* ---------------------------------------------------------------------- */
/* History                                                                 */
/* ---------------------------------------------------------------------- */

export interface SegmentSim {
  history: DailyScore[]
  breakdown: ScoreBreakdown
  bumpsLast7Days: number
}

/**
 * 180 days of daily scores for one segment. Seeded per segment id, so a
 * segment's history never depends on how many other segments exist or on the
 * order they were generated in.
 */
export function simulateSegment(segment: Segment): SegmentSim {
  const rng = seedrandom(`${SEED}:segment:${segment.id}`)
  const start = CONFIG.startMin + rng() * (CONFIG.startMax - CONFIG.startMin)
  const vulnerability =
    CONFIG.vulnerabilityMin +
    CONFIG.vulnerabilityRange * rng() ** CONFIG.vulnerabilitySkew
  const classFactor = CONFIG.classFactor[segment.roadClass]

  const end = today()
  const history: DailyScore[] = []

  let score = start
  let bumpPenalty = 0
  let roughnessPenalty = 0

  for (let i = HISTORY_DAYS - 1; i >= 0; i--) {
    const date = addDays(end, -i)

    // Gradual wear: traffic load times susceptibility, doubled in the rains.
    const decay =
      CONFIG.baseDecay *
      classFactor *
      vulnerability *
      (isMonsoon(date) ? CONFIG.monsoonMultiplier : 1)
    score -= decay
    roughnessPenalty += decay

    // A pothole opening up: a step change, not a slope. Susceptibility drives
    // this as well as the gradual wear, so a well-built road stays near its
    // starting score instead of drifting down with everything else.
    if (rng() < CONFIG.shockChancePerDay * vulnerability) {
      const shock =
        CONFIG.shockMin + rng() * (CONFIG.shockMax - CONFIG.shockMin)
      score -= shock
      bumpPenalty += shock
    }

    // Someone actually fixed it.
    if (score < CONFIG.repairBelow && rng() < CONFIG.repairChancePerDay) {
      const repaired = 92 + rng() * 6
      const recovered = repaired - score
      // A repair wipes out accumulated damage rather than adding a credit.
      const share =
        bumpPenalty + roughnessPenalty === 0
          ? 0
          : bumpPenalty / (bumpPenalty + roughnessPenalty)
      bumpPenalty = Math.max(0, bumpPenalty - recovered * share)
      roughnessPenalty = Math.max(0, roughnessPenalty - recovered * (1 - share))
      score = repaired
    }

    score += (rng() - 0.5) * 2 * CONFIG.noise
    score = clamp(score, 0, 100)

    history.push({ day: isoDay(date), score: Math.round(score * 10) / 10 })
  }

  // Worse roads generate more bumps; this is what the live stream weights by.
  const current = history[history.length - 1].score
  const bumpsLast7Days = Math.round(
    (1 - current / 100) ** 2 * 140 * (0.5 + rng()),
  )

  return {
    history,
    breakdown: {
      base: 100,
      bumpPenalty: Math.round(bumpPenalty * 10) / 10,
      roughnessPenalty: Math.round(roughnessPenalty * 10) / 10,
      photoPenalty: 0, // filled in once photo reports are attached
    },
    bumpsLast7Days,
  }
}

/* ---------------------------------------------------------------------- */
/* Forecast                                                                */
/* ---------------------------------------------------------------------- */

export function forecastFor(history: DailyScore[]): ForecastPoint[] {
  const recent = history.slice(-30).map((d) => d.score)
  const { slope, residualStd } = linearTrend(recent)
  const last = recent[recent.length - 1]
  const start = today()

  const points: ForecastPoint[] = []
  for (let offset = 0; offset <= FORECAST_DAYS; offset++) {
    const value = clamp(last + slope * offset, 0, 100)
    // The band widens with the square root of time, like a random walk.
    const sigma = Math.max(1.2, residualStd) * Math.sqrt(1 + offset / 12)
    points.push({
      day: isoDay(addDays(start, offset)),
      offset,
      value: Math.round(value * 10) / 10,
      lower: Math.round(clamp(value - 1.96 * sigma, 0, 100) * 10) / 10,
      upper: Math.round(clamp(value + 1.96 * sigma, 0, 100) * 10) / 10,
    })
  }
  return points
}

/** Probability the score is below the critical line at `offset` days. */
export function riskAt(history: DailyScore[], offset: number): number {
  const recent = history.slice(-30).map((d) => d.score)
  const { slope, residualStd } = linearTrend(recent)
  const last = recent[recent.length - 1]
  const projected = last + slope * offset
  const sigma = Math.max(1.2, residualStd) * Math.sqrt(1 + offset / 12)
  return clamp(normalCdf((CRITICAL_LINE - projected) / sigma), 0, 1)
}

/* ---------------------------------------------------------------------- */
/* Status                                                                  */
/* ---------------------------------------------------------------------- */

const CLASS_WEIGHT: Record<RoadClass, number> = {
  arterial: 3,
  collector: 2,
  local: 1,
}

export function impactOf(segment: Segment): number {
  return (
    CLASS_WEIGHT[segment.roadClass] *
    (segment.nearSensitive ? 1.5 : 1) *
    (segment.busRoute ? 1.3 : 1)
  )
}

export function estimateCostInr(
  segment: Segment,
  score: number,
): { costInr: number; repairType: 'patching' | 'resurfacing' } {
  return score >= 40
    ? { costInr: Math.round(segment.lengthM * 400), repairType: 'patching' }
    : { costInr: Math.round(segment.lengthM * 2500), repairType: 'resurfacing' }
}

/**
 * Makes the waterfall add up.
 *
 * The simulation clamps the running score at 0, so on the worst roads the
 * accumulated penalties can exceed 100 and the breakdown no longer reconciles
 * with the score it is meant to explain — a chart showing "100 − 42.3 − 27.1"
 * beside a score of 0 undermines the whole screen. Scaling the three
 * components to the drop that actually happened keeps their relative sizes,
 * which is what the chart is really communicating, while making the arithmetic
 * check out.
 */
function reconcileBreakdown(
  breakdown: ScoreBreakdown,
  score: number,
): ScoreBreakdown {
  const drop = 100 - score
  const raw =
    breakdown.bumpPenalty + breakdown.roughnessPenalty + breakdown.photoPenalty
  const scale = raw > 0 ? drop / raw : 0
  const round = (v: number) => Math.round(v * scale * 10) / 10

  return {
    base: 100,
    bumpPenalty: round(breakdown.bumpPenalty),
    roughnessPenalty: round(breakdown.roughnessPenalty),
    photoPenalty: round(breakdown.photoPenalty),
  }
}

export function statusFor(
  segment: Segment,
  sim: SegmentSim,
  photoCount: number,
): SegmentStatus {
  const score = sim.history[sim.history.length - 1].score
  const { costInr, repairType } = estimateCostInr(segment, score)
  const risk30 = riskAt(sim.history, 30)
  const recent = sim.history.slice(-30).map((d) => d.score)
  const { slope } = linearTrend(recent)

  return {
    id: segment.id,
    // The mock simulates history for every segment, so all of them are.
    surveyed: true,
    score,
    band: scoreBand(score),
    risk30,
    risk60: riskAt(sim.history, 60),
    risk90: riskAt(sim.history, 90),
    priority: risk30 * impactOf(segment) * (1 + (100 - score) / 100),
    trend30: Math.round(slope * 1000) / 1000,
    estimatedCostInr: costInr,
    repairType,
    breakdown: reconcileBreakdown(
      { ...sim.breakdown, photoPenalty: photoCount * 2.5 },
      score,
    ),
    bumpsLast7Days: sim.bumpsLast7Days,
    photoReportCount: photoCount,
  }
}

/* ---------------------------------------------------------------------- */
/* Photo reports                                                           */
/* ---------------------------------------------------------------------- */

const PHOTO_COUNT = 40
const PHOTO_IMAGES = 8
const LABELS = [
  'pothole',
  'pothole cluster',
  'edge break',
  'alligator cracking',
  'rutting',
  'surface ravelling',
]
const REPORTERS = [
  'A. Sharma',
  'P. Kaur',
  'R. Singh',
  'M. Verma',
  'S. Gill',
  'N. Bansal',
  'H. Dhillon',
  'T. Chopra',
]

function severityFor(score: number, rng: seedrandom.PRNG): PhotoSeverity {
  const roll = rng()
  if (score < 40) return roll < 0.65 ? 'severe' : 'moderate'
  if (score < 70)
    return roll < 0.55 ? 'moderate' : roll < 0.85 ? 'minor' : 'severe'
  return roll < 0.75 ? 'minor' : 'moderate'
}

/** A few percent of wobble, clamped to the frame. */
function jitterBox(
  box: { x: number; y: number; w: number; h: number },
  rng: seedrandom.PRNG,
) {
  const nudge = () => (rng() - 0.5) * 0.03
  const x = Math.max(0, Math.min(0.9, box.x + nudge()))
  const y = Math.max(0, Math.min(0.9, box.y + nudge()))
  return {
    x,
    y,
    w: Math.min(1 - x, box.w + nudge()),
    h: Math.min(1 - y, box.h + nudge()),
  }
}

export function generatePhotoReports(
  segments: Segment[],
  scores: Map<number, number>,
): PhotoReport[] {
  const rng = seedrandom(`${SEED}:photos`)

  // Citizens photograph bad roads, so weight the draw toward low scores.
  const weighted = segments
    .map((s) => ({ s, w: (1 - (scores.get(s.id) ?? 80) / 100) ** 2 + 0.02 }))
    .filter((e) => e.w > 0)
  const total = weighted.reduce((a, e) => a + e.w, 0)

  const pick = (): Segment => {
    let r = rng() * total
    for (const entry of weighted) {
      r -= entry.w
      if (r <= 0) return entry.s
    }
    return weighted[weighted.length - 1].s
  }

  const end = today()
  const reports: PhotoReport[] = []

  for (let i = 0; i < PHOTO_COUNT; i++) {
    const imageIndex = i % PHOTO_IMAGES
    const segment = pick()
    const score = scores.get(segment.id) ?? 80
    const daysAgo = Math.floor(rng() * 21)
    const confidence = Math.round((0.61 + rng() * 0.38) * 100) / 100

    reports.push({
      id: `PR-${String(i + 1).padStart(3, '0')}`,
      segmentId: segment.id,
      segmentName: segment.name,
      imageUrl: `/mock-photos/road-${imageIndex + 1}.svg`,
      label: LABELS[Math.floor(rng() * LABELS.length)],
      confidence,
      // The box tracks the damage actually drawn in that image, nudged a
      // little so forty reports do not share four identical rectangles.
      box: jitterBox(PHOTO_BOXES[imageIndex], rng),
      severity: severityFor(score, rng),
      status: rng() < 0.55 ? 'pending' : rng() < 0.75 ? 'approved' : 'rejected',
      createdAt: addDays(end, -daysAgo).toISOString(),
      reporter: REPORTERS[Math.floor(rng() * REPORTERS.length)],
    })
  }

  return reports.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/* ---------------------------------------------------------------------- */
/* Work orders                                                             */
/* ---------------------------------------------------------------------- */

const CREW = ['Crew A', 'Crew B', 'Crew C', 'PWD Zone 2', 'Contractor NHK']
const SEED_STATUSES: WorkOrderStatus[] = [
  'open',
  'open',
  'open',
  'in-progress',
  'in-progress',
  'in-progress',
  'repaired',
  'repaired',
  'verified',
  'verified',
  'verified',
  'reopened',
]

export function generateWorkOrders(
  segments: Segment[],
  statuses: SegmentStatus[],
): WorkOrder[] {
  const rng = seedrandom(`${SEED}:work-orders`)
  const byId = new Map(segments.map((s) => [s.id, s]))
  const worst = [...statuses]
    .sort((a, b) => b.priority - a.priority)
    .slice(0, SEED_STATUSES.length * 3)

  const end = today()
  const orders: WorkOrder[] = []

  SEED_STATUSES.forEach((status, i) => {
    const target = worst[Math.floor(rng() * worst.length)] ?? worst[i]
    const segment = byId.get(target.id)
    if (!segment) return

    const createdDaysAgo = 3 + Math.floor(rng() * 40)
    const bumpRateBefore = Math.round((6 + rng() * 22) * 10) / 10

    orders.push({
      id: `WO-${String(i + 1).padStart(3, '0')}`,
      segmentId: segment.id,
      segmentName: segment.name,
      status,
      assignee: CREW[Math.floor(rng() * CREW.length)],
      costInr: target.estimatedCostInr,
      repairType: target.repairType,
      createdAt: addDays(end, -createdDaysAgo).toISOString(),
      updatedAt: addDays(
        end,
        -Math.floor(rng() * createdDaysAgo),
      ).toISOString(),
      bumpRateBefore,
      bumpRateAfter:
        status === 'verified'
          ? Math.round(bumpRateBefore * (0.08 + rng() * 0.2) * 10) / 10
          : undefined,
    })
  })

  return orders
}

/* ---------------------------------------------------------------------- */
/* KPIs                                                                    */
/* ---------------------------------------------------------------------- */

export function computeKpis(
  statuses: SegmentStatus[],
  histories: Map<number, DailyScore[]>,
  workOrders: WorkOrder[],
  bumpsToday: number,
): Kpis {
  const critical = statuses.filter((s) => s.surveyed && s.band === 'critical')
  const watch = statuses.filter((s) => s.surveyed && s.band === 'watch')

  // A sample keeps the sparkline cheap on 1100 segments without biasing it.
  const sample = [...histories.values()].filter((_, i) => i % 7 === 0)
  const healthTrend: number[] = []
  for (let d = HISTORY_DAYS - 30; d < HISTORY_DAYS; d++) {
    healthTrend.push(
      Math.round(mean(sample.map((h) => h[d]?.score ?? 0)) * 10) / 10,
    )
  }

  const surveyed = statuses.filter((s) => s.surveyed)

  return {
    cityHealthIndex:
      Math.round(mean(surveyed.map((s) => s.score)) * 10) / 10 || 0,
    criticalCount: critical.length,
    watchCount: watch.length,
    goodCount: surveyed.length - critical.length - watch.length,
    unsurveyedCount: statuses.length - surveyed.length,
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

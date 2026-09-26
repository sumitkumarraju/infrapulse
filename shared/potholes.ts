import seedrandom from 'seedrandom'
import type { Segment } from './contract'

/* Individual defects along a segment.
 *
 * A 50m segment's score says how bad that stretch is; it does not say where on
 * it the damage sits. The map needs that: an engineer sending a crew wants a
 * position, not an average, and a score of 31 drawn as a uniformly red line is
 * less informative than the same line with four holes marked on it.
 *
 * These are derived from the score rather than stored, which keeps them
 * consistent with everything else on screen and means no extra round trip. When
 * the backend starts clustering real impact positions, `potholesFor` is the
 * function that gets replaced — the map does not care where the points came
 * from. Until then they are honest about being derived: the UI labels them
 * "modelled", not "surveyed".
 */

export type PotholeSeverity = 'minor' | 'moderate' | 'severe'

export interface Pothole {
  id: string
  segmentId: number
  /** [lon, lat] somewhere along the segment's own polyline. */
  position: [number, number]
  /** Estimated depth in centimetres. */
  depthCm: number
  /** Rough diameter in centimetres. */
  widthCm: number
  severity: PotholeSeverity
}

/** Nothing is drawn above this score: a good road has no marked defects. */
const CLEAN_ABOVE = 72

function severityOf(depthCm: number): PotholeSeverity {
  if (depthCm >= 12) return 'severe'
  if (depthCm >= 6) return 'moderate'
  return 'minor'
}

/** Walks the polyline and returns the point at `t` (0-1) of its total length. */
function pointAlong(path: [number, number][], t: number): [number, number] {
  if (path.length === 1) return path[0]

  const lengths: number[] = []
  let total = 0
  for (let i = 1; i < path.length; i++) {
    const d = Math.hypot(
      path[i][0] - path[i - 1][0],
      path[i][1] - path[i - 1][1],
    )
    lengths.push(d)
    total += d
  }
  if (total === 0) return path[0]

  let travelled = t * total
  for (let i = 0; i < lengths.length; i++) {
    if (travelled <= lengths[i]) {
      const f = lengths[i] === 0 ? 0 : travelled / lengths[i]
      return [
        path[i][0] + (path[i + 1][0] - path[i][0]) * f,
        path[i][1] + (path[i + 1][1] - path[i][1]) * f,
      ]
    }
    travelled -= lengths[i]
  }

  return path[path.length - 1]
}

/**
 * The defects on one segment, worst first.
 *
 * Deterministic per segment id, so a pothole does not move between renders,
 * between screens, or between machines.
 */
export function potholesFor(segment: Segment, score: number): Pothole[] {
  if (score >= CLEAN_ABOVE) return []

  const rng = seedrandom(`infrapulse-demo:potholes:${segment.id}`)
  const damage = 1 - score / 100

  // Quadratic rather than linear: a road at 60 has the odd hole, a road at 20
  // is broken up along its whole length.
  const count = Math.max(1, Math.round(damage ** 2 * 16))

  const potholes: Pothole[] = []
  for (let i = 0; i < count; i++) {
    // Spread along the segment with jitter, so they do not sit on a grid.
    const t = (i + 0.5) / count + (rng() - 0.5) * (0.8 / count)
    const depthCm = Math.round((2 + damage * 16 * (0.5 + rng())) * 10) / 10

    potholes.push({
      id: `PH-${segment.id}-${i}`,
      segmentId: segment.id,
      position: pointAlong(segment.path, Math.max(0, Math.min(1, t))),
      depthCm,
      widthCm: Math.round(depthCm * (4 + rng() * 6)),
      severity: severityOf(depthCm),
    })
  }

  return potholes.sort((a, b) => b.depthCm - a.depthCm)
}

/** The one a crew would be sent to first. */
export function worstPothole(segment: Segment, score: number): Pothole | null {
  return potholesFor(segment, score)[0] ?? null
}

/** Severe defects only — what the map marks and labels at a distance. */
export function majorPotholes(segment: Segment, score: number): Pothole[] {
  return potholesFor(segment, score).filter((p) => p.severity === 'severe')
}

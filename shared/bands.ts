/* Health bands — the one place a score becomes a category.
 *
 * Lives in shared/ because the server ranks and filters by band while the
 * client colours by it, and a threshold that disagreed between the two would
 * show up as a map that contradicts its own list.
 */

import type { HealthBand } from './contract'

/** Good >= 70, watch 40-69, critical < 40. */
export const BAND_THRESHOLDS = { good: 70, watch: 40 } as const

export function scoreBand(score: number): HealthBand {
  if (score >= BAND_THRESHOLDS.good) return 'good'
  if (score >= BAND_THRESHOLDS.watch) return 'watch'
  return 'critical'
}

export const BAND_LABEL: Record<HealthBand, string> = {
  good: 'Good',
  watch: 'Watch',
  critical: 'Critical',
}

/** Stroke width in px, so colour is never the only signal (UI_DESIGN 1.4). */
export const BAND_WIDTH: Record<HealthBand, number> = {
  good: 3,
  watch: 4,
  critical: 5,
}

export const BAND_GLOW: Record<HealthBand, number> = {
  good: 0.35,
  watch: 0.55,
  critical: 0.8,
}

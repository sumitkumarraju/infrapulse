/* The bump detector, as a pure state machine.
 *
 * This lives outside React on purpose. The thresholds below are educated
 * guesses until someone drives a real road with a real phone, and the only way
 * to turn a guess into a calibrated number is to record the raw sensor stream
 * once and then replay it through many different settings. That is impossible
 * if the algorithm is welded to a component's lifecycle — hence a class that
 * takes samples in and gives decisions out, used identically by the phone
 * (src/features/driver/sensors/useBumpDetection.ts) and by the offline tuner
 * (scripts/replay-trace.ts).
 */

export interface DetectorConfig {
  /**
   * Low-pass coefficient for the gravity estimate, per sample.
   *
   * Higher is slower. At 60Hz, 0.85 is roughly a 2.6Hz cutoff, which is fast
   * for a gravity estimator — the usual range is 0.2–0.5Hz (about 0.98–0.995
   * at this rate). Too fast and the "gravity" estimate starts tracking the
   * road itself and cancels the signal being measured. This is the first
   * number to check against a real trace.
   */
  gravityAlpha: number
  /** Rolling window for the adaptive threshold, in samples. 120 ≈ 2s at 60Hz. */
  windowSamples: number
  /** Floor, m/s². Stops a smooth road's tiny sigma making everything a pothole. */
  absoluteFloorMs2: number
  /** Adaptive term. Stops a rough road firing continuously. */
  sigmaMultiplier: number
  /** Below this, a phone being picked up looks exactly like a pothole. */
  minSpeedMs: number
  /** One hole should be one bump. */
  cooldownMs: number
}

export const DEFAULT_DETECTOR_CONFIG: DetectorConfig = {
  gravityAlpha: 0.85,
  windowSamples: 120,
  absoluteFloorMs2: 6,
  sigmaMultiplier: 4,
  minSpeedMs: 3,
  cooldownMs: 1500,
}

/** One accelerometer reading, exactly as the phone reported it. */
export interface RawSample {
  /** Epoch milliseconds. */
  t: number
  /** accelerationIncludingGravity, m/s². Raw axes — not yet oriented. */
  x: number
  y: number
  z: number
  /** From the most recent GPS fix, which may lag the reading. */
  speedMs: number | null
  lat: number | null
  lon: number | null
}

export interface DetectedImpact {
  at: number
  /** Vertical acceleration at the spike, m/s². */
  magnitude: number
  lat: number | null
  lon: number | null
  speedMs: number
}

export interface DetectorStep {
  /** Vertical acceleration for this sample, gravity removed. */
  vertical: number
  /** What it would have had to exceed. */
  threshold: number
  /** Non-null on the sample that triggered. */
  impact: DetectedImpact | null
  /** Why a spike was ignored, when one was. */
  suppressed: 'slow' | 'cooldown' | null
}

export class BumpDetector {
  private gravity = { x: 0, y: 0, z: 9.81 }
  private window: number[] = []
  private lastImpactAt = 0
  private primed = false

  readonly config: DetectorConfig

  constructor(config: DetectorConfig = DEFAULT_DETECTOR_CONFIG) {
    this.config = config
  }

  reset(): void {
    this.gravity = { x: 0, y: 0, z: 9.81 }
    this.window = []
    this.lastImpactAt = 0
    this.primed = false
  }

  push(sample: RawSample): DetectorStep {
    const { gravityAlpha, windowSamples } = this.config

    // Seed the filter from the first reading rather than letting it converge
    // from a guessed 1g on the z axis, which produces a false spike at the
    // start of every trip — the phone is rarely lying flat.
    if (!this.primed) {
      this.gravity = { x: sample.x, y: sample.y, z: sample.z }
      this.primed = true
    } else {
      this.gravity = {
        x: gravityAlpha * this.gravity.x + (1 - gravityAlpha) * sample.x,
        y: gravityAlpha * this.gravity.y + (1 - gravityAlpha) * sample.y,
        z: gravityAlpha * this.gravity.z + (1 - gravityAlpha) * sample.z,
      }
    }

    const g = this.gravity
    const gMagnitude = Math.hypot(g.x, g.y, g.z) || 9.81

    // Project the reading onto gravity and take gravity back out. What remains
    // is movement along the vertical, whatever angle the phone is mounted at.
    const vertical =
      (sample.x * g.x + sample.y * g.y + sample.z * g.z) / gMagnitude -
      gMagnitude

    this.window.push(vertical)
    if (this.window.length > windowSamples) this.window.shift()

    const threshold = this.threshold()
    const speedMs = sample.speedMs ?? 0

    let impact: DetectedImpact | null = null
    let suppressed: DetectorStep['suppressed'] = null

    if (Math.abs(vertical) > threshold) {
      if (speedMs < this.config.minSpeedMs) {
        suppressed = 'slow'
      } else if (sample.t - this.lastImpactAt <= this.config.cooldownMs) {
        suppressed = 'cooldown'
      } else {
        this.lastImpactAt = sample.t
        impact = {
          at: sample.t,
          magnitude: Math.abs(vertical),
          lat: sample.lat,
          lon: sample.lon,
          speedMs,
        }
      }
    }

    return { vertical, threshold, impact, suppressed }
  }

  private threshold(): number {
    const w = this.window
    if (w.length === 0) return this.config.absoluteFloorMs2

    const mean = w.reduce((a, b) => a + b, 0) / w.length
    const variance =
      w.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, w.length - 1)

    return Math.max(
      this.config.absoluteFloorMs2,
      mean + this.config.sigmaMultiplier * Math.sqrt(variance),
    )
  }
}

/* ---------------------------------------------------------------------- */
/* Trace files                                                             */
/* ---------------------------------------------------------------------- */

export const TRACE_VERSION = 1

/**
 * A recorded drive: raw samples, plus whatever the driver marked by hand.
 *
 * The markers are the point. Without ground truth a replay can only say how
 * many impacts a setting reported, never whether they were the right ones.
 */
export interface Trace {
  version: number
  recordedAt: string
  /** The settings the detector was actually running while recording. */
  config: DetectorConfig
  device: {
    userAgent: string
    /** Measured, not assumed — phones vary and throttle. */
    sampleRateHz: number
  }
  samples: RawSample[]
  /** Epoch milliseconds when the driver said "that was a pothole". */
  markers: { at: number; note?: string }[]
  notes?: string
}

export interface ReplayResult {
  config: DetectorConfig
  impacts: DetectedImpact[]
  /** Only meaningful when the trace carries markers. */
  scored: {
    markers: number
    matched: number
    missed: number
    falsePositives: number
    precision: number
    recall: number
  } | null
}

/** How far apart a marker and a detection may be and still be the same event. */
export const MATCH_WINDOW_MS = 2500

/** Runs a trace through the detector and, if it has markers, scores it. */
export function replayTrace(
  trace: Trace,
  config: DetectorConfig = DEFAULT_DETECTOR_CONFIG,
): ReplayResult {
  const detector = new BumpDetector(config)
  const impacts: DetectedImpact[] = []

  for (const sample of trace.samples) {
    const step = detector.push(sample)
    if (step.impact) impacts.push(step.impact)
  }

  if (trace.markers.length === 0) {
    return { config, impacts, scored: null }
  }

  // Greedy nearest match, one detection per marker. A driver's tap lands a
  // moment after the jolt, so the window is generous on both sides.
  const unused = new Set(impacts.map((_, i) => i))
  let matched = 0

  for (const marker of trace.markers) {
    let bestIndex = -1
    let bestGap = Infinity

    for (const index of unused) {
      const gap = Math.abs(impacts[index].at - marker.at)
      if (gap < bestGap && gap <= MATCH_WINDOW_MS) {
        bestGap = gap
        bestIndex = index
      }
    }

    if (bestIndex >= 0) {
      unused.delete(bestIndex)
      matched++
    }
  }

  const falsePositives = unused.size
  const missed = trace.markers.length - matched

  return {
    config,
    impacts,
    scored: {
      markers: trace.markers.length,
      matched,
      missed,
      falsePositives,
      precision: impacts.length === 0 ? 0 : matched / impacts.length,
      recall: trace.markers.length === 0 ? 0 : matched / trace.markers.length,
    },
  }
}

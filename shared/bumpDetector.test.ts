import { describe, expect, it } from 'vitest'
import { midpointOf } from '@shared/simulate'
import {
  BumpDetector,
  DEFAULT_DETECTOR_CONFIG,
  replayTrace,
  TRACE_VERSION,
  type DetectorConfig,
  type RawSample,
  type Trace,
} from '@shared/bumpDetector'

const HZ = 60

/** Rotates a reading so it looks like it came from a differently angled phone. */
function tilt(
  sample: { x: number; y: number; z: number },
  radians: number,
): { x: number; y: number; z: number } {
  // Rotation about the x axis: what a phone propped up in a cradle sees.
  return {
    x: sample.x,
    y: sample.y * Math.cos(radians) - sample.z * Math.sin(radians),
    z: sample.y * Math.sin(radians) + sample.z * Math.cos(radians),
  }
}

/**
 * A synthetic drive. `jolts` are offsets in seconds from the start, each a
 * short decaying spike on top of road noise.
 */
function drive(options: {
  seconds: number
  jolts: { at: number; amplitude: number }[]
  noise?: number
  speedMs?: number
  tiltRadians?: number
  start?: number
}): RawSample[] {
  const {
    seconds,
    jolts,
    noise = 1.2,
    speedMs = 11,
    tiltRadians = 0,
    start = 1_700_000_000_000,
  } = options

  const samples: RawSample[] = []
  // Deterministic pseudo-noise: a test that fails one run in twenty is worse
  // than no test.
  let seed = 42
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648 - 0.5
  }

  for (let n = 0; n < seconds * HZ; n++) {
    const t = start + (n / HZ) * 1000

    let jolt = 0
    for (const spike of jolts) {
      const dt = t - (start + spike.at * 1000)
      if (dt >= 0 && dt < 90) {
        jolt += spike.amplitude * Math.exp(-dt / 30) * Math.cos(dt / 12)
      }
    }

    const flat = {
      x: rand() * noise * 0.4,
      y: rand() * noise * 0.4,
      z: 9.81 + rand() * noise + jolt,
    }
    const oriented = tilt(flat, tiltRadians)

    samples.push({
      t,
      ...oriented,
      speedMs,
      lat: 30.768,
      lon: 76.575,
    })
  }

  return samples
}

function run(
  samples: RawSample[],
  config: DetectorConfig = DEFAULT_DETECTOR_CONFIG,
) {
  const detector = new BumpDetector(config)
  return samples.map((s) => detector.push(s)).filter((step) => step.impact)
}

describe('orientation independence', () => {
  it('reads near zero vertical acceleration on a still, level phone', () => {
    const detector = new BumpDetector()
    const samples = drive({ seconds: 3, jolts: [], noise: 0.05, speedMs: 0 })
    const last = samples.slice(-30).map((s) => detector.push(s).vertical)

    for (const vertical of last) expect(Math.abs(vertical)).toBeLessThan(0.5)
  })

  it('reads near zero on a phone propped at an angle', () => {
    // The whole reason for projecting onto gravity: a cradled phone must not
    // report a permanent 5 m/s² because of how it is mounted.
    const detector = new BumpDetector()
    const samples = drive({
      seconds: 3,
      jolts: [],
      noise: 0.05,
      speedMs: 0,
      tiltRadians: Math.PI / 4,
    })
    const last = samples.slice(-30).map((s) => detector.push(s).vertical)

    for (const vertical of last) expect(Math.abs(vertical)).toBeLessThan(0.5)
  })

  it('finds the same pothole whatever angle the phone is at', () => {
    const jolts = [{ at: 2, amplitude: 14 }]
    const flat = run(drive({ seconds: 4, jolts }))
    const angled = run(drive({ seconds: 4, jolts, tiltRadians: Math.PI / 3 }))

    expect(flat).toHaveLength(1)
    expect(angled).toHaveLength(1)
  })
})

describe('what counts as an impact', () => {
  it('reports a clear jolt', () => {
    const impacts = run(
      drive({ seconds: 4, jolts: [{ at: 2, amplitude: 14 }] }),
    )
    expect(impacts).toHaveLength(1)
    expect(impacts[0].impact!.magnitude).toBeGreaterThan(6)
  })

  it('stays quiet on a smooth road', () => {
    expect(run(drive({ seconds: 10, jolts: [], noise: 0.8 }))).toHaveLength(0)
  })

  it('ignores everything below walking pace', () => {
    // A phone being picked up out of a cupholder looks exactly like a pothole.
    const impacts = run(
      drive({ seconds: 4, jolts: [{ at: 2, amplitude: 20 }], speedMs: 0.5 }),
    )
    expect(impacts).toHaveLength(0)
  })

  it('counts one hole once, not once per sample', () => {
    const impacts = run(
      drive({ seconds: 4, jolts: [{ at: 2, amplitude: 25 }] }),
    )
    expect(impacts).toHaveLength(1)
  })

  it('separates two holes further apart than the cooldown', () => {
    const impacts = run(
      drive({
        seconds: 8,
        jolts: [
          { at: 2, amplitude: 14 },
          { at: 5, amplitude: 14 },
        ],
      }),
    )
    expect(impacts).toHaveLength(2)
  })

  it('merges two holes closer together than the cooldown', () => {
    // A deliberate limitation: 1.5s at 50km/h is 20m, so closely spaced
    // damage reads as one event. Worth knowing rather than discovering.
    const impacts = run(
      drive({
        seconds: 6,
        jolts: [
          { at: 2, amplitude: 14 },
          { at: 2.5, amplitude: 14 },
        ],
      }),
    )
    expect(impacts).toHaveLength(1)
  })

  it('does not fire on the first sample of a trip', () => {
    // The filter is seeded from the first reading rather than converging from
    // an assumed 1g on z, which would spike on any phone not lying flat.
    const detector = new BumpDetector()
    const samples = drive({
      seconds: 1,
      jolts: [],
      noise: 0.05,
      tiltRadians: Math.PI / 2,
    })
    expect(detector.push(samples[0]).impact).toBeNull()
  })
})

describe('replaying a recorded drive', () => {
  function traceOf(samples: RawSample[], markerOffsets: number[]): Trace {
    const start = samples[0].t
    return {
      version: TRACE_VERSION,
      recordedAt: new Date(start).toISOString(),
      config: DEFAULT_DETECTOR_CONFIG,
      device: { userAgent: 'test', sampleRateHz: HZ },
      samples,
      // The driver taps a little after the jolt.
      markers: markerOffsets.map((at) => ({ at: start + at * 1000 + 500 })),
    }
  }

  it('scores detections against what the driver marked', () => {
    const jolts = [
      { at: 2, amplitude: 14 },
      { at: 6, amplitude: 14 },
      { at: 10, amplitude: 14 },
    ]
    const trace = traceOf(drive({ seconds: 13, jolts }), [2, 6, 10])
    const { scored } = replayTrace(trace)

    expect(scored).not.toBeNull()
    expect(scored!.matched).toBe(3)
    expect(scored!.missed).toBe(0)
    expect(scored!.falsePositives).toBe(0)
    expect(scored!.recall).toBe(1)
  })

  it('counts a pothole the driver did not mark as a false positive', () => {
    const jolts = [
      { at: 2, amplitude: 14 },
      { at: 6, amplitude: 14 },
    ]
    const trace = traceOf(drive({ seconds: 9, jolts }), [2])
    const { scored } = replayTrace(trace)

    expect(scored!.matched).toBe(1)
    expect(scored!.falsePositives).toBe(1)
  })

  it('counts a marked pothole that was not detected as missed', () => {
    const trace = traceOf(drive({ seconds: 9, jolts: [] }), [2, 6])
    const { scored } = replayTrace(trace)

    expect(scored!.matched).toBe(0)
    expect(scored!.missed).toBe(2)
    expect(scored!.recall).toBe(0)
  })

  it('reports nothing to score when the drive has no markers', () => {
    const trace = traceOf(drive({ seconds: 5, jolts: [] }), [])
    expect(replayTrace(trace).scored).toBeNull()
  })

  it('gives different settings different results', () => {
    // If this ever stops being true the sweep is pointless.
    const samples = drive({
      seconds: 20,
      jolts: [
        { at: 2, amplitude: 16 },
        { at: 6, amplitude: 7 },
        { at: 10, amplitude: 4.5 },
        { at: 14, amplitude: 3.5 },
      ],
      noise: 2.4,
    })
    const trace = traceOf(samples, [2, 6, 10, 14])

    const strict = replayTrace(trace, {
      ...DEFAULT_DETECTOR_CONFIG,
      absoluteFloorMs2: 10,
    })
    const lenient = replayTrace(trace, {
      ...DEFAULT_DETECTOR_CONFIG,
      absoluteFloorMs2: 3,
      sigmaMultiplier: 2.5,
    })

    expect(lenient.impacts.length).toBeGreaterThan(strict.impacts.length)
  })
})

describe('segment midpoints', () => {
  it('returns the point half way along, not the last vertex', () => {
    // The bug this replaced: path[floor(length / 2)] on a two-point line is
    // its end, which is the next segment's start — so a marker sat on the
    // boundary and an impact there matched either neighbour.
    expect(
      midpointOf([
        [0, 0],
        [10, 0],
      ]),
    ).toEqual([5, 0])
  })

  it('measures by length, not by vertex count', () => {
    // Three vertices, but nearly all the length is in the first span.
    const [x] = midpointOf([
      [0, 0],
      [100, 0],
      [101, 0],
    ])
    expect(x).toBeCloseTo(50.5, 5)
  })

  it('survives degenerate geometry', () => {
    expect(midpointOf([])).toEqual([0, 0])
    expect(midpointOf([[3, 4]])).toEqual([3, 4])
    expect(
      midpointOf([
        [3, 4],
        [3, 4],
      ]),
    ).toEqual([3, 4])
  })
})

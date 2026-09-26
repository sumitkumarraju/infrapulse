/* Replays a recorded drive through the detector, at many settings.
 *
 * The thresholds in shared/bumpDetector.ts are educated guesses. This turns one
 * real drive into as many experiments as you like: record once with "I felt
 * that one" tapped at each pothole, then sweep the parameters here and read off
 * which settings actually found them.
 *
 *   npm run replay -- path/to/trace.json            # current settings
 *   npm run replay -- path/to/trace.json --sweep    # search for better ones
 *
 * Precision is how many of the reported impacts were real; recall is how many
 * of the real ones were reported. Recall matters more here — a missed pothole
 * is invisible, while a false positive is diluted by every other driver who
 * did not report one at that spot.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  DEFAULT_DETECTOR_CONFIG,
  replayTrace,
  type DetectorConfig,
  type Trace,
} from '../shared/bumpDetector'

function load(path: string): Trace {
  const trace = JSON.parse(readFileSync(resolve(path), 'utf-8')) as Trace

  if (!trace.samples || trace.samples.length === 0) {
    throw new Error('That trace has no samples in it.')
  }

  return trace
}

function describe(trace: Trace): void {
  const seconds =
    (trace.samples[trace.samples.length - 1].t - trace.samples[0].t) / 1000
  const withGps = trace.samples.filter((s) => s.lat !== null).length

  console.log('Trace')
  console.log(`  recorded    ${trace.recordedAt}`)
  console.log(`  duration    ${(seconds / 60).toFixed(1)} min`)
  console.log(
    `  samples     ${trace.samples.length} at ${trace.device.sampleRateHz}Hz`,
  )
  console.log(
    `  gps         ${withGps} of ${trace.samples.length} samples had a fix`,
  )
  console.log(`  marked      ${trace.markers.length} potholes`)
  console.log(`  device      ${trace.device.userAgent}`)
  if (trace.notes) console.log(`  notes       ${trace.notes}`)
  console.log()

  if (trace.markers.length === 0) {
    console.log(
      'No markers in this trace, so nothing can be scored — only counted.',
    )
    console.log(
      'Next drive, tap "I felt that one" at each pothole to get ground truth.',
    )
    console.log()
  }

  if (trace.device.sampleRateHz < 40) {
    console.log(
      `WARNING: ${trace.device.sampleRateHz}Hz is low. A pothole impact lasts`,
    )
    console.log(
      '  50-100ms, so this may be only 2-4 samples per hit. Detection will be',
    )
    console.log('  unreliable regardless of thresholds.')
    console.log()
  }
}

function report(label: string, config: DetectorConfig, trace: Trace): void {
  const { impacts, scored } = replayTrace(trace, config)

  if (!scored) {
    console.log(`${label.padEnd(34)} ${impacts.length} impacts`)
    return
  }

  console.log(
    `${label.padEnd(34)} ${String(impacts.length).padStart(3)} found  ` +
      `${String(scored.matched).padStart(3)} correct  ` +
      `${String(scored.missed).padStart(3)} missed  ` +
      `${String(scored.falsePositives).padStart(3)} false  ` +
      `recall ${(scored.recall * 100).toFixed(0).padStart(3)}%  ` +
      `precision ${(scored.precision * 100).toFixed(0).padStart(3)}%`,
  )
}

/** A coarse grid. Wide enough to show the shape, small enough to read. */
function sweep(trace: Trace): void {
  console.log('Sweeping. Each row is one setting.\n')

  const alphas = [0.85, 0.95, 0.98, 0.99]
  const floors = [3, 4.5, 6, 8]
  const sigmas = [2.5, 3, 4, 5]

  console.log('--- gravity filter (alpha) ---')
  for (const gravityAlpha of alphas) {
    report(
      `alpha ${gravityAlpha}`,
      { ...DEFAULT_DETECTOR_CONFIG, gravityAlpha },
      trace,
    )
  }

  console.log('\n--- absolute floor (m/s2) ---')
  for (const absoluteFloorMs2 of floors) {
    report(
      `floor ${absoluteFloorMs2}`,
      { ...DEFAULT_DETECTOR_CONFIG, absoluteFloorMs2 },
      trace,
    )
  }

  console.log('\n--- adaptive term (sigma) ---')
  for (const sigmaMultiplier of sigmas) {
    report(
      `sigma ${sigmaMultiplier}`,
      { ...DEFAULT_DETECTOR_CONFIG, sigmaMultiplier },
      trace,
    )
  }

  if (trace.markers.length === 0) return

  console.log('\n--- best combination by recall, then precision ---')
  let best: {
    config: DetectorConfig
    recall: number
    precision: number
  } | null = null

  for (const gravityAlpha of alphas) {
    for (const absoluteFloorMs2 of floors) {
      for (const sigmaMultiplier of sigmas) {
        const config = {
          ...DEFAULT_DETECTOR_CONFIG,
          gravityAlpha,
          absoluteFloorMs2,
          sigmaMultiplier,
        }
        const { scored } = replayTrace(trace, config)
        if (!scored) continue

        if (
          !best ||
          scored.recall > best.recall ||
          (scored.recall === best.recall && scored.precision > best.precision)
        ) {
          best = {
            config,
            recall: scored.recall,
            precision: scored.precision,
          }
        }
      }
    }
  }

  if (best) {
    console.log(
      `  gravityAlpha: ${best.config.gravityAlpha}, ` +
        `absoluteFloorMs2: ${best.config.absoluteFloorMs2}, ` +
        `sigmaMultiplier: ${best.config.sigmaMultiplier}`,
    )
    console.log(
      `  recall ${(best.recall * 100).toFixed(0)}%, precision ${(best.precision * 100).toFixed(0)}%`,
    )
    console.log()
    console.log(
      'One drive is one road, one car and one mount. Treat this as a starting',
    )
    console.log(
      'point, not a final answer — and do not tune to a single trace.',
    )
  }
}

function main(): void {
  const args = process.argv.slice(2)
  const path = args.find((a) => !a.startsWith('--'))

  if (!path) {
    console.error('Usage: npm run replay -- <trace.json> [--sweep]')
    process.exit(1)
  }

  const trace = load(path)
  describe(trace)

  console.log('--- as recorded ---')
  report('recorded settings', trace.config, trace)
  report('current defaults', DEFAULT_DETECTOR_CONFIG, trace)
  console.log()

  if (args.includes('--sweep')) sweep(trace)
}

main()

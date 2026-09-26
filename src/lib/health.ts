/* Road-health colour and banding — UI_DESIGN.md section 1.4.
   The single place a score becomes a colour. Map layers, badges, charts and
   the 3D towers all read from here, so the ramp can never drift between them.

   Interpolation happens in Oklab rather than sRGB: a straight sRGB lerp from
   red to green passes through a muddy brown, which is exactly the range where
   an engineer has to tell "watch" from "about to fail". */

export type { HealthBand } from '@shared/contract'
export {
  BAND_GLOW,
  BAND_LABEL,
  BAND_THRESHOLDS,
  BAND_WIDTH,
  scoreBand,
} from '@shared/bands'

import type { HealthBand } from '@shared/contract'

export interface Rgb {
  r: number
  g: number
  b: number
}

export const BAND_COLOR: Record<HealthBand, string> = {
  good: '#6EE7B7',
  watch: '#FBBF24',
  critical: '#F43F5E',
}

/**
 * The continuous ramp, score 0 to 100, defined in Oklch rather than as hex
 * stops.
 *
 * Hand-picked hex stops cannot keep the promise in UI_DESIGN 1.4 that the ramp
 * still ranks in greyscale: saturated amber is intrinsically lighter than a mid
 * green, so a crimson → red → amber → lime → green ramp peaks in lightness
 * around score 80 and then falls, leaving score 100 the same grey as score 55.
 * Specifying lightness directly and letting hue rotate makes the ramp monotonic
 * by construction, which is the property the accessibility check depends on.
 *
 * Two constraints pull against each other. Lightness must rise monotonically
 * with the score, or two different bands render as the same grey — score 55 and
 * score 100 collided at #bbb in the first version of this ramp. But sRGB cannot
 * give a vivid red that is also light, so the ramp cannot simply be reversed
 * either.
 *
 * What resolves it is dropping the lime stop and lightening the good end:
 * emerald #6EE7B7 is lighter than amber #FBBF24, so crimson → red → orange →
 * amber → emerald climbs the whole way while every stop stays saturated.
 */
const RAMP: ReadonlyArray<readonly [number, string]> = [
  [0, '#B4123C'], // deep crimson
  [25, '#F43F5E'], // critical red
  [45, '#FB923C'], // orange — the "about to fail" zone
  [65, '#FBBF24'], // amber — watch
  [100, '#6EE7B7'], // good — emerald, the lightest stop
]

export function hexToRgb(hex: string): Rgb {
  const h = hex.replace('#', '')
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  }
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const to = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, '0')
  return `#${to(r)}${to(g)}${to(b)}`
}

/* --- sRGB <-> Oklab (Björn Ottosson's formulation) --------------------- */

function srgbToLinear(c: number): number {
  const v = c / 255
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}

function linearToSrgb(v: number): number {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055
  return c * 255
}

function rgbToOklab({ r, g, b }: Rgb): [number, number, number] {
  const lr = srgbToLinear(r)
  const lg = srgbToLinear(g)
  const lb = srgbToLinear(b)

  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)

  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

function oklabToRgb([L, a, bb]: [number, number, number]): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * bb) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * bb) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * bb) ** 3

  return {
    r: linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  }
}

/** Score (0-100) to a colour on the continuous ramp, mixed in Oklab. */
export function scoreColor(score: number): string {
  const s = Math.max(0, Math.min(100, score))

  let lo = RAMP[0]
  let hi = RAMP[RAMP.length - 1]
  for (let i = 0; i < RAMP.length - 1; i++) {
    if (s >= RAMP[i][0] && s <= RAMP[i + 1][0]) {
      lo = RAMP[i]
      hi = RAMP[i + 1]
      break
    }
  }

  const span = hi[0] - lo[0]
  const t = span === 0 ? 0 : (s - lo[0]) / span

  const a = rgbToOklab(hexToRgb(lo[1]))
  const b = rgbToOklab(hexToRgb(hi[1]))
  const mixed: [number, number, number] = [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ]

  return rgbToHex(oklabToRgb(mixed))
}

/** deck.gl wants [r, g, b, a] with 0-255 components. */
export function scoreColorRgba(
  score: number,
  alpha = 255,
): [number, number, number, number] {
  const { r, g, b } = hexToRgb(scoreColor(score))
  return [Math.round(r), Math.round(g), Math.round(b), alpha]
}

/** Relative luminance, used to check the ramp still ranks in greyscale. */
export function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex)
  return (
    0.2126 * srgbToLinear(r) +
    0.7152 * srgbToLinear(g) +
    0.0722 * srgbToLinear(b)
  )
}

/** The ramp rendered in greyscale — the colour-blindness check from 1.4. */
export function greyscale(hex: string): string {
  const v = Math.round(linearToSrgb(luminance(hex)))
  return rgbToHex({ r: v, g: v, b: v })
}

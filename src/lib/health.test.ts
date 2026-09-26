import { describe, expect, it } from 'vitest'
import {
  BAND_WIDTH,
  greyscale,
  luminance,
  scoreBand,
  scoreColor,
  scoreColorRgba,
} from '@/lib/health'

describe('scoreBand', () => {
  it('uses the UI_DESIGN 1.4 thresholds', () => {
    expect(scoreBand(100)).toBe('good')
    expect(scoreBand(70)).toBe('good')
    expect(scoreBand(69.9)).toBe('watch')
    expect(scoreBand(40)).toBe('watch')
    expect(scoreBand(39.9)).toBe('critical')
    expect(scoreBand(0)).toBe('critical')
  })

  it('gives worse roads a wider stroke, so colour is not the only signal', () => {
    expect(BAND_WIDTH.critical).toBeGreaterThan(BAND_WIDTH.watch)
    expect(BAND_WIDTH.watch).toBeGreaterThan(BAND_WIDTH.good)
  })
})

describe('scoreColor', () => {
  it('returns the exact ramp stops at their scores', () => {
    expect(scoreColor(25).toLowerCase()).toBe('#f43f5e')
    expect(scoreColor(100).toLowerCase()).toBe('#6ee7b7')
    expect(scoreColor(0).toLowerCase()).toBe('#b4123c')
  })

  it('clamps out-of-range scores instead of throwing', () => {
    expect(scoreColor(-40)).toBe(scoreColor(0))
    expect(scoreColor(140)).toBe(scoreColor(100))
  })

  it('stays monotonic in lightness, so the greyscale check passes', () => {
    // The colour-blindness guarantee: lightness alone must rank the bands.
    const scores = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
    const lums = scores.map((s) => luminance(scoreColor(s)))
    for (let i = 1; i < lums.length; i++) {
      expect(lums[i]).toBeGreaterThan(lums[i - 1])
    }
  })

  it('never produces a muddy brown in the watch range', () => {
    // A straight sRGB lerp red->green passes through brown around score 50,
    // which is exactly where an engineer must tell watch from about-to-fail.
    for (const s of [45, 50, 55, 60]) {
      const { r, g, b } = {
        r: parseInt(scoreColor(s).slice(1, 3), 16),
        g: parseInt(scoreColor(s).slice(3, 5), 16),
        b: parseInt(scoreColor(s).slice(5, 7), 16),
      }
      const max = Math.max(r, g, b)
      const min = Math.min(r, g, b)
      expect(max - min).toBeGreaterThan(90) // saturated, not muddy
      expect(max).toBeGreaterThan(200) // and bright
    }
  })

  it('produces deck.gl-shaped colour arrays', () => {
    const [r, g, b, a] = scoreColorRgba(100, 180)
    expect([r, g, b]).toEqual([0x6e, 0xe7, 0xb7])
    expect(a).toBe(180)
  })
})

describe('greyscale', () => {
  it('returns a neutral grey', () => {
    const hex = greyscale('#F43F5E')
    expect(hex.slice(1, 3)).toBe(hex.slice(3, 5))
    expect(hex.slice(3, 5)).toBe(hex.slice(5, 7))
  })
})

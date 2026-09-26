import { describe, expect, it } from 'vitest'
import {
  computeKpis,
  estimateCostInr,
  forecastFor,
  generatePhotoReports,
  generateWorkOrders,
  impactOf,
  riskAt,
  simulateSegment,
  statusFor,
} from '@/data/mock/generate'
import type { RoadClass, Segment } from '@/data/types'
import { greedyAllocate } from '@/lib/knapsack'
import { scoreBand } from '@/lib/health'

/** A grid of segments shaped like the real GeoJSON, without needing a fetch. */
function makeSegments(count = 600): Segment[] {
  const classes: RoadClass[] = ['arterial', 'collector', 'local']
  return Array.from({ length: count }, (_, i) => {
    const lon = 76.56 + (i % 25) * 0.001
    const lat = 30.76 + Math.floor(i / 25) * 0.001
    return {
      id: i,
      name: `Test Road ${i % 40}`,
      highway: 'residential',
      roadClass: classes[i % 3],
      lengthM: 50,
      nearSensitive: i % 9 === 0,
      busRoute: i % 3 === 0,
      path: [
        [lon, lat],
        [lon + 0.0004, lat],
      ],
      center: [lon + 0.0002, lat],
    }
  })
}

const segments = makeSegments()
const sims = new Map(segments.map((s) => [s.id, simulateSegment(s)]))
const statuses = segments.map((s) => statusFor(s, sims.get(s.id)!, 0))

describe('determinism', () => {
  it('produces identical history for the same segment every run', () => {
    const first = simulateSegment(segments[7])
    const second = simulateSegment(segments[7])
    expect(second.history).toEqual(first.history)
    expect(second.breakdown).toEqual(first.breakdown)
  })

  it('does not depend on the order segments are generated in', () => {
    const forwards = simulateSegment(segments[3])
    // Generate others in between; the seed is per segment id, not a sequence.
    simulateSegment(segments[99])
    simulateSegment(segments[1])
    const again = simulateSegment(segments[3])
    expect(again.history).toEqual(forwards.history)
  })

  it('gives photo reports the same ids and targets every run', () => {
    const scores = new Map(
      segments.map((s) => [s.id, sims.get(s.id)!.history.at(-1)!.score]),
    )
    const a = generatePhotoReports(segments, scores)
    const b = generatePhotoReports(segments, scores)
    expect(b.map((r) => [r.id, r.segmentId])).toEqual(
      a.map((r) => [r.id, r.segmentId]),
    )
  })
})

describe('health band mix', () => {
  it('lands near the target in CLAUDE.md 4.3', () => {
    const total = statuses.length
    const share = (band: string) =>
      statuses.filter((s) => s.band === band).length / total

    // About 15% critical, and the majority still in good condition — a city
    // that is mostly amber reads as noise rather than as a priority list.
    expect(share('critical')).toBeGreaterThan(0.08)
    expect(share('critical')).toBeLessThan(0.24)
    expect(share('good')).toBeGreaterThan(0.35)
  })

  it('agrees with the shared band thresholds', () => {
    for (const status of statuses) {
      expect(status.band).toBe(scoreBand(status.score))
    }
  })

  it('keeps every score inside 0 to 100', () => {
    for (const sim of sims.values()) {
      for (const day of sim.history) {
        expect(day.score).toBeGreaterThanOrEqual(0)
        expect(day.score).toBeLessThanOrEqual(100)
      }
    }
  })

  it('produces a breakdown that adds up to the score', () => {
    for (const status of statuses) {
      const { base, bumpPenalty, roughnessPenalty, photoPenalty } =
        status.breakdown
      const implied = base - bumpPenalty - roughnessPenalty - photoPenalty
      expect(implied).toBeCloseTo(status.score, 0)
    }
  })
})

describe('forecast', () => {
  it('widens the uncertainty band with time', () => {
    const forecast = forecastFor(sims.get(4)!.history)
    const early = forecast[5]
    const late = forecast[85]
    expect(late.upper - late.lower).toBeGreaterThan(early.upper - early.lower)
  })

  it('raises risk further out for a road that is falling', () => {
    const falling = statuses.filter((s) => s.trend30 < -0.02)
    expect(falling.length).toBeGreaterThan(0)

    // Once a road is certain to fail the three numbers all sit at ~0.9999999
    // and the widening band moves them by about 1e-8, so compare with a
    // tolerance rather than exactly.
    const EPSILON = 1e-6
    for (const status of falling.slice(0, 40)) {
      expect(status.risk60).toBeGreaterThanOrEqual(status.risk30 - EPSILON)
      expect(status.risk90).toBeGreaterThanOrEqual(status.risk60 - EPSILON)
    }
  })

  it('keeps every risk a probability', () => {
    for (const status of statuses) {
      for (const risk of [status.risk30, status.risk60, status.risk90]) {
        expect(risk).toBeGreaterThanOrEqual(0)
        expect(risk).toBeLessThanOrEqual(1)
      }
    }
  })

  it('reports near-certain failure for a road already below the line', () => {
    const history = Array.from({ length: 180 }, (_, i) => ({
      day: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
      score: Math.max(0, 30 - i * 0.1),
    }))
    expect(riskAt(history, 30)).toBeGreaterThan(0.9)
  })
})

describe('priority and cost', () => {
  it('weights arterials, bus routes and sensitive sites above quiet lanes', () => {
    const quiet = impactOf({
      ...segments[0],
      roadClass: 'local',
      nearSensitive: false,
      busRoute: false,
    })
    const busy = impactOf({
      ...segments[0],
      roadClass: 'arterial',
      nearSensitive: true,
      busRoute: true,
    })
    expect(busy).toBeGreaterThan(quiet * 5)
  })

  it('resurfaces below 40 and patches above it', () => {
    expect(estimateCostInr(segments[0], 39.9).repairType).toBe('resurfacing')
    expect(estimateCostInr(segments[0], 40).repairType).toBe('patching')
    expect(estimateCostInr(segments[0], 20).costInr).toBeGreaterThan(
      estimateCostInr(segments[0], 80).costInr,
    )
  })

  it('ranks a worse, more important road above a better, quieter one', () => {
    const ranked = [...statuses].sort((a, b) => b.priority - a.priority)
    expect(ranked[0].priority).toBeGreaterThanOrEqual(ranked.at(-1)!.priority)
    // The top of the queue should not be full of healthy roads.
    const topBands = ranked.slice(0, 20).map((s) => s.band)
    expect(topBands.filter((b) => b === 'good').length).toBeLessThan(5)
  })
})

describe('budget allocation', () => {
  const candidates = statuses.map((s) => ({
    id: s.id,
    value: s.priority,
    costInr: s.estimatedCostInr,
  }))

  it('never exceeds the budget', () => {
    for (const budget of [0, 5_00_000, 50_00_000, 5_00_00_000]) {
      expect(greedyAllocate(candidates, budget).totalCostInr).toBeLessThanOrEqual(
        budget,
      )
    }
  })

  it('removes more risk as the budget grows', () => {
    const small = greedyAllocate(candidates, 20_00_000)
    const large = greedyAllocate(candidates, 2_00_00_000)
    expect(large.totalValue).toBeGreaterThan(small.totalValue)
    expect(large.chosen.length).toBeGreaterThan(small.chosen.length)
  })

  it('is stable: raising the budget never drops a funded segment', () => {
    // The slider has to feel monotonic, or the map flickers as it moves.
    const small = new Set(greedyAllocate(candidates, 40_00_000).chosen)
    const large = new Set(greedyAllocate(candidates, 80_00_000).chosen)
    for (const id of small) expect(large.has(id)).toBe(true)
  })
})

describe('work orders and KPIs', () => {
  it('seeds orders across every column', () => {
    const orders = generateWorkOrders(segments, statuses)
    const seen = new Set(orders.map((o) => o.status))
    expect(seen).toContain('open')
    expect(seen).toContain('in-progress')
    expect(seen).toContain('verified')
    expect(orders.every((o) => o.costInr > 0)).toBe(true)
  })

  it('records an improvement only for verified repairs', () => {
    for (const order of generateWorkOrders(segments, statuses)) {
      if (order.status === 'verified') {
        expect(order.bumpRateAfter).toBeDefined()
        expect(order.bumpRateAfter!).toBeLessThan(order.bumpRateBefore)
      } else {
        expect(order.bumpRateAfter).toBeUndefined()
      }
    }
  })

  it('computes KPIs that agree with the statuses they came from', () => {
    const histories = new Map(
      [...sims.entries()].map(([id, sim]) => [id, sim.history]),
    )
    const orders = generateWorkOrders(segments, statuses)
    const kpis = computeKpis(statuses, histories, orders, 400)

    expect(kpis.criticalCount + kpis.watchCount + kpis.goodCount).toBe(
      statuses.length,
    )
    expect(kpis.cityHealthIndex).toBeGreaterThan(0)
    expect(kpis.cityHealthIndex).toBeLessThan(100)
    expect(kpis.healthTrend).toHaveLength(30)
    expect(kpis.bumpsToday).toBe(400)
  })
})

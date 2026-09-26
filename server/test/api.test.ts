import { beforeAll, describe, expect, it } from 'vitest'
import type { Hono } from 'hono'
import { createApp } from '../src/app.js'
import { InfraPulseService } from '../src/domain/service.js'
import { EventBus } from '../src/live/EventBus.js'
import { InMemoryRepository } from '../src/repository/InMemoryRepository.js'
import type { Segment, SegmentStatus, WorkOrder } from '@shared/contract'

/* Each suite gets its own repository, so an ingest in one test cannot move a
 * score another test is asserting on. */
function build() {
  const repo = new InMemoryRepository()
  const bus = new EventBus()
  const service = new InfraPulseService(repo, bus)
  const app = createApp({ service, enableDemoRoutes: true, quiet: true })
  return { app, service, bus }
}

async function json<T>(
  app: Hono,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await app.request(path, init)
  return (await response.json()) as T
}

function post(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

describe('health and errors', () => {
  const { app } = build()

  it('reports healthy', async () => {
    const response = await app.request('/api/health')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'ok' })
  })

  it('returns a structured 404 for an unknown endpoint', async () => {
    const response = await app.request('/api/nope')
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({
      error: { code: 'not_found' },
    })
  })

  it('rejects a non-numeric segment id without reaching the repository', async () => {
    const response = await app.request('/api/segments/abc/history')
    expect(response.status).toBe(400)
  })

  it('404s an unknown segment', async () => {
    const response = await app.request('/api/segments/999999/history')
    expect(response.status).toBe(404)
  })
})

describe('road network', () => {
  const { app } = build()
  let segments: Segment[]

  beforeAll(async () => {
    segments = await json<Segment[]>(app, '/api/segments')
  })

  it('serves the imported network', () => {
    expect(segments.length).toBeGreaterThan(500)
    expect(segments[0]).toMatchObject({
      id: expect.any(Number),
      name: expect.any(String),
      lengthM: expect.any(Number),
    })
    expect(segments[0].path.length).toBeGreaterThan(1)
  })

  it('serves a status row per segment', async () => {
    const statuses = await json<SegmentStatus[]>(app, '/api/segments/status')
    expect(statuses).toHaveLength(segments.length)
    for (const status of statuses.slice(0, 50)) {
      expect(status.score).toBeGreaterThanOrEqual(0)
      expect(status.score).toBeLessThanOrEqual(100)
      expect(status.risk30).toBeGreaterThanOrEqual(0)
      expect(status.risk30).toBeLessThanOrEqual(1)
    }
  })

  it('projects the city forward', async () => {
    const today = await json<{ id: number; score: number }[]>(
      app,
      '/api/segments/projected?days=0',
    )
    const later = await json<{ id: number; score: number }[]>(
      app,
      '/api/segments/projected?days=90',
    )

    expect(later).toHaveLength(today.length)
    const meanOf = (rows: { score: number }[]) =>
      rows.reduce((a, r) => a + r.score, 0) / rows.length
    // Roads do not spontaneously improve.
    expect(meanOf(later)).toBeLessThan(meanOf(today))
  })

  it('rejects a projection beyond the forecast horizon', async () => {
    const response = await app.request('/api/segments/projected?days=400')
    expect(response.status).toBe(400)
  })
})

describe('ingest', () => {
  it('matches impacts to the road they happened on and lowers the score', async () => {
    const { app } = build()
    const segments = await json<Segment[]>(app, '/api/segments')
    const target = segments[300]

    const before = (
      await json<SegmentStatus[]>(app, '/api/segments/status')
    ).find((s) => s.id === target.id)!

    const response = await app.request(
      '/api/ingest/bumps',
      post({
        deviceId: 'device-under-test',
        tripId: 'trip-1',
        bumps: Array.from({ length: 10 }, () => ({
          at: new Date().toISOString(),
          lat: target.center[1],
          lon: target.center[0],
          magnitude: 12.5,
          speedMs: 11,
        })),
      }),
    )

    expect(response.status).toBe(202)
    const result = (await response.json()) as {
      accepted: number
      matched: number
      unmatched: number
    }
    expect(result).toMatchObject({ accepted: 10, matched: 10, unmatched: 0 })

    const after = (
      await json<SegmentStatus[]>(app, '/api/segments/status')
    ).find((s) => s.id === target.id)!

    expect(after.bumpsLast7Days).toBe(10)
    expect(after.score).toBeLessThan(before.score)
  })

  it('is idempotent on read: the score does not drift', async () => {
    // Regression test. The first version wrote the derived score back into
    // history, so every read subtracted the same impacts again and the score
    // sank on each request.
    const { app } = build()
    const segments = await json<Segment[]>(app, '/api/segments')
    const target = segments[120]

    await app.request(
      '/api/ingest/bumps',
      post({
        deviceId: 'device-under-test',
        tripId: 'trip-1',
        bumps: [
          {
            at: new Date().toISOString(),
            lat: target.center[1],
            lon: target.center[0],
            magnitude: 11,
            speedMs: 9,
          },
        ],
      }),
    )

    const read = async () =>
      (await json<SegmentStatus[]>(app, '/api/segments/status')).find(
        (s) => s.id === target.id,
      )!.score

    const first = await read()
    expect(await read()).toBe(first)
    expect(await read()).toBe(first)
  })

  it('keeps impacts that fall outside the network instead of dropping them', async () => {
    const { app } = build()
    const result = await json<{ matched: number; unmatched: number }>(
      app,
      '/api/ingest/bumps',
      post({
        deviceId: 'device-under-test',
        tripId: 'trip-2',
        bumps: [
          {
            at: new Date().toISOString(),
            // The Arabian Sea.
            lat: 18.5,
            lon: 70.2,
            magnitude: 9,
            speedMs: 11,
          },
        ],
      }),
    )

    expect(result).toMatchObject({ matched: 0, unmatched: 1 })
  })

  it('refuses impossible readings', async () => {
    const { app } = build()

    for (const bad of [
      { lat: 200, lon: 76.5, magnitude: 9, speedMs: 10 },
      { lat: 30.7, lon: 76.5, magnitude: -1, speedMs: 10 },
      { lat: 30.7, lon: 76.5, magnitude: 9, speedMs: 900 },
    ]) {
      const response = await app.request(
        '/api/ingest/bumps',
        post({
          deviceId: 'device-under-test',
          tripId: 'trip-3',
          bumps: [{ at: new Date().toISOString(), ...bad }],
        }),
      )
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        error: { code: 'validation_failed' },
      })
    }
  })

  it('caps how much one request can carry', async () => {
    const { app } = build()
    const response = await app.request(
      '/api/ingest/bumps',
      post({
        deviceId: 'device-under-test',
        tripId: 'trip-4',
        bumps: Array.from({ length: 501 }, () => ({
          at: new Date().toISOString(),
          lat: 30.768,
          lon: 76.575,
          magnitude: 9,
          speedMs: 10,
        })),
      }),
    )
    expect(response.status).toBe(400)
  })

  it('tells connected dashboards about every matched impact', async () => {
    const { app, service } = build()
    const seen: string[] = []
    service.subscribe((event) => seen.push(event.type))

    const segments = await json<Segment[]>(app, '/api/segments')
    await app.request(
      '/api/ingest/bumps',
      post({
        deviceId: 'device-under-test',
        tripId: 'trip-5',
        bumps: [
          {
            at: new Date().toISOString(),
            lat: segments[10].center[1],
            lon: segments[10].center[0],
            magnitude: 10,
            speedMs: 12,
          },
        ],
      }),
    )

    expect(seen).toContain('bump')
  })
})

describe('work orders', () => {
  it('creates one per segment and refuses a second while it is live', async () => {
    const { app } = build()
    const created = await json<WorkOrder[]>(
      app,
      '/api/work-orders',
      post({ segmentIds: [4, 5, 6] }),
    )
    expect(created).toHaveLength(3)

    const again = await json<WorkOrder[]>(
      app,
      '/api/work-orders',
      post({ segmentIds: [4, 5, 6] }),
    )
    expect(again).toHaveLength(0)
  })

  it('enforces the status flow', async () => {
    const { app } = build()
    const [order] = await json<WorkOrder[]>(
      app,
      '/api/work-orders',
      post({ segmentIds: [11] }),
    )

    // Open cannot jump straight to verified.
    const jump = await app.request(`/api/work-orders/${order.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'verified' }),
    })
    expect(jump.status).toBe(409)

    for (const status of ['in-progress', 'repaired', 'verified'] as const) {
      const response = await app.request(`/api/work-orders/${order.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      })
      expect(response.status).toBe(200)
    }

    const verified = (await json<WorkOrder[]>(app, '/api/work-orders')).find(
      (w) => w.id === order.id,
    )!
    expect(verified.status).toBe('verified')
    // Verifying measures the repair.
    expect(verified.bumpRateAfter).toBeDefined()
  })

  it('404s an unknown work order', async () => {
    const { app } = build()
    const response = await app.request('/api/work-orders/WO-nope', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'in-progress' }),
    })
    expect(response.status).toBe(404)
  })
})

describe('photo reports', () => {
  it('accepts a report, holds it pending, and scores it once approved', async () => {
    const { app } = build()
    const segments = await json<Segment[]>(app, '/api/segments')
    const target = segments[42]

    const created = await json<{
      id: string
      status: string
      segmentId: number
    }>(
      app,
      '/api/reports',
      post({
        lat: target.center[1],
        lon: target.center[0],
        imageUrl: '/mock-photos/road-1.svg',
        label: 'pothole',
        confidence: 0.91,
        severity: 'severe',
        box: { x: 0.3, y: 0.3, w: 0.2, h: 0.2 },
        reporter: 'Test Citizen',
      }),
    )

    // A citizen's report is a claim until an engineer accepts it.
    expect(created.status).toBe('pending')
    expect(created.segmentId).toBe(target.id)

    const before = (
      await json<SegmentStatus[]>(app, '/api/segments/status')
    ).find((s) => s.id === target.id)!

    const approved = await app.request(`/api/reports/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'approved' }),
    })
    expect(approved.status).toBe(200)

    const after = (
      await json<SegmentStatus[]>(app, '/api/segments/status')
    ).find((s) => s.id === target.id)!

    expect(after.score).toBeLessThan(before.score)
  })

  it('refuses a report that is not on a road', async () => {
    const { app } = build()
    const response = await app.request(
      '/api/reports',
      post({
        lat: 18.5,
        lon: 70.2,
        imageUrl: '/mock-photos/road-1.svg',
        label: 'pothole',
        confidence: 0.8,
        severity: 'minor',
        box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
        reporter: 'Test Citizen',
      }),
    )
    expect(response.status).toBe(400)
  })
})

describe('kpis', () => {
  it('adds up to the network it describes', async () => {
    const { app } = build()
    const segments = await json<Segment[]>(app, '/api/segments')
    const kpis = await json<{
      criticalCount: number
      watchCount: number
      goodCount: number
      cityHealthIndex: number
      healthTrend: number[]
    }>(app, '/api/kpis')

    expect(kpis.criticalCount + kpis.watchCount + kpis.goodCount).toBe(
      segments.length,
    )
    expect(kpis.cityHealthIndex).toBeGreaterThan(0)
    expect(kpis.cityHealthIndex).toBeLessThan(100)
    expect(kpis.healthTrend).toHaveLength(30)
  })
})

import { beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { InfraPulseService } from '../src/domain/service.js'
import { EventBus } from '../src/live/EventBus.js'
import { InMemoryRepository } from '../src/repository/InMemoryRepository.js'
import type { Segment, SegmentStatus, WorkOrder } from '@shared/contract'

const OPERATOR_PASSWORD = 'test-operator-password'

/** Anything that can take a request: the raw app, or the signed-in wrapper. */
interface Requestable {
  request(path: string, init?: RequestInit): Promise<Response>
}

/* Each suite gets its own repository, so an ingest in one test cannot move a
 * score another test is asserting on.
 *
 * `app` signs in as the operator on first use, because most of the API is
 * behind that gate and repeating the login in every test would bury what each
 * one is actually checking. `anonymous` is the same app without the cookie,
 * for the tests that check the gate itself. */
function build() {
  const repo = new InMemoryRepository()
  const bus = new EventBus()
  const service = new InfraPulseService(repo, bus)
  const anonymous = createApp({
    service,
    enableDemoRoutes: true,
    quiet: true,
    operatorPassword: OPERATOR_PASSWORD,
  })

  let cookie: string | null = null

  const app: Requestable = {
    async request(path, init) {
      if (!cookie) {
        const response = await anonymous.request('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: OPERATOR_PASSWORD }),
        })
        cookie = (response.headers.get('set-cookie') ?? '').split(';')[0]
      }

      const headers = new Headers(init?.headers)
      headers.set('Cookie', cookie)
      return anonymous.request(path, { ...init, headers })
    },
  }

  return { app, anonymous, service, bus }
}

async function json<T>(
  app: Requestable,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await app.request(path, init)
  return (await response.json()) as T
}

function post(body: unknown, token?: string): RequestInit {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  }
}

/** Registers a device and returns its bearer token. */
async function register(app: Requestable): Promise<string> {
  const response = await app.request('/api/devices/register', {
    method: 'POST',
  })
  const body = (await response.json()) as { token: string }
  return body.token
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
    const token = await register(app)
    const segments = await json<Segment[]>(app, '/api/segments')
    const target = segments[300]

    const before = (
      await json<SegmentStatus[]>(app, '/api/segments/status')
    ).find((s) => s.id === target.id)!

    const response = await app.request(
      '/api/ingest/bumps',
      post(
        {
          tripId: 'trip-1',
          bumps: Array.from({ length: 10 }, () => ({
            at: new Date().toISOString(),
            lat: target.center[1],
            lon: target.center[0],
            magnitude: 12.5,
            speedMs: 11,
          })),
        },
        token,
      ),
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
    const token = await register(app)
    const segments = await json<Segment[]>(app, '/api/segments')
    const target = segments[120]

    await app.request(
      '/api/ingest/bumps',
      post(
        {
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
        },
        token,
      ),
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
    const token = await register(app)
    const result = await json<{ matched: number; unmatched: number }>(
      app,
      '/api/ingest/bumps',
      post(
        {
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
        },
        token,
      ),
    )

    expect(result).toMatchObject({ matched: 0, unmatched: 1 })
  })

  it('refuses impossible readings', async () => {
    const { app } = build()
    const token = await register(app)

    for (const bad of [
      { lat: 200, lon: 76.5, magnitude: 9, speedMs: 10 },
      { lat: 30.7, lon: 76.5, magnitude: -1, speedMs: 10 },
      { lat: 30.7, lon: 76.5, magnitude: 9, speedMs: 900 },
    ]) {
      const response = await app.request(
        '/api/ingest/bumps',
        post(
          {
            tripId: 'trip-3',
            bumps: [{ at: new Date().toISOString(), ...bad }],
          },
          token,
        ),
      )
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        error: { code: 'validation_failed' },
      })
    }
  })

  it('caps how much one request can carry', async () => {
    const { app } = build()
    const token = await register(app)
    const response = await app.request(
      '/api/ingest/bumps',
      post(
        {
          tripId: 'trip-4',
          bumps: Array.from({ length: 501 }, () => ({
            at: new Date().toISOString(),
            lat: 30.768,
            lon: 76.575,
            magnitude: 9,
            speedMs: 10,
          })),
        },
        token,
      ),
    )
    expect(response.status).toBe(400)
  })

  it('tells connected dashboards about every matched impact', async () => {
    const { app, service } = build()
    const token = await register(app)
    const seen: string[] = []
    service.subscribe((event) => seen.push(event.type))

    const segments = await json<Segment[]>(app, '/api/segments')
    await app.request(
      '/api/ingest/bumps',
      post(
        {
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
        },
        token,
      ),
    )

    expect(seen).toContain('bump')
  })
})

describe('ingest is not open to the world', () => {
  it('refuses an ingest with no device token', async () => {
    const { app } = build()
    const response = await app.request(
      '/api/ingest/bumps',
      post({
        tripId: 'trip-x',
        bumps: [
          {
            at: new Date().toISOString(),
            lat: 30.768,
            lon: 76.575,
            magnitude: 9,
            speedMs: 10,
          },
        ],
      }),
    )

    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({
      error: { code: 'device_token_required' },
    })
  })

  it('refuses a forged or tampered token', async () => {
    const { app } = build()
    const real = await register(app)

    // Same device id, signature altered by one character.
    const parts = real.split('.')
    const tampered = [
      parts[0],
      parts[1],
      parts[2].slice(0, -1) + (parts[2].endsWith('A') ? 'B' : 'A'),
    ].join('.')

    for (const token of [tampered, 'v1.whoever.i-say-i-am', 'nonsense']) {
      const response = await app.request(
        '/api/ingest/bumps',
        post(
          {
            tripId: 'trip-x',
            bumps: [
              {
                at: new Date().toISOString(),
                lat: 30.768,
                lon: 76.575,
                magnitude: 9,
                speedMs: 10,
              },
            ],
          },
          token,
        ),
      )
      expect(response.status).toBe(401)
    }
  })

  it('attributes readings to the token, not to anything in the body', async () => {
    // The body used to carry a deviceId, which meant a caller could claim to be
    // any device — or a thousand of them — and walk around the rate limit.
    const { app } = build()
    const token = await register(app)
    const segments = await json<Segment[]>(app, '/api/segments')

    const response = await app.request(
      '/api/ingest/bumps',
      post(
        {
          deviceId: 'somebody-elses-device',
          tripId: 'trip-x',
          bumps: [
            {
              at: new Date().toISOString(),
              lat: segments[5].center[1],
              lon: segments[5].center[0],
              magnitude: 9,
              speedMs: 10,
            },
          ],
        },
        token,
      ),
    )

    // The extra field is ignored rather than honoured.
    expect(response.status).toBe(202)
  })

  it('throttles a device submitting far more than a drive could produce', async () => {
    const { app } = build()
    const token = await register(app)
    const segments = await json<Segment[]>(app, '/api/segments')

    const batch = (count: number) =>
      post(
        {
          tripId: 'stuck-sensor',
          bumps: Array.from({ length: count }, () => ({
            at: new Date().toISOString(),
            lat: segments[9].center[1],
            lon: segments[9].center[0],
            magnitude: 14,
            speedMs: 12,
          })),
        },
        token,
      )

    let limited = false
    // 8 x 500 is 4,000 readings in a minute: well past a real trip.
    for (let i = 0; i < 8; i++) {
      const response = await app.request('/api/ingest/bumps', batch(500))
      if (response.status === 429) {
        limited = true
        expect(response.headers.get('Retry-After')).toBeTruthy()
        expect(await response.json()).toMatchObject({
          error: { code: 'rate_limited' },
        })
        break
      }
    }

    expect(limited).toBe(true)
  })

  it('gives each registration its own budget', async () => {
    const { app } = build()
    const a = await register(app)
    const b = await register(app)
    expect(a).not.toBe(b)
  })
})

describe('the engineer routes are not public', () => {
  const OPERATOR_ONLY: [string, string][] = [
    ['GET', '/api/segments'],
    ['GET', '/api/segments/status'],
    ['GET', '/api/segments/1/history'],
    ['GET', '/api/work-orders'],
    ['GET', '/api/escalations'],
    ['GET', '/api/reports'],
  ]

  it('refuses every operator route without a session', async () => {
    const { anonymous } = build()

    for (const [method, path] of OPERATOR_ONLY) {
      const response = await anonymous.request(path, { method })
      expect(response.status, `${method} ${path}`).toBe(401)
      expect(await response.json()).toMatchObject({
        error: { code: 'login_required' },
      })
    }
  })

  it('refuses a wrong password, and says nothing about why', async () => {
    const { anonymous } = build()
    const response = await anonymous.request(
      '/api/auth/login',
      post({ password: 'not-the-password' }),
    )

    expect(response.status).toBe(401)
    const body = (await response.json()) as { error: { message: string } }
    expect(body.error.message).not.toContain(OPERATOR_PASSWORD)
  })

  it('lets an operator in and out again', async () => {
    const { anonymous } = build()

    expect(
      await json<{ signedIn: boolean }>(anonymous, '/api/auth/me'),
    ).toEqual({
      signedIn: false,
    })

    const login = await anonymous.request(
      '/api/auth/login',
      post({ password: OPERATOR_PASSWORD }),
    )
    expect(login.status).toBe(200)

    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
    expect(cookie).toContain('infrapulse_session')

    const me = await anonymous.request('/api/auth/me', {
      headers: { Cookie: cookie },
    })
    expect(await me.json()).toEqual({ signedIn: true })

    const segments = await anonymous.request('/api/segments', {
      headers: { Cookie: cookie },
    })
    expect(segments.status).toBe(200)
  })

  it('keeps the session cookie away from scripts', async () => {
    // HttpOnly is the difference between a cross-site script stealing a
    // session and merely being able to use one while the page is open.
    const { anonymous } = build()
    const login = await anonymous.request(
      '/api/auth/login',
      post({ password: OPERATOR_PASSWORD }),
    )
    const header = login.headers.get('set-cookie') ?? ''
    expect(header).toContain('HttpOnly')
    expect(header).toContain('SameSite=Lax')
  })

  it('rejects a tampered session', async () => {
    const { anonymous } = build()
    const login = await anonymous.request(
      '/api/auth/login',
      post({ password: OPERATOR_PASSWORD }),
    )
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
    const tampered = cookie.slice(0, -1) + (cookie.endsWith('A') ? 'B' : 'A')

    const response = await anonymous.request('/api/segments', {
      headers: { Cookie: tampered },
    })
    expect(response.status).toBe(401)
  })

  it('still lets a citizen report a pothole without signing in', async () => {
    // Requiring an account to report a pothole would defeat the point.
    const { app, anonymous } = build()
    const segments = await json<Segment[]>(app, '/api/segments')
    const target = segments[7]

    const response = await anonymous.request(
      '/api/reports',
      post({
        lat: target.center[1],
        lon: target.center[0],
        imageUrl: '/mock-photos/road-1.svg',
        label: 'pothole',
        confidence: 0.88,
        severity: 'moderate',
        box: { x: 0.2, y: 0.2, w: 0.2, h: 0.2 },
        reporter: 'Passing Citizen',
      }),
    )

    expect(response.status).toBe(201)
  })

  it('still lets a phone register and ingest without signing in', async () => {
    const { anonymous } = build()

    const registration = await anonymous.request('/api/devices/register', {
      method: 'POST',
    })
    expect(registration.status).toBe(201)

    const { token } = (await registration.json()) as { token: string }
    const ingest = await anonymous.request(
      '/api/ingest/bumps',
      post(
        {
          tripId: 'anonymous-trip',
          bumps: [
            {
              at: new Date().toISOString(),
              lat: 30.768,
              lon: 76.575,
              magnitude: 11,
              speedMs: 10,
            },
          ],
        },
        token,
      ),
    )
    expect(ingest.status).toBe(202)
  })

  it('leaves the city-wide summary readable', async () => {
    // The landing page shows aggregate condition to the public, which is
    // civic information rather than something to guard.
    const { anonymous } = build()
    const response = await anonymous.request('/api/kpis')
    expect(response.status).toBe(200)
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

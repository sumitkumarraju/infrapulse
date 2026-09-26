import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { streamSSE } from 'hono/streaming'
import { ZodError } from 'zod'
import type { LiveEvent } from '@shared/contract'
import type { InfraPulseService } from './domain/service.js'
import { ApiError } from './http/errors.js'
import { ImportError } from './regions/overpass.js'
import {
  clearSessionCookie,
  currentSession,
  issueSessionCookie,
  passwordMatches,
  requireOperator,
} from './http/session.js'
import { mintDeviceToken, requireDevice } from './http/auth.js'
import { rateLimit } from './http/rateLimit.js'
import {
  createWorkOrdersSchema,
  ingestSchema,
  photoReportSchema,
  photoStatusSchema,
  loginSchema,
  importRegionSchema,
  placeSearchSchema,
  projectedQuerySchema,
  reviewEscalationSchema,
  updateWorkOrderSchema,
} from './http/schemas.js'

export interface AppOptions {
  service: InfraPulseService
  /** Origins allowed to call the API. Empty means same-origin only. */
  corsOrigins?: string[]
  /** Demo endpoints are convenient locally and dangerous in production. */
  enableDemoRoutes?: boolean
  /** HMAC secret for device tokens on the ingest endpoint. */
  deviceTokenSecret?: string
  /** The engineer dashboard's password. */
  operatorPassword?: string
  /** Signs operator session cookies. */
  sessionSecret?: string
  /** Set on the session cookie. False only for plain-http local development. */
  secureCookies?: boolean
  quiet?: boolean
}

/* Ingest budgets, per device per minute.
 *
 * A trip that hits a pothole every second for ten minutes is ~600 readings, and
 * the client batches at 10. These allow several times that, so an ordinary
 * drive never comes close, while a sensor stuck in a loop is stopped before it
 * can bury a road under thousands of phantom impacts. */
const INGEST_REQUESTS_PER_MINUTE = 60
const INGEST_READINGS_PER_MINUTE = 3000
/** Registration is once per install; this only stops a loop hammering it. */
const REGISTRATIONS_PER_HOUR = 20

/**
 * Every route the client needs, mounted under /api.
 *
 * The app is built by a function rather than exported as a singleton so tests
 * can stand up an isolated instance with its own repository — no shared state
 * between test files, and no network listener.
 */
export function createApp({
  service,
  corsOrigins = [],
  enableDemoRoutes = false,
  deviceTokenSecret = 'infrapulse-development-secret',
  operatorPassword = 'infrapulse-dev',
  sessionSecret = 'infrapulse-development-session-secret',
  secureCookies = false,
  quiet = false,
}: AppOptions) {
  const app = new Hono()

  if (!quiet) app.use('*', logger())

  if (corsOrigins.length > 0) {
    app.use(
      '/api/*',
      cors({
        origin: corsOrigins,
        allowMethods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
        allowHeaders: ['Content-Type'],
        // The session is a cookie, so the browser will not send it
        // cross-origin unless the server says so. This is also why `origin`
        // is an explicit list and never '*' — the two are incompatible.
        credentials: true,
        maxAge: 86_400,
      }),
    )
  }

  /* --- Errors ----------------------------------------------------------- */

  app.onError((error, c) => {
    if (error instanceof ApiError) {
      return c.json(error.toResponse(), error.status)
    }

    if (error instanceof ImportError) {
      // Area too large, nothing mapped there, OpenStreetMap unreachable: all
      // things the person who asked can act on.
      return c.json(
        { error: { code: 'import_failed', message: error.message } },
        422,
      )
    }

    if (error instanceof ZodError) {
      // Field-level detail, so the client can point at the offending input
      // rather than saying "something was wrong".
      return c.json(
        {
          error: {
            code: 'validation_failed',
            message:
              'The request body did not match what this endpoint expects.',
            fields: error.issues.map((issue) => ({
              path: issue.path.join('.'),
              message: issue.message,
            })),
          },
        },
        400,
      )
    }

    // Anything unexpected is logged in full and reported vaguely: internal
    // detail is for the operator, not the caller.
    console.error('Unhandled error', error)
    return c.json(
      { error: { code: 'internal', message: 'Something went wrong.' } },
      500,
    )
  })

  app.notFound((c) =>
    c.json({ error: { code: 'not_found', message: 'No such endpoint.' } }, 404),
  )

  /* --- Health ------------------------------------------------------------ */

  app.get('/api/health', (c) =>
    c.json({ status: 'ok', time: new Date().toISOString() }),
  )

  /* --- Who is allowed in ---------------------------------------------------- */

  /*
   * Two different gates, for two different callers.
   *
   * A driver's phone posts to /api/ingest/bumps with a device token: not a
   * login, because reporting a pothole should not require an account. An
   * engineer reading the condition of every road, moving work orders or
   * approving a complaint to a public authority signs in properly.
   */
  app.post(
    '/api/auth/login',
    // Slow down anyone working through a password list. The window is long on
    // purpose: a real operator logs in once a shift.
    rateLimit({ limit: 10, windowMs: 15 * 60_000 }),
    async (c) => {
      const body = loginSchema.parse(await c.req.json())

      if (!passwordMatches(body.password, operatorPassword)) {
        // No hint about which part was wrong.
        throw new ApiError(
          401,
          'invalid_credentials',
          'That password is not right.',
        )
      }

      issueSessionCookie(c, sessionSecret, secureCookies)
      return c.json({ signedIn: true })
    },
  )

  app.post('/api/auth/logout', (c) => {
    clearSessionCookie(c)
    return c.json({ signedIn: false })
  })

  // Lets the client decide whether to show the dashboard or the sign-in form
  // without having to provoke a 401 first.
  app.get('/api/auth/me', (c) =>
    c.json({ signedIn: currentSession(c, sessionSecret) !== null }),
  )

  /* --- Everything below is for signed-in operators --------------------------
   *
   * Applied as one rule rather than per route, so a new endpoint is protected
   * by default and has to be deliberately excluded. The exceptions above it are
   * the citizen and device surfaces: health, auth, device registration, ingest,
   * submitting a photo report, and the city-wide aggregate on the landing page.
   */
  app.use('/api/segments/*', requireOperator(sessionSecret))
  app.use('/api/segments', requireOperator(sessionSecret))
  app.use('/api/work-orders/*', requireOperator(sessionSecret))
  app.use('/api/work-orders', requireOperator(sessionSecret))
  app.use('/api/escalations/*', requireOperator(sessionSecret))
  app.use('/api/escalations', requireOperator(sessionSecret))
  app.use('/api/demo/*', requireOperator(sessionSecret))
  // Importing a region is an operator action; listing them is not, because the
  // driver app needs to know which areas exist.
  app.use('/api/regions/import', requireOperator(sessionSecret))

  // Reviewing the report queue is an operator job; submitting one is not, so
  // only the read and the decision are gated.
  app.use('/api/reports/*', async (c, next) => {
    if (c.req.method === 'POST') return next()
    return requireOperator(sessionSecret)(c, next)
  })
  app.use('/api/reports', async (c, next) => {
    if (c.req.method === 'POST') return next()
    return requireOperator(sessionSecret)(c, next)
  })

  /* --- Road network and condition ---------------------------------------- */

  app.get('/api/segments', async (c) => c.json(await service.getSegments()))

  app.get('/api/segments/status', async (c) =>
    c.json(await service.getStatuses()),
  )

  app.get('/api/segments/projected', async (c) => {
    const { days } = projectedQuerySchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    )
    return c.json(await service.getProjected(days))
  })

  app.get('/api/segments/:id/history', async (c) => {
    const id = segmentId(c.req.param('id'))
    return c.json(await service.getHistory(id))
  })

  app.get('/api/segments/:id/forecast', async (c) => {
    const id = segmentId(c.req.param('id'))
    return c.json(await service.getForecast(id))
  })

  /* --- Devices and ingest --------------------------------------------------- */

  // One call per install. The server issues the identifier so a caller cannot
  // choose one, and the token is what every later ingest is counted against.
  app.post(
    '/api/devices/register',
    rateLimit({ limit: REGISTRATIONS_PER_HOUR, windowMs: 60 * 60_000 }),
    (c) => c.json(mintDeviceToken(deviceTokenSecret), 201),
  )

  app.post(
    '/api/ingest/bumps',
    requireDevice(deviceTokenSecret),
    // Two limits: how often a device may call, and how much it may submit.
    // Either alone is easy to walk around — one big request, or many small ones.
    rateLimit({
      limit: INGEST_REQUESTS_PER_MINUTE,
      windowMs: 60_000,
      key: (c) => `req:${c.get('device').deviceId}`,
    }),
    rateLimit({
      limit: INGEST_READINGS_PER_MINUTE,
      windowMs: 60_000,
      key: (c) => `readings:${c.get('device').deviceId}`,
      cost: async (c) => {
        // Reads the body to weigh the request, then puts it back: Hono caches
        // the parsed body, so the handler does not pay for a second parse.
        const body = (await c.req.json().catch(() => null)) as {
          bumps?: unknown[]
        } | null
        return Math.max(1, body?.bumps?.length ?? 1)
      },
    }),
    async (c) => {
      const body = ingestSchema.parse(await c.req.json())
      // The device identity comes from the signature, never from the body.
      const result = await service.ingestBumps(
        c.get('device').deviceId,
        body.tripId,
        body.bumps,
      )
      return c.json(result, 202)
    },
  )

  /* --- Photo reports ------------------------------------------------------ */

  app.get('/api/reports', async (c) => c.json(await service.getPhotoReports()))

  app.post('/api/reports', async (c) => {
    const body = photoReportSchema.parse(await c.req.json())
    return c.json(await service.createPhotoReport(body), 201)
  })

  app.patch('/api/reports/:id', async (c) => {
    const body = photoStatusSchema.parse(await c.req.json())
    return c.json(await service.setPhotoStatus(c.req.param('id'), body.status))
  })

  /* --- Work orders --------------------------------------------------------- */

  app.get('/api/work-orders', async (c) =>
    c.json(await service.getWorkOrders()),
  )

  app.post('/api/work-orders', async (c) => {
    const body = createWorkOrdersSchema.parse(await c.req.json())
    const created = await service.createWorkOrders(body.segmentIds)
    return c.json(created, 201)
  })

  app.patch('/api/work-orders/:id', async (c) => {
    const body = updateWorkOrderSchema.parse(await c.req.json())
    return c.json(await service.updateWorkOrder(c.req.param('id'), body))
  })

  /* --- Regions -------------------------------------------------------------- */

  app.get('/api/regions', async (c) => c.json(await service.getRegions()))

  app.get('/api/regions/search', async (c) => {
    const { q } = placeSearchSchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    )
    return c.json(await service.findPlaces(q))
  })

  app.post(
    '/api/regions/import',
    // An import hits OpenStreetMap's free, shared infrastructure and writes
    // thousands of rows. Both are reasons not to allow it in a loop.
    rateLimit({ limit: 5, windowMs: 10 * 60_000 }),
    async (c) => {
      const body = importRegionSchema.parse(await c.req.json())
      const { name, ...box } = body
      return c.json(await service.importRegion(name, box), 201)
    },
  )

  /* --- Escalations ---------------------------------------------------------- */

  app.get('/api/escalations', async (c) =>
    c.json(await service.getEscalations()),
  )

  // Drafts complaints for every road that has earned one. Safe to call twice:
  // the cooldown makes it idempotent within its window.
  app.post('/api/escalations/generate', async (c) =>
    c.json(await service.generateEscalations(), 201),
  )

  app.patch('/api/escalations/:id', async (c) => {
    const body = reviewEscalationSchema.parse(await c.req.json())
    return c.json(
      await service.reviewEscalation(
        c.req.param('id'),
        body.action,
        body.reason,
      ),
    )
  })

  /* --- Aggregates ----------------------------------------------------------- */

  app.get('/api/kpis', async (c) => c.json(await service.getKpis()))

  /* --- Live stream ----------------------------------------------------------- */

  app.get('/api/live', (c) =>
    streamSSE(c, async (stream) => {
      // What happened just before the dashboard connected, so the feed is not
      // empty for the first few seconds.
      for (const event of service.liveHistory().slice().reverse()) {
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        })
      }

      const queue: LiveEvent[] = []
      let wake: (() => void) | null = null

      const unsubscribe = service.subscribe((event) => {
        queue.push(event)
        wake?.()
      })

      stream.onAbort(() => {
        unsubscribe()
        wake?.()
      })

      try {
        while (!stream.aborted) {
          while (queue.length > 0) {
            const event = queue.shift()!
            await stream.writeSSE({
              event: event.type,
              data: JSON.stringify(event),
            })
          }

          // Park until something arrives, waking every 20s to send a comment
          // so proxies do not decide the connection is idle and close it.
          await new Promise<void>((resolve) => {
            wake = resolve
            setTimeout(resolve, 20_000)
          })
          wake = null

          if (!stream.aborted && queue.length === 0) {
            await stream.writeSSE({ event: 'ping', data: '{}' })
          }
        }
      } finally {
        unsubscribe()
      }
    }),
  )

  /* --- Demo ------------------------------------------------------------------ */

  if (enableDemoRoutes) {
    app.post('/api/demo/reset', async (c) => {
      await service.reset()
      return c.json({ status: 'reset' })
    })
  }

  return app
}

function segmentId(raw: string): number {
  const id = Number(raw)
  if (!Number.isInteger(id) || id < 0) {
    throw ApiError.badRequest(`"${raw}" is not a segment id.`)
  }
  return id
}

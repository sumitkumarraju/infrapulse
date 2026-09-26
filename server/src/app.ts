import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { streamSSE } from 'hono/streaming'
import { ZodError } from 'zod'
import type { LiveEvent } from '@shared/contract'
import type { InfraPulseService } from './domain/service.js'
import { ApiError } from './http/errors.js'
import { mintDeviceToken, requireDevice } from './http/auth.js'
import { rateLimit } from './http/rateLimit.js'
import {
  createWorkOrdersSchema,
  ingestSchema,
  photoReportSchema,
  photoStatusSchema,
  projectedQuerySchema,
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
        maxAge: 86_400,
      }),
    )
  }

  /* --- Errors ----------------------------------------------------------- */

  app.onError((error, c) => {
    if (error instanceof ApiError) {
      return c.json(error.toResponse(), error.status)
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

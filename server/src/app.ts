import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { streamSSE } from 'hono/streaming'
import { ZodError } from 'zod'
import type { LiveEvent } from '@shared/contract'
import type { InfraPulseService } from './domain/service.js'
import { ApiError } from './http/errors.js'
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
  quiet?: boolean
}

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

  /* --- Ingest ------------------------------------------------------------- */

  app.post('/api/ingest/bumps', async (c) => {
    const body = ingestSchema.parse(await c.req.json())
    const result = await service.ingestBumps(
      body.deviceId,
      body.tripId,
      body.bumps,
    )
    return c.json(result, 202)
  })

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

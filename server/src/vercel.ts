import { getRequestListener } from '@hono/node-server'
import { createApp } from './app.js'
import { InfraPulseService } from './domain/service.js'
import { EventBus } from './live/EventBus.js'
import { OutboxNotifier } from './escalation/Notifier.js'
import { InMemoryRepository } from './repository/InMemoryRepository.js'
import { PostgresRepository } from './repository/PostgresRepository.js'

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

const databaseUrl = process.env.DATABASE_URL
const isProduction = (process.env.NODE_ENV ?? 'development') === 'production'

// Reuse repository across warm serverless invocations
const repository = databaseUrl
  ? new PostgresRepository(databaseUrl)
  : new InMemoryRepository()

const bus = new EventBus()
const service = new InfraPulseService(repository, bus, new OutboxNotifier())

const app = createApp({
  service,
  corsOrigins: list(process.env.CORS_ORIGINS),
  enableDemoRoutes: process.env.ENABLE_DEMO_ROUTES === 'true',
  deviceTokenSecret:
    process.env.DEVICE_TOKEN_SECRET ?? 'infrapulse-development-secret',
  operatorPassword: process.env.OPERATOR_PASSWORD ?? 'infrapulse-dev',
  sessionSecret:
    process.env.SESSION_SECRET ?? 'infrapulse-development-session-secret',
  requireLogin:
    process.env.REQUIRE_LOGIN === 'true' ||
    (process.env.REQUIRE_LOGIN !== 'false' && isProduction),
  secureCookies: isProduction,
})

// Optional root API info endpoint
app.get('/api', (c) =>
  c.json({
    status: 'ok',
    name: 'InfraPulse API',
    database: databaseUrl ? 'postgres' : 'in-memory',
    time: new Date().toISOString(),
  }),
)

const nodeListener = getRequestListener(app.fetch)

// Unified handler: seamlessly handles Node (req, res) from Vercel Node runtime
// AND Web standard Request/Response from Fetch / Edge runtime
const handler = (req: any, res?: any) => {
  if (res && typeof res.setHeader === 'function') {
    return nodeListener(req, res)
  }
  const rawUrl = typeof req.url === 'string' ? req.url : ''
  const url = new URL(rawUrl, 'http://localhost')
  if (!url.pathname.startsWith('/api')) {
    url.pathname = `/api${url.pathname}`
    return app.fetch(new Request(url.toString(), req))
  }
  return app.fetch(req instanceof Request ? req : new Request(url.toString(), req))
}

export default handler
export const GET = handler
export const POST = handler
export const PATCH = handler
export const PUT = handler
export const DELETE = handler
export const OPTIONS = handler

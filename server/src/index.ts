import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { InfraPulseService } from './domain/service.js'
import { env, isProduction } from './env.js'
import { EventBus } from './live/EventBus.js'
import { InMemoryRepository } from './repository/InMemoryRepository.js'

/*
 * Entry point.
 *
 * The one line to change when a database arrives is the repository below:
 *
 *   const repository = new PostgresRepository(env.databaseUrl)
 *
 * Nothing else in the server knows or cares where the rows come from.
 */
const repository = new InMemoryRepository()
const bus = new EventBus()
const service = new InfraPulseService(repository, bus)

const app = createApp({
  service,
  corsOrigins: env.corsOrigins,
  enableDemoRoutes: env.enableDemoRoutes,
})

if (isProduction && !env.databaseUrl) {
  // Losing every road score on a restart is fine for a demo and unacceptable
  // for a deployment, so say so loudly rather than discovering it later.
  console.warn(
    'WARNING: running in production with the in-memory repository. All data is lost on restart.',
  )
}

serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`InfraPulse API listening on http://localhost:${info.port}`)
  console.log(`  storage:  in-memory (no database configured)`)
  console.log(`  cors:     ${env.corsOrigins.join(', ') || 'same-origin only'}`)
  console.log(`  demo:     ${env.enableDemoRoutes ? 'enabled' : 'disabled'}`)
})

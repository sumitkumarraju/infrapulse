import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { InfraPulseService } from './domain/service.js'
import { env, isProduction } from './env.js'
import { EventBus } from './live/EventBus.js'
import { OutboxNotifier } from './escalation/Notifier.js'
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
const service = new InfraPulseService(repository, bus, new OutboxNotifier())

const app = createApp({
  service,
  corsOrigins: env.corsOrigins,
  enableDemoRoutes: env.enableDemoRoutes,
  deviceTokenSecret: env.deviceTokenSecret,
  operatorPassword: env.operatorPassword,
  sessionSecret: env.sessionSecret,
  // A cookie marked Secure is dropped over plain http, which would make local
  // development impossible to sign in to.
  secureCookies: isProduction,
})

if (
  isProduction &&
  (env.operatorPassword === 'infrapulse-dev' ||
    env.sessionSecret.startsWith('infrapulse-development'))
) {
  console.error(
    'FATAL: OPERATOR_PASSWORD and SESSION_SECRET must be set in production. Refusing to start with the development defaults.',
  )
  process.exit(1)
}

if (
  isProduction &&
  env.deviceTokenSecret.startsWith('infrapulse-development')
) {
  // Shipping the default would let anyone mint a device token, which is the
  // one thing the token exists to prevent. Refuse rather than pretend.
  console.error(
    'FATAL: DEVICE_TOKEN_SECRET is unset. Refusing to start in production with the development secret.',
  )
  process.exit(1)
}

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
  console.log(
    `  operator: password ${env.operatorPassword === 'infrapulse-dev' ? 'is the DEVELOPMENT default' : 'configured'}`,
  )
  console.log(
    `  ingest:   device token required${
      env.deviceTokenSecret.startsWith('infrapulse-development')
        ? ' (DEVELOPMENT SECRET)'
        : ''
    }`,
  )
})

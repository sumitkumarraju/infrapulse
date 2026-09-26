/* Configuration, read once at startup so a missing value fails immediately
 * rather than on the first request that happens to need it. */

import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/*
 * Load .env before anything reads process.env.
 *
 * Node does not do this on its own, so without it a correctly filled-in .env
 * changes nothing and the server quietly keeps using the in-memory store —
 * the most confusing possible failure, because everything still works.
 *
 * The repository root is checked first, since that is where .env.example sits.
 * Real environment variables always win: on a host, the platform sets them and
 * there is no file.
 */
const HERE = dirname(fileURLToPath(import.meta.url))
for (const candidate of [
  resolve(HERE, '../../.env'),
  resolve(HERE, '../.env'),
]) {
  if (!existsSync(candidate)) continue
  try {
    process.loadEnvFile(candidate)
    console.log(`Loaded configuration from ${candidate}`)
  } catch (error) {
    console.warn(`Could not read ${candidate}: ${(error as Error).message}`)
  }
  break
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

export const env = {
  port: Number(process.env.PORT ?? 8787),
  nodeEnv: process.env.NODE_ENV ?? 'development',

  /** Where the browser app is served from, for CORS. */
  corsOrigins: list(
    process.env.CORS_ORIGINS ?? 'http://localhost:5173,http://localhost:4173',
  ),

  /** Demo endpoints (reset) — off unless asked for. */
  enableDemoRoutes: process.env.ENABLE_DEMO_ROUTES === 'true',

  /**
   * Signs device tokens for the ingest endpoint. The development default is
   * fine locally and must not survive to a deployment: anyone who knows it can
   * mint tokens, which is the whole thing the token prevents. index.ts refuses
   * to start in production without a real one.
   */
  deviceTokenSecret:
    process.env.DEVICE_TOKEN_SECRET ?? 'infrapulse-development-secret',

  /**
   * The engineer dashboard's password, and the secret that signs its session
   * cookies. One shared operator role, because there is no users table yet.
   * index.ts refuses to start in production without both.
   */
  operatorPassword: process.env.OPERATOR_PASSWORD ?? 'infrapulse-dev',
  sessionSecret:
    process.env.SESSION_SECRET ?? 'infrapulse-development-session-secret',

  /**
   * Reserved for the Postgres implementation. Deliberately unused today: the
   * server runs entirely on InMemoryRepository, and nothing here opens a
   * connection. See server/db/schema.sql and README.md.
   */
  databaseUrl: process.env.DATABASE_URL ?? null,
} as const

export const isProduction = env.nodeEnv === 'production'

/* Configuration, read once at startup so a missing value fails immediately
 * rather than on the first request that happens to need it. */

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
   * Reserved for the Postgres implementation. Deliberately unused today: the
   * server runs entirely on InMemoryRepository, and nothing here opens a
   * connection. See server/db/schema.sql and README.md.
   */
  databaseUrl: process.env.DATABASE_URL ?? null,
} as const

export const isProduction = env.nodeEnv === 'production'

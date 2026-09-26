import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import type { MiddlewareHandler } from 'hono'
import { ApiError } from './errors.js'

/* Operator sessions for the engineer routes.
 *
 * Ingest is guarded by a device token, which establishes only that two
 * requests came from the same install — deliberately not a login, because a
 * driver should not need an account to report a pothole. The engineer side is
 * the opposite: reading every road's condition, moving work orders and
 * approving complaints to a public authority are all things that should
 * require being let in.
 *
 * One shared operator role, no user table, because there is no database. That
 * is a real limitation and not a pretence: there is no per-person audit trail,
 * and revoking access means rotating the secret for everyone. Both are fixed by
 * the same thing — the users table that arrives with Postgres.
 *
 * The session is a signed cookie rather than a bearer token in JavaScript's
 * reach: HttpOnly keeps it away from any script that manages to run on the
 * page, which matters more here than the convenience of reading it.
 */

const COOKIE = 'infrapulse_session'
const SESSION_VERSION = 'v1'
/** A works shift, roughly. Long enough not to interrupt, short enough to expire. */
export const SESSION_TTL_SECONDS = 12 * 60 * 60

export interface OperatorSession {
  id: string
  expiresAt: number
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

export function mintSession(secret: string): { token: string; maxAge: number } {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS
  const payload = `${SESSION_VERSION}.${randomUUID()}.${expiresAt}`
  return {
    token: `${payload}.${sign(payload, secret)}`,
    maxAge: SESSION_TTL_SECONDS,
  }
}

export function verifySession(
  token: string,
  secret: string,
): OperatorSession | null {
  const parts = token.split('.')
  if (parts.length !== 4) return null

  const [version, id, expiresRaw, signature] = parts
  if (version !== SESSION_VERSION) return null

  const expected = sign(`${version}.${id}.${expiresRaw}`, secret)
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)

  // Length first: timingSafeEqual throws on a mismatch, and `===` would leak
  // how much of the signature was correct.
  if (a.length !== b.length) return null
  if (!timingSafeEqual(a, b)) return null

  const expiresAt = Number(expiresRaw)
  if (!Number.isFinite(expiresAt) || expiresAt * 1000 < Date.now()) return null

  return { id, expiresAt }
}

/** Compares a submitted password without revealing where it diverged. */
export function passwordMatches(submitted: string, expected: string): boolean {
  // Hash both sides first so the comparison is fixed-length regardless of what
  // was submitted — otherwise the length itself is a signal.
  const a = createHmac('sha256', 'infrapulse-password-compare')
    .update(submitted)
    .digest()
  const b = createHmac('sha256', 'infrapulse-password-compare')
    .update(expected)
    .digest()
  return timingSafeEqual(a, b)
}

export function issueSessionCookie(
  c: Parameters<MiddlewareHandler>[0],
  secret: string,
  secure: boolean,
): void {
  const { token, maxAge } = mintSession(secret)
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    /*
     * Lax locally, None once the cookie is Secure.
     *
     * Deployed, the dashboard and the API sit on different domains — a Vercel
     * app calling a server hosted elsewhere — which makes every API call
     * cross-site. A Lax cookie is not sent on cross-site fetch at all, so
     * signing in would appear to succeed and every subsequent request would
     * arrive anonymous. None is what actually works there, and it requires
     * Secure, which production has and plain-http development does not.
     *
     * The CSRF that Lax normally guards against is covered here by CORS: the
     * allowed origins are an explicit list rather than `*`, and every mutation
     * sends JSON, which forces a preflight an unlisted origin cannot pass.
     */
    sameSite: secure ? 'None' : 'Lax',
    secure,
    path: '/',
    maxAge,
  })
}

export function clearSessionCookie(c: Parameters<MiddlewareHandler>[0]): void {
  deleteCookie(c, COOKIE, { path: '/' })
}

export function currentSession(
  c: Parameters<MiddlewareHandler>[0],
  secret: string,
): OperatorSession | null {
  const token = getCookie(c, COOKIE)
  return token ? verifySession(token, secret) : null
}

declare module 'hono' {
  interface ContextVariableMap {
    operator: OperatorSession
  }
}

/** Refuses anything that is not a logged-in operator. */
export function requireOperator(secret: string): MiddlewareHandler {
  return async (c, next) => {
    const session = currentSession(c, secret)
    if (!session) {
      throw new ApiError(
        401,
        'login_required',
        'Sign in to view or change road data.',
      )
    }
    c.set('operator', session)
    await next()
  }
}

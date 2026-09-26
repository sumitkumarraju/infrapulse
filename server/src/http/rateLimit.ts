import type { MiddlewareHandler } from 'hono'
import { ApiError } from './errors.js'

/* Rate limiting.
 *
 * A trip posts batches, not a stream, so the honest shape of the limit is two
 * numbers: how often a device may call, and how many readings it may submit in
 * a window. A single stuck sensor firing continuously is the realistic failure
 * — more likely than an attacker — and it should be throttled rather than
 * allowed to bury one road under thousands of phantom impacts.
 *
 * In memory, so the limit is per process: two instances would each allow the
 * full budget. That is the same boundary as the event bus, and it moves to
 * Redis at the same time.
 */

interface Bucket {
  /** Tokens remaining in the current window. */
  tokens: number
  /** When the window resets, as an epoch millisecond. */
  resetAt: number
}

export interface RateLimitOptions {
  /** Requests allowed per window. */
  limit: number
  windowMs: number
  /** What to count requests against. Defaults to the client address. */
  key?: (c: Parameters<MiddlewareHandler>[0]) => string
  /** Extra weight for one request, e.g. the number of readings it carries. */
  cost?: (c: Parameters<MiddlewareHandler>[0]) => Promise<number> | number
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>()
  private lastSweep = Date.now()

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Returns false when the caller has run out of budget. */
  take(
    key: string,
    cost = 1,
  ): { ok: boolean; remaining: number; resetAt: number } {
    this.sweep()

    const now = Date.now()
    const existing = this.buckets.get(key)

    if (!existing || existing.resetAt <= now) {
      const bucket = { tokens: this.limit - cost, resetAt: now + this.windowMs }
      this.buckets.set(key, bucket)
      return {
        ok: bucket.tokens >= 0,
        remaining: Math.max(0, bucket.tokens),
        resetAt: bucket.resetAt,
      }
    }

    if (existing.tokens - cost < 0) {
      return { ok: false, remaining: 0, resetAt: existing.resetAt }
    }

    existing.tokens -= cost
    return {
      ok: true,
      remaining: existing.tokens,
      resetAt: existing.resetAt,
    }
  }

  /** Drops expired buckets so a long-running process does not grow forever. */
  private sweep(): void {
    const now = Date.now()
    if (now - this.lastSweep < this.windowMs) return
    this.lastSweep = now
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key)
    }
  }

  reset(): void {
    this.buckets.clear()
  }
}

function clientKey(c: Parameters<MiddlewareHandler>[0]): string {
  // Behind a proxy this is the proxy unless it forwards the header. Worth
  // knowing before trusting it for anything but coarse throttling.
  return (
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    c.req.header('x-real-ip') ??
    'unknown'
  )
}

export function rateLimit(options: RateLimitOptions): MiddlewareHandler {
  const limiter = new RateLimiter(options.limit, options.windowMs)

  return async (c, next) => {
    const key = options.key ? options.key(c) : clientKey(c)
    const cost = options.cost ? await options.cost(c) : 1
    const result = limiter.take(key, cost)

    c.header('X-RateLimit-Limit', String(options.limit))
    c.header('X-RateLimit-Remaining', String(result.remaining))
    c.header('X-RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)))

    if (!result.ok) {
      const seconds = Math.max(
        1,
        Math.ceil((result.resetAt - Date.now()) / 1000),
      )
      c.header('Retry-After', String(seconds))
      throw new ApiError(
        429,
        'rate_limited',
        `Too many readings. Try again in ${seconds}s.`,
      )
    }

    await next()
  }
}

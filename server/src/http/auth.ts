import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'
import { ApiError } from './errors.js'

/* Device tokens for the ingest endpoint.
 *
 * `/api/ingest/bumps` is the one endpoint an untrusted device posts to, and
 * what it writes moves road scores and therefore where money gets spent. Before
 * this, the device identifier came from the request body, which meant anyone
 * could claim to be any device — or a thousand of them — and drive a road's
 * score to zero from a laptop.
 *
 * A device registers once and gets a signed token; the identifier is then read
 * from the signature rather than from the body. This is not authentication of a
 * person and is not meant to be: there are no accounts here, and a driver
 * should not need one to report a pothole. It establishes only that two
 * requests came from the same install, which is what rate limiting needs to
 * mean anything.
 *
 * Deliberately stateless — an HMAC, no session table — because there is no
 * database yet. The cost is that a token cannot be revoked without rotating the
 * secret for everyone. When the devices table exists, that is the thing to fix.
 */

const TOKEN_VERSION = 'v1'

export interface DeviceIdentity {
  deviceId: string
}

function sign(deviceId: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(`${TOKEN_VERSION}:${deviceId}`)
    .digest('base64url')
}

/** Issues a token for a freshly generated device id. */
export function mintDeviceToken(secret: string): {
  deviceId: string
  token: string
} {
  // The server generates the id rather than accepting one, so a caller cannot
  // choose to collide with an existing device.
  const deviceId = randomUUID()
  return {
    deviceId,
    token: `${TOKEN_VERSION}.${deviceId}.${sign(deviceId, secret)}`,
  }
}

export function verifyDeviceToken(
  token: string,
  secret: string,
): DeviceIdentity | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null

  const [version, deviceId, signature] = parts
  if (version !== TOKEN_VERSION || !deviceId) return null

  const expected = sign(deviceId, secret)
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)

  // Length check first: timingSafeEqual throws on a mismatch, and comparing
  // with === would leak how much of the signature was right.
  if (a.length !== b.length) return null
  if (!timingSafeEqual(a, b)) return null

  return { deviceId }
}

declare module 'hono' {
  interface ContextVariableMap {
    device: DeviceIdentity
  }
}

/**
 * Requires a valid device token and puts the identity on the context.
 *
 * Handlers read `c.get('device').deviceId` — never a device id from the body,
 * which is the whole point.
 */
export function requireDevice(secret: string): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header('Authorization') ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''

    if (!token) {
      throw new ApiError(
        401,
        'device_token_required',
        'Register this device first, then send its token as a bearer token.',
      )
    }

    const identity = verifyDeviceToken(token, secret)
    if (!identity) {
      throw new ApiError(
        401,
        'device_token_invalid',
        'That device token is not valid. Register again.',
      )
    }

    c.set('device', identity)
    await next()
  }
}

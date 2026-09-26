import { isLive } from '@/data'
import type { DetectedBump } from '@/features/driver/sensors/useBumpDetection'

/* Sending detected impacts to the API.
 *
 * Batched rather than one request per pothole: a rough kilometre can produce a
 * dozen hits, and a phone on a patchy mobile connection should not be opening a
 * connection for each. Impacts are buffered and flushed on a size or time
 * threshold, and whatever is left goes when the trip stops.
 */

const FLUSH_SIZE = 10
const FLUSH_INTERVAL_MS = 15_000
const TOKEN_KEY = 'infrapulse-device-token'

/**
 * The device's signed token, minted by the server on first use.
 *
 * The identifier inside it is anonymous — not a person, not an account, not a
 * phone number. The server needs only to tell two installs apart so it can rate
 * limit and spot a faulty sensor, and it issues the identifier itself so that a
 * client cannot claim to be someone else's device.
 */
function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    // Private mode or storage disabled: a per-session token still works.
    return null
  }
}

function writeToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token)
  } catch {
    // Not fatal — the in-memory copy lasts as long as the trip does.
  }
}

export class BumpUploader {
  private buffer: DetectedBump[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly tripId = crypto.randomUUID()
  private readonly baseUrl: string | null
  private token: string | null = readToken()
  /** In flight registration, so a burst of bumps does not register twice. */
  private registering: Promise<string | null> | null = null

  constructor() {
    const url = import.meta.env.VITE_API_URL
    this.baseUrl = isLive && url ? String(url).replace(/\/$/, '') : null
  }

  /** True when there is a server to send to at all. */
  get enabled(): boolean {
    return this.baseUrl !== null
  }

  add(bump: DetectedBump): void {
    // Without a position the server cannot match it to a road, so there is
    // nothing useful to send.
    if (!this.enabled || !bump.position) return

    this.buffer.push(bump)

    if (this.buffer.length >= FLUSH_SIZE) {
      void this.flush()
      return
    }

    this.timer ??= setTimeout(() => void this.flush(), FLUSH_INTERVAL_MS)
  }

  /** Registers this install once and remembers the token it is given. */
  private async ensureToken(): Promise<string | null> {
    if (this.token) return this.token
    this.registering ??= (async () => {
      try {
        const response = await fetch(`${this.baseUrl}/api/devices/register`, {
          method: 'POST',
        })
        if (!response.ok) return null
        const body = (await response.json()) as { token: string }
        this.token = body.token
        writeToken(body.token)
        return body.token
      } catch {
        return null
      } finally {
        this.registering = null
      }
    })()
    return this.registering
  }

  /** Sends whatever is buffered. Safe to call when empty. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }

    if (!this.enabled || this.buffer.length === 0) return

    // Taken before the await so impacts detected mid-request are not lost.
    const batch = this.buffer
    this.buffer = []

    const body = JSON.stringify({
      tripId: this.tripId,
      bumps: batch.map((bump) => ({
        at: new Date(bump.at).toISOString(),
        lon: bump.position![0],
        lat: bump.position![1],
        magnitude: Math.round(bump.magnitude * 100) / 100,
        speedMs: Math.round((bump.speedMs ?? 0) * 100) / 100,
      })),
    })

    try {
      const send = async (token: string | null) =>
        fetch(`${this.baseUrl}/api/ingest/bumps`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body,
        })

      let response = await send(await this.ensureToken())

      // A stored token stops being valid if the server's secret rotated.
      // Register once more rather than failing every trip from then on.
      if (response.status === 401) {
        this.token = null
        response = await send(await this.ensureToken())
      }

      // Throttled: the impacts are already counted locally, and re-queuing
      // them would only push harder against a limit that is already saying no.
      if (response.status === 429) return

      if (!response.ok) throw new Error(String(response.status))
    } catch {
      // A failed upload must never interrupt a drive. The impacts are already
      // counted locally; putting them back at the front of the queue lets the
      // next flush retry them.
      this.buffer = [...batch, ...this.buffer]
    }
  }
}

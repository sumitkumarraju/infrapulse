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
const DEVICE_KEY = 'infrapulse-device-id'

/**
 * An anonymous per-install identifier.
 *
 * Not a person, not an account, not a phone number: the server only needs to
 * tell two devices apart so it can rate-limit and spot a faulty sensor. It is
 * generated locally and never leaves the device except as this opaque string.
 */
export function deviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_KEY)
    if (existing) return existing
    const fresh = crypto.randomUUID()
    localStorage.setItem(DEVICE_KEY, fresh)
    return fresh
  } catch {
    // Private mode, or storage disabled: a per-session id still works.
    return crypto.randomUUID()
  }
}

export class BumpUploader {
  private buffer: DetectedBump[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly tripId = crypto.randomUUID()
  private readonly baseUrl: string | null

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

    try {
      await fetch(`${this.baseUrl}/api/ingest/bumps`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId: deviceId(),
          tripId: this.tripId,
          bumps: batch.map((bump) => ({
            at: new Date(bump.at).toISOString(),
            lon: bump.position![0],
            lat: bump.position![1],
            magnitude: Math.round(bump.magnitude * 100) / 100,
            speedMs: Math.round((bump.speedMs ?? 0) * 100) / 100,
          })),
        }),
      })
    } catch {
      // A failed upload must never interrupt a drive. The impacts are already
      // counted locally; putting them back at the front of the queue lets the
      // next flush retry them.
      this.buffer = [...batch, ...this.buffer]
    }
  }
}

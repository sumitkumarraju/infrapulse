/* The fake live stream (CLAUDE.md 4.4).
 *
 * Two sources feed the same callback: a simulated stream of bumps weighted
 * toward the worst roads, and — when the driver screen is open in another tab
 * of the same browser — real bumps detected by the phone's accelerometer,
 * relayed over BroadcastChannel. The dashboard cannot tell them apart except by
 * the `real` flag, which is the point.
 */

import seedrandom from 'seedrandom'
import { PHOTO_BOXES } from '@/data/mock/photoBoxes'
import type { LiveEvent, Segment, SegmentStatus } from '@/data/types'

export const CHANNEL_NAME = 'infrapulse'

const MIN_GAP_MS = 3000
const MAX_GAP_MS = 7000

export interface LiveStreamOptions {
  segments: Segment[]
  statuses: SegmentStatus[]
  /** 1 = real time. Demo mode raises this. */
  speed?: number
}

export class MockLiveStream {
  private listeners = new Set<(e: LiveEvent) => void>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private channel: BroadcastChannel | null = null
  private rng = seedrandom('infrapulse-demo:live')
  private weighted: { segment: Segment; status: SegmentStatus; w: number }[] = []
  private totalWeight = 0
  private speed: number
  private running = false

  constructor(options: LiveStreamOptions) {
    this.speed = options.speed ?? 1
    const byId = new Map(options.statuses.map((s) => [s.id, s]))

    for (const segment of options.segments) {
      const status = byId.get(segment.id)
      if (!status) continue
      // Bumps come from bad roads: a cubic weight makes the pulse rings
      // cluster where the map is already red, which is what sells it.
      const w = (1 - status.score / 100) ** 3 + 0.004
      this.weighted.push({ segment, status, w })
      this.totalWeight += w
    }
  }

  setSpeed(speed: number) {
    this.speed = Math.max(0.25, speed)
  }

  subscribe(cb: (e: LiveEvent) => void): () => void {
    this.listeners.add(cb)
    if (!this.running) this.start()

    return () => {
      this.listeners.delete(cb)
      if (this.listeners.size === 0) this.stop()
    }
  }

  /** Driver screens call this to push a real detected bump to any dashboard. */
  static broadcast(event: LiveEvent) {
    if (typeof BroadcastChannel === 'undefined') return
    const channel = new BroadcastChannel(CHANNEL_NAME)
    channel.postMessage(event)
    channel.close()
  }

  private start() {
    this.running = true

    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(CHANNEL_NAME)
      this.channel.onmessage = (message) => {
        const event = message.data as LiveEvent
        if (event && typeof event.type === 'string') this.emit(event)
      }
    }

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibility)
    }

    this.schedule()
  }

  private stop() {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.channel?.close()
    this.channel = null
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibility)
    }
  }

  private onVisibility = () => {
    // Nothing accumulates while the tab is hidden; the feed resumes live
    // rather than replaying a backlog the moment it is looked at again.
    if (document.hidden) {
      if (this.timer) clearTimeout(this.timer)
      this.timer = null
    } else if (this.running && !this.timer) {
      this.schedule()
    }
  }

  private schedule() {
    if (!this.running) return
    const gap =
      (MIN_GAP_MS + this.rng() * (MAX_GAP_MS - MIN_GAP_MS)) / this.speed

    this.timer = setTimeout(() => {
      this.emit(this.nextEvent())
      this.schedule()
    }, gap)
  }

  private pick() {
    let r = this.rng() * this.totalWeight
    for (const entry of this.weighted) {
      r -= entry.w
      if (r <= 0) return entry
    }
    return this.weighted[this.weighted.length - 1]
  }

  private nextEvent(): LiveEvent {
    const { segment, status } = this.pick()
    const at = new Date().toISOString()
    const roll = this.rng()

    // Rarely, a segment crosses into the red — the only event that interrupts.
    if (roll > 0.97 && status.band !== 'good') {
      return {
        type: 'alert',
        segmentId: segment.id,
        at,
        message: `${segment.name} crossed into ${status.band === 'critical' ? 'critical' : 'watch'}`,
        band: status.band,
      }
    }

    if (roll > 0.88) {
      const imageIndex = Math.floor(this.rng() * PHOTO_BOXES.length)
      return {
        type: 'photo',
        segmentId: segment.id,
        at,
        report: {
          id: `PR-LIVE-${Math.floor(this.rng() * 1e6)}`,
          segmentId: segment.id,
          segmentName: segment.name,
          imageUrl: `/mock-photos/road-${imageIndex + 1}.svg`,
          label: 'pothole',
          confidence: Math.round((0.66 + this.rng() * 0.32) * 100) / 100,
          box: PHOTO_BOXES[imageIndex],
          severity: status.score < 40 ? 'severe' : 'moderate',
          status: 'pending',
          createdAt: at,
          reporter: 'Live report',
        },
      }
    }

    return {
      type: 'bump',
      segmentId: segment.id,
      at,
      magnitude: Math.round((6 + (1 - status.score / 100) * 14) * 10) / 10,
      position: segment.center,
    }
  }

  private emit(event: LiveEvent) {
    for (const listener of this.listeners) listener(event)
  }
}

import type { LiveEvent } from '@shared/contract'

/**
 * Fan-out for live events, in process.
 *
 * Every dashboard holds an SSE connection and receives what any phone reports.
 * This works for one server; the moment there are two, a subscriber attached to
 * instance A will not see an ingest that landed on instance B, and this class
 * becomes a thin wrapper over Postgres LISTEN/NOTIFY or Redis pub/sub. The
 * interface is kept narrow so that swap stays local.
 */
export class EventBus {
  private subscribers = new Set<(event: LiveEvent) => void>()
  /** Kept so a dashboard that connects mid-demo is not staring at nothing. */
  private recent: LiveEvent[] = []
  private readonly historyLimit = 30

  subscribe(listener: (event: LiveEvent) => void): () => void {
    this.subscribers.add(listener)
    return () => {
      this.subscribers.delete(listener)
    }
  }

  publish(event: LiveEvent): void {
    this.recent = [event, ...this.recent].slice(0, this.historyLimit)
    for (const listener of this.subscribers) {
      try {
        listener(event)
      } catch {
        // One broken connection must not stop the others from being told.
      }
    }
  }

  /** Newest first. */
  history(): LiveEvent[] {
    return this.recent
  }

  get subscriberCount(): number {
    return this.subscribers.size
  }
}

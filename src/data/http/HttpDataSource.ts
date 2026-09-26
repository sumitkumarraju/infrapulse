import type { DataSource } from '@/data/DataSource'
import type { Escalation } from '@shared/escalation'
import type {
  DailyScore,
  ForecastPoint,
  Kpis,
  LiveEvent,
  PhotoReport,
  PhotoStatus,
  Segment,
  SegmentStatus,
  WorkOrder,
} from '@/data/types'

/**
 * The real implementation: the same interface the mock satisfies, backed by the
 * API in `server/`.
 *
 * This is not wired in by default. `src/data/index.ts` picks it only when
 * `VITE_API_URL` is set, so `npm run dev` on its own still runs entirely in the
 * browser with no server to start.
 */
export class HttpDataSource implements DataSource {
  private readonly baseUrl: string

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      // The operator session is an HttpOnly cookie; without this the browser
      // withholds it cross-origin and every call looks anonymous.
      credentials: 'include',
      headers: {
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    })

    if (!response.ok) {
      // The API's error envelope is `{ error: { code, message } }`, and its
      // message is written to be shown to a person. Surface it rather than
      // replacing it with a status code.
      let message = `Request to ${path} failed (${response.status})`
      try {
        const body = (await response.json()) as {
          error?: { message?: string }
        }
        if (body.error?.message) message = body.error.message
      } catch {
        // Not JSON — keep the generic message.
      }
      throw new Error(message)
    }

    return (await response.json()) as T
  }

  getSegments(): Promise<Segment[]> {
    return this.request('/api/segments')
  }

  getSegmentStatus(): Promise<SegmentStatus[]> {
    return this.request('/api/segments/status')
  }

  getSegmentHistory(id: number): Promise<DailyScore[]> {
    return this.request(`/api/segments/${id}/history`)
  }

  getForecast(id: number): Promise<ForecastPoint[]> {
    return this.request(`/api/segments/${id}/forecast`)
  }

  getPhotoReports(): Promise<PhotoReport[]> {
    return this.request('/api/reports')
  }

  setPhotoStatus(id: string, status: PhotoStatus): Promise<PhotoReport> {
    return this.request(`/api/reports/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    })
  }

  getWorkOrders(): Promise<WorkOrder[]> {
    return this.request('/api/work-orders')
  }

  updateWorkOrder(id: string, patch: Partial<WorkOrder>): Promise<WorkOrder> {
    // The server owns which transitions are legal, so only the intent is sent.
    return this.request(`/api/work-orders/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: patch.status,
        assignee: patch.assignee,
      }),
    })
  }

  createWorkOrders(segmentIds: number[]): Promise<WorkOrder[]> {
    return this.request('/api/work-orders', {
      method: 'POST',
      body: JSON.stringify({ segmentIds }),
    })
  }

  getEscalations(): Promise<Escalation[]> {
    return this.request('/api/escalations')
  }

  generateEscalations(): Promise<{
    created: Escalation[]
    skipped: { segmentId: number; reason: string }[]
  }> {
    return this.request('/api/escalations/generate', { method: 'POST' })
  }

  reviewEscalation(
    id: string,
    action: 'approve' | 'send' | 'dismiss',
    reason?: string,
  ): Promise<Escalation> {
    return this.request(`/api/escalations/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ action, reason }),
    })
  }

  getKpis(): Promise<Kpis> {
    return this.request('/api/kpis')
  }

  async getProjectedScores(dayOffset: number): Promise<Map<number, number>> {
    const rows = await this.request<{ id: number; score: number }[]>(
      `/api/segments/projected?days=${dayOffset}`,
    )
    return new Map(rows.map((row) => [row.id, row.score]))
  }

  /**
   * Server-sent events rather than a WebSocket: the traffic is one-way, SSE
   * reconnects on its own, and it survives proxies that mishandle upgrades.
   */
  subscribeLive(cb: (e: LiveEvent) => void): () => void {
    const source = new EventSource(`${this.baseUrl}/api/live`)

    const handle = (event: MessageEvent<string>) => {
      try {
        cb(JSON.parse(event.data) as LiveEvent)
      } catch {
        // A malformed frame is not worth tearing the stream down for.
      }
    }

    for (const type of ['bump', 'photo', 'alert']) {
      source.addEventListener(type, handle as EventListener)
    }

    return () => source.close()
  }

  async resetDemo(): Promise<void> {
    // Only mounted when the server runs with ENABLE_DEMO_ROUTES=true.
    await this.request('/api/demo/reset', { method: 'POST' })
  }
}

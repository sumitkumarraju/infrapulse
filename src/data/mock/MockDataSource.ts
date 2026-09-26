import type { DataSource } from '@/data/DataSource'
import {
  computeKpis,
  estimateCostInr,
  forecastFor,
  generatePhotoReports,
  generateWorkOrders,
  segmentsFromGeoJson,
  simulateSegment,
  statusFor,
  type SegmentSim,
} from '@/data/mock/generate'
import { MockLiveStream } from '@/data/mock/live'
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
import { useDemoStore } from '@/store/demoStore'

/** Bumps already logged today before the page opened. Seeded, not random. */
const BASE_BUMPS_TODAY = 412

interface Dataset {
  segments: Segment[]
  sims: Map<number, SegmentSim>
  statuses: SegmentStatus[]
  photos: PhotoReport[]
  workOrders: WorkOrder[]
  stream: MockLiveStream
}

export class MockDataSource implements DataSource {
  private dataset: Promise<Dataset> | null = null

  /** Built once, then shared. Every screen reads the same objects. */
  private load(): Promise<Dataset> {
    this.dataset ??= this.build()
    return this.dataset
  }

  private async build(): Promise<Dataset> {
    const response = await fetch('/data/segments.geojson')
    if (!response.ok) {
      throw new Error(
        'segments.geojson is missing — run `npm run fetch-roads` once.',
      )
    }

    const segments = segmentsFromGeoJson(await response.json())
    const sims = new Map<number, SegmentSim>()
    const scores = new Map<number, number>()

    for (const segment of segments) {
      const sim = simulateSegment(segment)
      sims.set(segment.id, sim)
      scores.set(segment.id, sim.history[sim.history.length - 1].score)
    }

    // Photos come first: they contribute a penalty to the score breakdown.
    const photos = generatePhotoReports(segments, scores)
    const photoCounts = new Map<number, number>()
    for (const photo of photos) {
      photoCounts.set(
        photo.segmentId,
        (photoCounts.get(photo.segmentId) ?? 0) + 1,
      )
    }

    const statuses = segments.map((segment) =>
      statusFor(
        segment,
        sims.get(segment.id)!,
        photoCounts.get(segment.id) ?? 0,
      ),
    )

    const workOrders = generateWorkOrders(segments, statuses)
    const stream = new MockLiveStream({ segments, statuses })

    return { segments, sims, statuses, photos, workOrders, stream }
  }

  async getSegments(): Promise<Segment[]> {
    return (await this.load()).segments
  }

  async getSegmentStatus(): Promise<SegmentStatus[]> {
    return (await this.load()).statuses
  }

  async getSegmentHistory(id: number): Promise<DailyScore[]> {
    const { sims } = await this.load()
    return sims.get(id)?.history ?? []
  }

  async getForecast(id: number): Promise<ForecastPoint[]> {
    const { sims } = await this.load()
    const sim = sims.get(id)
    return sim ? forecastFor(sim.history) : []
  }

  async getPhotoReports(): Promise<PhotoReport[]> {
    const { photos } = await this.load()
    const overrides = useDemoStore.getState().photoStatuses
    return photos.map((photo) =>
      overrides[photo.id] ? { ...photo, status: overrides[photo.id] } : photo,
    )
  }

  async setPhotoStatus(id: string, status: PhotoStatus): Promise<PhotoReport> {
    useDemoStore.getState().setPhotoStatus(id, status)
    const photos = await this.getPhotoReports()
    const updated = photos.find((p) => p.id === id)
    if (!updated) throw new Error(`No photo report ${id}`)
    return updated
  }

  async getWorkOrders(): Promise<WorkOrder[]> {
    const { workOrders } = await this.load()
    const { workOrderPatches, createdWorkOrders } = useDemoStore.getState()

    return [
      ...workOrders.map((order) =>
        workOrderPatches[order.id]
          ? { ...order, ...workOrderPatches[order.id] }
          : order,
      ),
      ...createdWorkOrders,
    ]
  }

  async updateWorkOrder(
    id: string,
    patch: Partial<WorkOrder>,
  ): Promise<WorkOrder> {
    const store = useDemoStore.getState()

    // Verifying a repair is what produces the before/after bump rate the
    // kanban celebrates, so fill it in here rather than in the component.
    if (patch.status === 'verified' && patch.bumpRateAfter === undefined) {
      const current = (await this.getWorkOrders()).find((w) => w.id === id)
      if (current) {
        patch = {
          ...patch,
          bumpRateAfter: Math.round(current.bumpRateBefore * 0.14 * 10) / 10,
        }
      }
    }

    if (patch.status) store.moveWorkOrder(id, patch.status)
    store.patchWorkOrder(id, patch)

    const updated = (await this.getWorkOrders()).find((w) => w.id === id)
    if (!updated) throw new Error(`No work order ${id}`)
    return updated
  }

  async createWorkOrders(segmentIds: number[]): Promise<WorkOrder[]> {
    const { segments, statuses } = await this.load()
    const existing = await this.getWorkOrders()
    const byId = new Map(segments.map((s) => [s.id, s]))
    const statusById = new Map(statuses.map((s) => [s.id, s]))

    // Never open a second order on a segment that already has one live.
    const alreadyOpen = new Set(
      existing.filter((w) => w.status !== 'verified').map((w) => w.segmentId),
    )

    const now = new Date().toISOString()
    let counter = existing.length

    const created = segmentIds
      .filter((id) => byId.has(id) && !alreadyOpen.has(id))
      .map((id) => {
        const segment = byId.get(id)!
        const status = statusById.get(id)
        const { costInr, repairType } = estimateCostInr(
          segment,
          status?.score ?? 50,
        )
        counter += 1

        return {
          id: `WO-${String(counter).padStart(3, '0')}-N`,
          segmentId: id,
          segmentName: segment.name,
          status: 'open' as const,
          assignee: 'Unassigned',
          costInr: status?.estimatedCostInr ?? costInr,
          repairType: status?.repairType ?? repairType,
          createdAt: now,
          updatedAt: now,
          bumpRateBefore:
            Math.round(((status?.bumpsLast7Days ?? 20) / 7) * 10) / 10,
        }
      })

    useDemoStore.getState().addWorkOrders(created)
    return created
  }

  async getKpis(): Promise<Kpis> {
    const { statuses, sims } = await this.load()
    const workOrders = await this.getWorkOrders()
    const histories = new Map(
      [...sims.entries()].map(([id, sim]) => [id, sim.history]),
    )

    return computeKpis(
      statuses,
      histories,
      workOrders,
      BASE_BUMPS_TODAY + useDemoStore.getState().liveBumps,
    )
  }

  async getProjectedScores(dayOffset: number): Promise<Map<number, number>> {
    const { sims } = await this.load()
    const projected = new Map<number, number>()

    for (const [id, sim] of sims) {
      const forecast = forecastFor(sim.history)
      const point = forecast[Math.min(dayOffset, forecast.length - 1)]
      projected.set(id, point?.value ?? 0)
    }

    return projected
  }

  subscribeLive(cb: (e: LiveEvent) => void): () => void {
    let unsubscribe: (() => void) | null = null
    let cancelled = false

    void this.load().then(({ stream }) => {
      if (cancelled) return
      unsubscribe = stream.subscribe(cb)
    })

    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }

  async resetDemo(): Promise<void> {
    useDemoStore.getState().reset()
  }

  /* --- Demo mode only (src/demo). Not part of the DataSource contract, so a
     real backend is never expected to provide it. ----------------------- */

  async simulateDrive(count = 12): Promise<void> {
    const { stream } = await this.load()
    stream.simulateDrive(count)
  }

  /** The worst segments, for the presenter tour and the verify-repair button. */
  async worstSegmentIds(count = 3): Promise<number[]> {
    const { statuses } = await this.load()
    return [...statuses]
      .sort((a, b) => b.priority - a.priority)
      .slice(0, count)
      .map((s) => s.id)
  }
}

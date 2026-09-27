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
import {
  authorityKindFor,
  buildComplaint,
  DEFAULT_ESCALATION_RULES,
  shouldEscalate,
  type Authority,
  type AuthorityKind,
  type Escalation,
} from '@shared/escalation'
import type { Region } from '@shared/contract'
import type { PlaceBox } from '@/data/DataSource'
import { clampPlaceBox, findCuratedPlaces } from '@shared/places'
import { useDemoStore } from '@/store/demoStore'

/*
 * In the browser there is no configuration and no mailbox, so the authorities
 * are named but have no address. That is not a placeholder to be filled in
 * later — it is the honest state: a draft prepared here can be reviewed and
 * opened in the reviewer's own mail client, and nothing can be transmitted by
 * the app itself. The server behaves the same way until an operator supplies a
 * real address.
 */
const MOCK_AUTHORITIES: Record<AuthorityKind, Authority> = {
  national: {
    kind: 'national',
    name: 'The Project Director, National Highways Authority of India',
    email: '',
  },
  state: {
    kind: 'state',
    name: 'The Executive Engineer, Public Works Department (Buildings & Roads)',
    email: '',
  },
  municipal: {
    kind: 'municipal',
    name: 'The Commissioner, Municipal Corporation',
    email: '',
  },
}

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
  private customRegions: Region[] = []
  private customSegments: Map<number, Segment[]> = new Map()

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

  /* --- Regions ----------------------------------------------------------- */

  async getRegions(): Promise<Region[]> {
    const { segments } = await this.load()
    const base: Region[] = [
      {
        id: 1,
        name: 'Chandigarh University, Gharuan',
        south: 30.7545,
        west: 76.5593,
        north: 30.7815,
        east: 76.5907,
        createdAt: new Date().toISOString(),
        segmentCount: segments.length,
        surveyedCount: segments.length,
      },
    ]
    return [...base, ...this.customRegions]
  }

  async searchPlaces(query: string): Promise<{ name: string; box: PlaceBox }[]> {
    const trimmed = query.trim()
    if (!trimmed) return []

    // 1. Try real OpenStreetMap Nominatim with a fast timeout (3s)
    try {
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(trimmed)}&format=json&limit=5`
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(3000),
      })
      if (res.ok) {
        const results = (await res.json()) as {
          display_name: string
          boundingbox: [string, string, string, string]
        }[]
        if (Array.isArray(results) && results.length > 0) {
          return results.map((r) => {
            const [south, north, west, east] = r.boundingbox.map(Number)
            return {
              name: r.display_name,
              box: clampPlaceBox({ south, north, west, east }),
            }
          })
        }
      }
    } catch {
      // Fall through to curated fallback
    }

    // 2. Curated offline fallback places
    return findCuratedPlaces(trimmed).map((p) => ({
      name: p.name,
      box: clampPlaceBox(p.box),
    }))
  }

  async importRegion(
    name: string,
    box: PlaceBox,
  ): Promise<{
    regionId: number
    name: string
    segments: number
  }> {
    const clamped = clampPlaceBox(box)
    const newId = 100 + this.customRegions.length + 1

    // Synthesize a realistic road network of 25-40 segments within the box
    const numRows = 5
    const numCols = 6
    const latStep = (clamped.north - clamped.south) / (numRows + 1)
    const lonStep = (clamped.east - clamped.west) / (numCols + 1)
    const synthesized: Segment[] = []
    let segIdCounter = 10000 + this.customRegions.length * 1000

    // Horizontal roads
    for (let r = 1; r <= numRows; r++) {
      const lat = clamped.south + r * latStep
      for (let c = 1; c <= numCols - 1; c++) {
        segIdCounter++
        const lonStart = clamped.west + c * lonStep
        const lonEnd = clamped.west + (c + 1) * lonStep
        synthesized.push({
          id: segIdCounter,
          name: `${name} Arterial Road ${r}`,
          highway: r % 2 === 0 ? 'primary' : 'tertiary',
          roadClass: r % 2 === 0 ? 'arterial' : 'collector',
          lengthM: 350,
          nearSensitive: false,
          busRoute: r % 2 === 0,
          path: [
            [lonStart, lat],
            [lonEnd, lat],
          ],
          center: [(lonStart + lonEnd) / 2, lat],
        })
      }
    }

    // Vertical roads
    for (let c = 1; c <= numCols; c++) {
      const lon = clamped.west + c * lonStep
      for (let r = 1; r <= numRows - 1; r++) {
        segIdCounter++
        const latStart = clamped.south + r * latStep
        const latEnd = clamped.south + (r + 1) * latStep
        synthesized.push({
          id: segIdCounter,
          name: `${name} Sector Road ${c}`,
          highway: c % 2 === 0 ? 'secondary' : 'residential',
          roadClass: c % 2 === 0 ? 'arterial' : 'local',
          lengthM: 350,
          nearSensitive: false,
          busRoute: c % 2 === 0,
          path: [
            [lon, latStart],
            [lon, latEnd],
          ],
          center: [lon, (latStart + latEnd) / 2],
        })
      }
    }

    const newRegion: Region = {
      id: newId,
      name,
      south: clamped.south,
      west: clamped.west,
      north: clamped.north,
      east: clamped.east,
      createdAt: new Date().toISOString(),
      segmentCount: synthesized.length,
      surveyedCount: 0,
    }

    this.customRegions.push(newRegion)
    this.customSegments.set(newId, synthesized)

    const data = await this.load()
    data.segments.push(...synthesized)
    for (const segment of synthesized) {
      const sim = simulateSegment(segment)
      data.sims.set(segment.id, sim)
      data.statuses.push(statusFor(segment, sim, 0))
    }

    return {
      regionId: newRegion.id,
      name: newRegion.name,
      segments: synthesized.length,
    }
  }

  /* --- Escalation ------------------------------------------------------- */

  async getEscalations(): Promise<Escalation[]> {
    return useDemoStore.getState().escalations
  }

  async generateEscalations(): Promise<{
    created: Escalation[]
    skipped: { segmentId: number; reason: string }[]
  }> {
    const { segments, statuses } = await this.load()
    const photos = await this.getPhotoReports()
    const existing = useDemoStore.getState().escalations

    const approvedBySegment = new Map<number, PhotoReport[]>()
    for (const photo of photos) {
      if (photo.status !== 'approved') continue
      const list = approvedBySegment.get(photo.segmentId) ?? []
      list.push(photo)
      approvedBySegment.set(photo.segmentId, list)
    }

    const lastBySegment = new Map<number, string>()
    for (const escalation of existing) {
      if (escalation.status === 'dismissed') continue
      lastBySegment.set(escalation.segmentId, escalation.createdAt)
    }

    const byId = new Map(segments.map((s) => [s.id, s]))
    const created: Escalation[] = []
    const skipped: { segmentId: number; reason: string }[] = []

    for (const status of [...statuses].sort(
      (a, b) => b.priority - a.priority,
    )) {
      if (created.length >= DEFAULT_ESCALATION_RULES.maxPerRun) break
      const segment = byId.get(status.id)
      if (!segment) continue

      const decision = shouldEscalate(
        {
          segment,
          status,
          approvedPhotos: approvedBySegment.get(status.id) ?? [],
          lastEscalatedAt: lastBySegment.get(status.id) ?? null,
        },
        DEFAULT_ESCALATION_RULES,
      )

      if (!decision.escalate) {
        if (status.band !== 'good' && skipped.length < 20) {
          skipped.push({ segmentId: status.id, reason: decision.reason })
        }
        continue
      }

      const authority = MOCK_AUTHORITIES[authorityKindFor(segment)]
      const reference = `IP-${new Date().getFullYear()}-${String(status.id).padStart(4, '0')}`
      const { subject, body } = buildComplaint({
        segment,
        status,
        authority,
        approvedPhotos: approvedBySegment.get(status.id) ?? [],
        reference,
      })

      const [lon, lat] = segment.center
      created.push({
        id: reference,
        segmentId: segment.id,
        segmentName: segment.name,
        status: 'draft',
        authority,
        subject,
        body,
        location: {
          lat,
          lon,
          mapsUrl: `https://www.google.com/maps?q=${lat.toFixed(6)},${lon.toFixed(6)}`,
        },
        severity: status.band === 'critical' ? 'critical' : 'watch',
        photoReportIds: (approvedBySegment.get(status.id) ?? []).map(
          (p) => p.id,
        ),
        estimatedCostInr: status.estimatedCostInr,
        createdAt: new Date().toISOString(),
      })
    }

    useDemoStore.getState().setEscalations([...created, ...existing])
    return { created, skipped }
  }

  async reviewEscalation(
    id: string,
    action: 'approve' | 'send' | 'dismiss',
    reason?: string,
  ): Promise<Escalation> {
    const store = useDemoStore.getState()
    const current = store.escalations.find((e) => e.id === id)
    if (!current) throw new Error(`No escalation ${id}`)

    const now = new Date().toISOString()
    let next: Escalation

    if (action === 'approve') {
      next = { ...current, status: 'approved', approvedAt: now }
    } else if (action === 'dismiss') {
      next = { ...current, status: 'dismissed', dismissedReason: reason }
    } else {
      // The same rule the server enforces: approval is its own step, and
      // "sent" here means a person sent it from their own mail client.
      if (current.status !== 'approved') {
        throw new Error(`${id} must be approved before it can be marked sent.`)
      }
      next = { ...current, status: 'sent', sentAt: now }
    }

    store.setEscalations(store.escalations.map((e) => (e.id === id ? next : e)))
    return next
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

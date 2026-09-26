import { randomUUID } from 'node:crypto'
import { estimateCostInr, forecastFor } from '@shared/simulate'
import type {
  DailyScore,
  ForecastPoint,
  Kpis,
  LiveEvent,
  PhotoReport,
  PhotoSeverity,
  PhotoStatus,
  SegmentStatus,
  WorkOrder,
  WorkOrderStatus,
} from '@shared/contract'
import {
  buildComplaint,
  shouldEscalate,
  authorityKindFor,
  DEFAULT_ESCALATION_RULES,
  type Escalation,
  type EscalationStatus,
} from '@shared/escalation'
import { authorities, isDeliverable } from '../escalation/authorities.js'
import type { Notifier } from '../escalation/Notifier.js'
import { buildKpis, buildStatus } from './scoring.js'
import { buildSpatialIndex, type SpatialIndex } from './geo.js'
import type { EventBus } from '../live/EventBus.js'
import {
  WORK_ORDER_TRANSITIONS,
  type BumpObservation,
  type Repository,
} from '../repository/Repository.js'
import { ApiError } from '../http/errors.js'

/** Bumps within this window count toward the current score. */
const SCORING_WINDOW_DAYS = 7
/**
 * How much history the trend and the KPI sparkline need.
 *
 * buildStatus regresses over the last 30 days and the sparkline plots 30
 * points, so reading more than this per segment is wasted bytes on every
 * dashboard load.
 */
const TREND_DAYS = 30

export interface IncomingBump {
  at: string
  lat: number
  lon: number
  magnitude: number
  speedMs: number
}

export interface IngestResult {
  accepted: number
  matched: number
  unmatched: number
  /** Segments whose score changed, and what it changed to. */
  rescored: { segmentId: number; score: number }[]
}

/**
 * The application layer: everything the API does, expressed without reference
 * to HTTP or to storage. Routes translate requests into these calls and
 * responses back out; the repository decides where the rows live.
 */
export class InfraPulseService {
  private index: SpatialIndex | null = null
  /*
   * Computing every segment's status means reading 1,108 histories and running
   * a regression over each — and both /api/segments/status and /api/kpis want
   * it. A dashboard receiving a burst of live events asks for the KPIs several
   * times in a second, so the result is held briefly and dropped the moment
   * anything writes. The TTL is short enough that nothing else needs to know
   * this cache exists.
   */
  private statusCache: { at: number; value: SegmentStatus[] } | null = null
  private static readonly STATUS_TTL_MS = 1_000

  constructor(
    private readonly repo: Repository,
    private readonly bus: EventBus,
    private readonly notifier?: Notifier,
  ) {}

  private async spatialIndex(): Promise<SpatialIndex> {
    // Built once from the road network, which does not change at runtime.
    this.index ??= buildSpatialIndex(await this.repo.listSegments())
    return this.index
  }

  private windowStart(days = SCORING_WINDOW_DAYS): Date {
    return new Date(Date.now() - days * 86_400_000)
  }

  async getSegments() {
    return this.repo.listSegments()
  }

  /** Drops the memoised statuses. Called by everything that writes. */
  private invalidate(): void {
    this.statusCache = null
  }

  /** Status for every segment, computed from observations rather than stored. */
  async getStatuses(): Promise<SegmentStatus[]> {
    const cached = this.statusCache
    if (cached && Date.now() - cached.at < InfraPulseService.STATUS_TTL_MS) {
      return cached.value
    }

    const [segments, photos, bumpCounts, histories] = await Promise.all([
      this.repo.listSegments(),
      this.repo.listPhotoReports(),
      this.repo.countBumpsSince(this.windowStart()),
      // One read for the whole network rather than one per segment.
      this.repo.listRecentHistories(TREND_DAYS),
    ])

    const photoCounts = new Map<number, { total: number; approved: number }>()
    for (const photo of photos) {
      const entry = photoCounts.get(photo.segmentId) ?? {
        total: 0,
        approved: 0,
      }
      entry.total += 1
      if (photo.status === 'approved') entry.approved += 1
      photoCounts.set(photo.segmentId, entry)
    }

    const statuses: SegmentStatus[] = []
    for (const segment of segments) {
      const counts = photoCounts.get(segment.id) ?? { total: 0, approved: 0 }
      statuses.push(
        buildStatus({
          segment,
          history: histories.get(segment.id) ?? [],
          bumpsLast7Days: bumpCounts.get(segment.id) ?? 0,
          photoReportCount: counts.total,
          approvedPhotoCount: counts.approved,
        }),
      )
    }

    this.statusCache = { at: Date.now(), value: statuses }
    return statuses
  }

  async getHistory(segmentId: number): Promise<DailyScore[]> {
    const segment = await this.repo.getSegment(segmentId)
    if (!segment) throw ApiError.notFound(`No segment ${segmentId}`)
    return this.repo.listHistory(segmentId)
  }

  async getForecast(segmentId: number): Promise<ForecastPoint[]> {
    return forecastFor(await this.getHistory(segmentId))
  }

  /** Every segment's score `days` into the future — the Time Machine. */
  async getProjected(days: number): Promise<{ id: number; score: number }[]> {
    const segments = await this.repo.listSegments()
    const projected: { id: number; score: number }[] = []

    for (const segment of segments) {
      const forecast = forecastFor(await this.repo.listHistory(segment.id))
      const point = forecast[Math.min(days, forecast.length - 1)]
      projected.push({ id: segment.id, score: point?.value ?? 0 })
    }

    return projected
  }

  /* --- Ingest ------------------------------------------------------------ */

  /**
   * Takes a trip's worth of detected impacts, matches each to a stretch of
   * road, rescores what changed and tells every connected dashboard.
   *
   * Unmatched points are stored rather than dropped: they usually mean the road
   * exists but is not in our OpenStreetMap import, which is worth knowing.
   */
  async ingestBumps(
    deviceId: string,
    tripId: string,
    incoming: IncomingBump[],
  ): Promise<IngestResult> {
    const index = await this.spatialIndex()
    const observations: BumpObservation[] = []
    const touched = new Set<number>()

    for (const bump of incoming) {
      const match = index.nearest(bump.lon, bump.lat)
      observations.push({
        id: randomUUID(),
        segmentId: match?.segmentId ?? null,
        at: new Date(bump.at),
        lon: bump.lon,
        lat: bump.lat,
        magnitude: bump.magnitude,
        speedMs: bump.speedMs,
        deviceId,
        tripId,
      })
      if (match) touched.add(match.segmentId)
    }

    await this.repo.insertBumps(observations)
    this.invalidate()

    const rescored: { segmentId: number; score: number }[] = []
    for (const segmentId of touched) {
      const score = await this.currentScore(segmentId)
      if (score !== null) rescored.push({ segmentId, score })
    }

    for (const observation of observations) {
      if (observation.segmentId === null) continue
      this.bus.publish({
        type: 'bump',
        segmentId: observation.segmentId,
        at: observation.at.toISOString(),
        magnitude: observation.magnitude,
        position: [observation.lon, observation.lat],
        real: true,
      })
    }

    // A segment crossing into critical is the one thing worth interrupting an
    // engineer for, so it is announced separately from the impacts themselves.
    for (const entry of rescored) {
      if (entry.score >= 40) continue
      const segment = await this.repo.getSegment(entry.segmentId)
      if (!segment) continue
      this.bus.publish({
        type: 'alert',
        segmentId: entry.segmentId,
        at: new Date().toISOString(),
        message: `${segment.name} crossed into critical`,
        band: 'critical',
      })
    }

    const matched = observations.filter((o) => o.segmentId !== null).length
    return {
      accepted: observations.length,
      matched,
      unmatched: observations.length - matched,
      rescored,
    }
  }

  /**
   * Today's score for one segment, derived rather than stored.
   *
   * It is important that this does not write the result back into history.
   * The stored daily score is the wear baseline; the live score is that
   * baseline minus what has been observed since. Persisting the derived value
   * would make the next read subtract the same impacts a second time, and the
   * score would sink a little further on every request — which is exactly what
   * an earlier version of this did (25 to 19.6 to 14.2 on three reads).
   *
   * Folding a day's observations into the baseline is a separate, once-a-day
   * operation: see `rollUpDay`.
   */
  private async currentScore(segmentId: number): Promise<number | null> {
    const segment = await this.repo.getSegment(segmentId)
    if (!segment) return null

    const [history, photos, bumps] = await Promise.all([
      this.repo.listHistory(segmentId),
      this.repo.listPhotoReports(),
      this.repo.countBumpsForSegment(segmentId, this.windowStart()),
    ])

    const mine = photos.filter((p) => p.segmentId === segmentId)
    const status = buildStatus({
      segment,
      history,
      bumpsLast7Days: bumps,
      photoReportCount: mine.length,
      approvedPhotoCount: mine.filter((p) => p.status === 'approved').length,
    })

    return status.score
  }

  /**
   * Folds today's observations into the stored history, once per day.
   *
   * In a deployment this is a scheduled job, not something a request triggers:
   * running it twice in one day would count the same impacts toward two days
   * of wear. It is exposed here so the job has something to call.
   */
  async rollUpDay(): Promise<number> {
    const segments = await this.repo.listSegments()
    let written = 0

    for (const segment of segments) {
      const score = await this.currentScore(segment.id)
      if (score === null) continue
      await this.repo.putTodayScore(segment.id, score)
      written++
    }

    return written
  }

  /* --- Photo reports ------------------------------------------------------ */

  async getPhotoReports(): Promise<PhotoReport[]> {
    return this.repo.listPhotoReports()
  }

  async createPhotoReport(input: {
    lat: number
    lon: number
    imageUrl: string
    label: string
    confidence: number
    severity: PhotoSeverity
    box: { x: number; y: number; w: number; h: number }
    reporter: string
  }): Promise<PhotoReport> {
    const index = await this.spatialIndex()
    const match = index.nearest(input.lon, input.lat)
    if (!match) {
      throw ApiError.badRequest(
        'That location is not on a mapped road segment.',
      )
    }

    const segment = await this.repo.getSegment(match.segmentId)
    if (!segment) throw ApiError.notFound('Segment disappeared mid-request')

    const report: PhotoReport = {
      id: `PR-${randomUUID().slice(0, 8)}`,
      segmentId: segment.id,
      segmentName: segment.name,
      imageUrl: input.imageUrl,
      label: input.label,
      confidence: input.confidence,
      box: input.box,
      severity: input.severity,
      // A citizen's report is a claim, not a fact: it affects the score only
      // once an engineer approves it.
      status: 'pending',
      createdAt: new Date().toISOString(),
      reporter: input.reporter,
    }

    await this.repo.insertPhotoReport(report)
    this.invalidate()
    this.bus.publish({
      type: 'photo',
      segmentId: segment.id,
      at: report.createdAt,
      report,
    })

    return report
  }

  async setPhotoStatus(id: string, status: PhotoStatus): Promise<PhotoReport> {
    const updated = await this.repo.setPhotoStatus(id, status)
    if (!updated) throw ApiError.notFound(`No photo report ${id}`)
    this.invalidate()
    // Approving a report changes that segment's score, but the change is
    // derived on the next read rather than written here — see currentScore.
    return updated
  }

  /* --- Work orders -------------------------------------------------------- */

  async getWorkOrders(): Promise<WorkOrder[]> {
    return this.repo.listWorkOrders()
  }

  async createWorkOrders(segmentIds: number[]): Promise<WorkOrder[]> {
    const existing = await this.repo.listWorkOrders()
    const statuses = await this.getStatuses()
    const statusById = new Map(statuses.map((s) => [s.id, s]))

    // One live order per segment: a second crew dispatched to the same 50m of
    // road is the kind of thing that makes a works department distrust software.
    const alreadyLive = new Set(
      existing.filter((w) => w.status !== 'verified').map((w) => w.segmentId),
    )

    const now = new Date().toISOString()
    const created: WorkOrder[] = []

    for (const segmentId of segmentIds) {
      if (alreadyLive.has(segmentId)) continue
      const segment = await this.repo.getSegment(segmentId)
      if (!segment) continue

      const status = statusById.get(segmentId)
      const fallback = estimateCostInr(segment, status?.score ?? 50)

      created.push({
        id: `WO-${randomUUID().slice(0, 8)}`,
        segmentId,
        segmentName: segment.name,
        status: 'open',
        assignee: 'Unassigned',
        costInr: status?.estimatedCostInr ?? fallback.costInr,
        repairType: status?.repairType ?? fallback.repairType,
        createdAt: now,
        updatedAt: now,
        bumpRateBefore:
          Math.round(((status?.bumpsLast7Days ?? 0) / 7) * 10) / 10,
      })
      alreadyLive.add(segmentId)
    }

    return this.repo.insertWorkOrders(created)
  }

  async updateWorkOrder(
    id: string,
    patch: { status?: WorkOrderStatus; assignee?: string },
  ): Promise<WorkOrder> {
    const current = await this.repo.getWorkOrder(id)
    if (!current) throw ApiError.notFound(`No work order ${id}`)

    const next: Partial<WorkOrder> = { ...patch }

    if (patch.status && patch.status !== current.status) {
      const allowed = WORK_ORDER_TRANSITIONS[current.status]
      if (!allowed.includes(patch.status)) {
        throw ApiError.conflict(
          `A ${current.status} work order cannot move to ${patch.status}. Allowed: ${allowed.join(', ')}.`,
        )
      }

      if (patch.status === 'verified') {
        // Verification is the moment the repair is measured: the bump rate
        // since work completed, against the rate before it started.
        const since = new Date(current.updatedAt)
        const after = await this.repo.countBumpsForSegment(
          current.segmentId,
          since,
        )
        const days = Math.max(1, (Date.now() - since.getTime()) / 86_400_000)
        next.bumpRateAfter = Math.round((after / days) * 10) / 10
      }
    }

    const updated = await this.repo.updateWorkOrder(id, next)
    if (!updated) throw ApiError.notFound(`No work order ${id}`)
    return updated
  }

  /* --- Aggregates --------------------------------------------------------- */

  async getKpis(): Promise<Kpis> {
    const [statuses, workOrders, histories] = await Promise.all([
      this.getStatuses(),
      this.repo.listWorkOrders(),
      this.repo.listRecentHistories(TREND_DAYS),
    ])

    const startOfDay = new Date()
    startOfDay.setHours(0, 0, 0, 0)
    const today = await this.repo.countBumpsSince(startOfDay)
    const bumpsToday = [...today.values()].reduce((a, b) => a + b, 0)

    return buildKpis(statuses, histories, workOrders, bumpsToday)
  }

  /* --- Escalation to the road-owning authority --------------------------- */

  async getEscalations(): Promise<Escalation[]> {
    return this.repo.listEscalations()
  }

  /**
   * Drafts a complaint for every segment that has earned one.
   *
   * Idempotent by way of the cooldown: running it twice in a day produces
   * nothing the second time, so it is safe to call on a schedule or from a
   * button without piling up duplicates.
   */
  async generateEscalations(): Promise<{
    created: Escalation[]
    skipped: { segmentId: number; reason: string }[]
  }> {
    const [statuses, photos] = await Promise.all([
      this.getStatuses(),
      this.repo.listPhotoReports(),
    ])

    const approvedBySegment = new Map<number, PhotoReport[]>()
    for (const photo of photos) {
      if (photo.status !== 'approved') continue
      const list = approvedBySegment.get(photo.segmentId) ?? []
      list.push(photo)
      approvedBySegment.set(photo.segmentId, list)
    }

    const directory = authorities()
    const created: Escalation[] = []
    const skipped: { segmentId: number; reason: string }[] = []

    // Worst first, so a capped run reports the roads that matter most.
    const ranked = [...statuses].sort((a, b) => b.priority - a.priority)

    for (const status of ranked) {
      if (created.length >= DEFAULT_ESCALATION_RULES.maxPerRun) break
      const segment = await this.repo.getSegment(status.id)
      if (!segment) continue

      const decision = shouldEscalate(
        {
          segment,
          status,
          approvedPhotos: approvedBySegment.get(status.id) ?? [],
          lastEscalatedAt: await this.repo.lastEscalatedAt(status.id),
        },
        DEFAULT_ESCALATION_RULES,
      )

      if (!decision.escalate) {
        // Only worth explaining for roads that were candidates at all.
        if (status.band !== 'good' && skipped.length < 20) {
          skipped.push({ segmentId: status.id, reason: decision.reason })
        }
        continue
      }

      const authority = directory[authorityKindFor(segment)]
      const reference =
        'IP-' +
        new Date().getFullYear() +
        '-' +
        String(status.id).padStart(4, '0')

      const { subject, body } = buildComplaint({
        segment,
        status,
        authority,
        approvedPhotos: approvedBySegment.get(status.id) ?? [],
        reference,
      })

      const [lon, lat] = segment.center
      const escalation: Escalation = {
        id: reference,
        segmentId: segment.id,
        segmentName: segment.name,
        // Drafted, never sent. A person decides.
        status: 'draft',
        authority,
        subject,
        body,
        location: {
          lat,
          lon,
          mapsUrl:
            'https://www.google.com/maps?q=' +
            lat.toFixed(6) +
            ',' +
            lon.toFixed(6),
        },
        severity: status.band === 'critical' ? 'critical' : 'watch',
        photoReportIds: (approvedBySegment.get(status.id) ?? []).map(
          (p) => p.id,
        ),
        estimatedCostInr: status.estimatedCostInr,
        createdAt: new Date().toISOString(),
      }

      created.push(await this.repo.insertEscalation(escalation))
    }

    return { created, skipped }
  }

  async reviewEscalation(
    id: string,
    action: 'approve' | 'send' | 'dismiss',
    reason?: string,
  ): Promise<Escalation> {
    const current = await this.repo.getEscalation(id)
    if (!current) throw ApiError.notFound(`No escalation ${id}`)

    const now = new Date().toISOString()
    let patch: Partial<Escalation>

    if (action === 'approve') {
      if (current.status !== 'draft') {
        throw ApiError.conflict(`${id} is already ${current.status}.`)
      }
      patch = { status: 'approved' as EscalationStatus, approvedAt: now }
    } else if (action === 'dismiss') {
      patch = {
        status: 'dismissed' as EscalationStatus,
        dismissedReason: reason,
      }
    } else {
      // Approval is a separate, deliberate step before anything leaves.
      if (current.status !== 'approved') {
        throw ApiError.conflict(
          `${id} must be approved by a reviewer before it can be sent.`,
        )
      }
      if (!isDeliverable(current.authority)) {
        throw ApiError.conflict(
          `No address is configured for ${current.authority.name}. Set it from that office's published contacts, or open the draft in your own mail client.`,
        )
      }
      await this.notifier?.send(current)
      patch = { status: 'sent' as EscalationStatus, sentAt: now }
    }

    const updated = await this.repo.updateEscalation(id, patch)
    if (!updated) throw ApiError.notFound(`No escalation ${id}`)
    return updated
  }

  liveHistory(): LiveEvent[] {
    return this.bus.history()
  }

  subscribe(listener: (event: LiveEvent) => void): () => void {
    return this.bus.subscribe(listener)
  }

  async reset(): Promise<void> {
    await this.repo.reset()
    this.index = null
    this.invalidate()
  }
}

import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  generatePhotoReports,
  generateWorkOrders,
  segmentsFromGeoJson,
  simulateSegment,
  statusFor,
} from '@shared/simulate'
import type {
  DailyScore,
  PhotoReport,
  PhotoStatus,
  Segment,
  WorkOrder,
} from '@shared/contract'
import type { BumpObservation, Repository } from './Repository.js'

const HERE = dirname(fileURLToPath(import.meta.url))
/** The road network is a build artefact of scripts/fetch-roads.ts. */
const SEGMENTS_PATH = resolve(HERE, '../../../public/data/segments.geojson')

/**
 * A working store with no database behind it.
 *
 * This is not a stub: it enforces the same invariants the SQL implementation
 * will, and the API is fully exercisable against it. What it does not do is
 * survive a restart, or serve more than one process — which is exactly the
 * line where Postgres becomes necessary.
 *
 * Seeded from the same `shared/simulate.ts` the browser mock uses, so pointing
 * the frontend at this server shows the same city it shows offline.
 */
export class InMemoryRepository implements Repository {
  private segments: Segment[] = []
  private histories = new Map<number, DailyScore[]>()
  private bumps: BumpObservation[] = []
  private photos: PhotoReport[] = []
  private workOrders: WorkOrder[] = []
  private ready: Promise<void> | null = null

  /** Loads the network and seeds history on first use. */
  private init(): Promise<void> {
    this.ready ??= this.seed()
    return this.ready
  }

  private async seed(): Promise<void> {
    const raw = await readFile(SEGMENTS_PATH, 'utf-8')
    this.segments = segmentsFromGeoJson(JSON.parse(raw))

    const scores = new Map<number, number>()
    for (const segment of this.segments) {
      const sim = simulateSegment(segment)
      this.histories.set(segment.id, sim.history)
      scores.set(segment.id, sim.history[sim.history.length - 1].score)
    }

    this.photos = generatePhotoReports(this.segments, scores)

    const photoCounts = new Map<number, number>()
    for (const photo of this.photos) {
      photoCounts.set(
        photo.segmentId,
        (photoCounts.get(photo.segmentId) ?? 0) + 1,
      )
    }

    const statuses = this.segments.map((segment) =>
      statusFor(
        segment,
        {
          history: this.histories.get(segment.id)!,
          breakdown: {
            base: 100,
            bumpPenalty: 0,
            roughnessPenalty: 0,
            photoPenalty: 0,
          },
          bumpsLast7Days: 0,
        },
        photoCounts.get(segment.id) ?? 0,
      ),
    )

    this.workOrders = generateWorkOrders(this.segments, statuses)
  }

  async listSegments(): Promise<Segment[]> {
    await this.init()
    return this.segments
  }

  async getSegment(id: number): Promise<Segment | null> {
    await this.init()
    return this.segments.find((s) => s.id === id) ?? null
  }

  async listHistory(segmentId: number): Promise<DailyScore[]> {
    await this.init()
    return this.histories.get(segmentId) ?? []
  }

  async listLatestScores(): Promise<Map<number, number>> {
    await this.init()
    const latest = new Map<number, number>()
    for (const [id, history] of this.histories) {
      const last = history[history.length - 1]
      if (last) latest.set(id, last.score)
    }
    return latest
  }

  async putTodayScore(segmentId: number, score: number): Promise<void> {
    await this.init()
    const history = this.histories.get(segmentId)
    if (!history || history.length === 0) return
    // Rewrites today's row rather than appending, so a hundred bumps in an
    // afternoon produce one day of history, not a hundred.
    history[history.length - 1] = {
      ...history[history.length - 1],
      score: Math.round(score * 10) / 10,
    }
  }

  async insertBumps(bumps: BumpObservation[]): Promise<void> {
    await this.init()
    this.bumps.push(...bumps)
  }

  async countBumpsSince(since: Date): Promise<Map<number, number>> {
    await this.init()
    const counts = new Map<number, number>()
    for (const bump of this.bumps) {
      if (bump.segmentId === null || bump.at < since) continue
      counts.set(bump.segmentId, (counts.get(bump.segmentId) ?? 0) + 1)
    }
    return counts
  }

  async countBumpsForSegment(segmentId: number, since: Date): Promise<number> {
    await this.init()
    let count = 0
    for (const bump of this.bumps) {
      if (bump.segmentId === segmentId && bump.at >= since) count++
    }
    return count
  }

  async listPhotoReports(): Promise<PhotoReport[]> {
    await this.init()
    return this.photos
  }

  async insertPhotoReport(report: PhotoReport): Promise<PhotoReport> {
    await this.init()
    this.photos = [report, ...this.photos]
    return report
  }

  async setPhotoStatus(
    id: string,
    status: PhotoStatus,
  ): Promise<PhotoReport | null> {
    await this.init()
    const index = this.photos.findIndex((p) => p.id === id)
    if (index === -1) return null
    const updated = { ...this.photos[index], status }
    this.photos[index] = updated
    return updated
  }

  async listWorkOrders(): Promise<WorkOrder[]> {
    await this.init()
    return this.workOrders
  }

  async getWorkOrder(id: string): Promise<WorkOrder | null> {
    await this.init()
    return this.workOrders.find((w) => w.id === id) ?? null
  }

  async insertWorkOrders(orders: WorkOrder[]): Promise<WorkOrder[]> {
    await this.init()
    this.workOrders = [...this.workOrders, ...orders]
    return orders
  }

  async updateWorkOrder(
    id: string,
    patch: Partial<WorkOrder>,
  ): Promise<WorkOrder | null> {
    await this.init()
    const index = this.workOrders.findIndex((w) => w.id === id)
    if (index === -1) return null
    const updated = {
      ...this.workOrders[index],
      ...patch,
      id: this.workOrders[index].id,
      updatedAt: new Date().toISOString(),
    }
    this.workOrders[index] = updated
    return updated
  }

  async reset(): Promise<void> {
    this.segments = []
    this.histories.clear()
    this.bumps = []
    this.photos = []
    this.workOrders = []
    this.ready = null
    await this.init()
  }
}

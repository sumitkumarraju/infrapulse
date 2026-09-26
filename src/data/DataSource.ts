import type { Escalation } from '@shared/escalation'
import type { Region } from '@shared/contract'
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
 * The swap point (CLAUDE.md 4.1).
 *
 * Every component reads data through TanStack Query, which calls this
 * interface. Replacing `MockDataSource` with a real implementation is a
 * one-line change in `src/data/index.ts`; no screen needs touching.
 */
export interface DataSource {
  getSegments(): Promise<Segment[]>
  getSegmentStatus(): Promise<SegmentStatus[]>
  getSegmentHistory(id: number): Promise<DailyScore[]>
  getForecast(id: number): Promise<ForecastPoint[]>
  getPhotoReports(): Promise<PhotoReport[]>
  setPhotoStatus(id: string, status: PhotoStatus): Promise<PhotoReport>
  getWorkOrders(): Promise<WorkOrder[]>
  updateWorkOrder(id: string, patch: Partial<WorkOrder>): Promise<WorkOrder>
  createWorkOrders(segmentIds: number[]): Promise<WorkOrder[]>
  getKpis(): Promise<Kpis>
  /** Returns an unsubscribe function. */
  subscribeLive(cb: (e: LiveEvent) => void): () => void
  /* --- Regions ---------------------------------------------------------- */

  getRegions(): Promise<Region[]>
  /** Place name to candidate bounding boxes. */
  searchPlaces(query: string): Promise<{ name: string; box: PlaceBox }[]>
  importRegion(
    name: string,
    box: PlaceBox,
  ): Promise<{ regionId: number; name: string; segments: number }>

  /* --- Escalation to the road-owning authority ------------------------- */

  getEscalations(): Promise<Escalation[]>
  /** Drafts complaints for every road that has earned one. Idempotent. */
  generateEscalations(): Promise<{
    created: Escalation[]
    skipped: { segmentId: number; reason: string }[]
  }>
  reviewEscalation(
    id: string,
    action: 'approve' | 'send' | 'dismiss',
    reason?: string,
  ): Promise<Escalation>

  /** Projected score for a segment N days out — the Time Machine. */
  getProjectedScores(dayOffset: number): Promise<Map<number, number>>
  resetDemo(): Promise<void>
}

export interface PlaceBox {
  south: number
  west: number
  north: number
  east: number
}

/** Query keys, kept in one place so invalidation cannot drift. */
export const qk = {
  segments: ['segments'] as const,
  status: ['segment-status'] as const,
  history: (id: number) => ['segment-history', id] as const,
  forecast: (id: number) => ['forecast', id] as const,
  photos: ['photo-reports'] as const,
  workOrders: ['work-orders'] as const,
  kpis: ['kpis'] as const,
  escalations: ['escalations'] as const,
  regions: ['regions'] as const,
  projected: (offset: number) => ['projected', offset] as const,
}

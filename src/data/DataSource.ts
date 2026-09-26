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
  /** Projected score for a segment N days out — the Time Machine. */
  getProjectedScores(dayOffset: number): Promise<Map<number, number>>
  resetDemo(): Promise<void>
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
  projected: (offset: number) => ['projected', offset] as const,
}

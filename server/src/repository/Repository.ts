import type {
  DailyScore,
  PhotoReport,
  PhotoStatus,
  Segment,
  WorkOrder,
  WorkOrderStatus,
} from '@shared/contract'

/**
 * The database seam.
 *
 * Everything above this line — routes, scoring, the live bus — is written
 * against this interface and nothing else. `InMemoryRepository` implements it
 * today so the API is runnable without a database; `db/schema.sql` is the
 * Postgres shape a `PostgresRepository` would read and write, and adding one
 * means implementing this interface and changing the single line in
 * `src/index.ts` that constructs it.
 *
 * The methods are deliberately coarse. A finer interface (`query(sql)`) would
 * leak the storage engine into the routes, and a chattier one would force the
 * SQL implementation into N+1 queries on a 1,100-segment map.
 */
export interface Repository {
  /* --- Road network. Static once imported from OpenStreetMap. ----------- */

  listSegments(): Promise<Segment[]>
  getSegment(id: number): Promise<Segment | null>

  /* --- Condition history ------------------------------------------------ */

  /** Daily scores for one segment, oldest first. */
  listHistory(segmentId: number): Promise<DailyScore[]>
  /** Every segment's most recent score. One query, not one per segment. */
  listLatestScores(): Promise<Map<number, number>>
  /** Replaces today's score for a segment after a recompute. */
  putTodayScore(segmentId: number, score: number): Promise<void>

  /* --- Observations ingested from phones --------------------------------- */

  insertBumps(bumps: BumpObservation[]): Promise<void>
  /** Bump counts per segment over a trailing window, for scoring and KPIs. */
  countBumpsSince(since: Date): Promise<Map<number, number>>
  countBumpsForSegment(segmentId: number, since: Date): Promise<number>

  /* --- Citizen photo reports --------------------------------------------- */

  listPhotoReports(): Promise<PhotoReport[]>
  insertPhotoReport(report: PhotoReport): Promise<PhotoReport>
  setPhotoStatus(id: string, status: PhotoStatus): Promise<PhotoReport | null>

  /* --- Work orders -------------------------------------------------------- */

  listWorkOrders(): Promise<WorkOrder[]>
  getWorkOrder(id: string): Promise<WorkOrder | null>
  insertWorkOrders(orders: WorkOrder[]): Promise<WorkOrder[]>
  updateWorkOrder(
    id: string,
    patch: Partial<WorkOrder>,
  ): Promise<WorkOrder | null>

  /* --- Demo support ------------------------------------------------------- */

  /** Returns the store to its seeded state. A real deployment would not expose this. */
  reset(): Promise<void>
}

/** One detected impact, as it arrives from a phone. */
export interface BumpObservation {
  id: string
  /** Which 50m segment it was matched to, or null when nothing was close. */
  segmentId: number | null
  at: Date
  lon: number
  lat: number
  /** Vertical acceleration spike, m/s². */
  magnitude: number
  speedMs: number
  /** Anonymous per-install id — never a person. */
  deviceId: string
  tripId: string
}

/** What the next status is allowed to be, enforced server-side. */
export const WORK_ORDER_TRANSITIONS: Record<
  WorkOrderStatus,
  WorkOrderStatus[]
> = {
  open: ['in-progress'],
  'in-progress': ['repaired', 'open'],
  repaired: ['verified', 'in-progress'],
  verified: ['reopened'],
  reopened: ['in-progress'],
}

import pg from 'pg'
import type {
  DailyScore,
  Region,
  PhotoReport,
  PhotoStatus,
  Segment,
  WorkOrder,
} from '@shared/contract'
import type { Escalation } from '@shared/escalation'
import { ApiError } from '../http/errors.js'
import type { BumpObservation, Repository } from './Repository.js'

/* The same interface, backed by Postgres.
 *
 * Works against any Postgres with PostGIS: Supabase, Neon, RDS or a local
 * instance. Nothing here is Supabase-specific, which is deliberate — the
 * connection string is the only thing that decides where the rows live.
 *
 * Two things this fixes that the in-memory version could pretend not to have:
 * concurrency, where the partial unique index stops two crews being dispatched
 * to the same 50m even if two requests arrive at once; and volume, where
 * bump_observations grows past anything a process can hold.
 */

const { Pool } = pg

/** Postgres returns numeric as a string to avoid losing precision. */
function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value)
}

function isoDay(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  return String(value).slice(0, 10)
}

interface SegmentRow {
  id: number
  name: string
  highway: string
  road_class: Segment['roadClass']
  length_m: string | number
  near_sensitive: boolean
  bus_route: boolean
  path: string
  center: string
}

function toSegment(row: SegmentRow): Segment {
  // ST_AsGeoJSON gives a JSON string; parsing here keeps the coordinate shape
  // in one place rather than scattered through the callers.
  const path = JSON.parse(row.path) as { coordinates: [number, number][] }
  const center = JSON.parse(row.center) as { coordinates: [number, number] }

  return {
    id: row.id,
    name: row.name,
    highway: row.highway,
    roadClass: row.road_class,
    lengthM: num(row.length_m),
    nearSensitive: row.near_sensitive,
    busRoute: row.bus_route,
    path: path.coordinates,
    center: center.coordinates,
  }
}

const SEGMENT_COLUMNS = `
  id, name, highway, road_class, length_m, near_sensitive, bus_route,
  ST_AsGeoJSON(geom) AS path,
  ST_AsGeoJSON(center) AS center
`

export class PostgresRepository implements Repository {
  private readonly pool: pg.Pool

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      // Managed Postgres almost always terminates TLS with a certificate this
      // process has no chain for. The connection is still encrypted.
      ssl: connectionString.includes('localhost')
        ? undefined
        : { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30_000,
      // Supabase keeps PostGIS in an `extensions` schema rather than public,
      // so without this the geometry functions are simply not visible.
      options: '-c search_path=public,extensions',
    })
  }

  async close(): Promise<void> {
    await this.pool.end()
  }

  /** Fails fast at startup rather than on the first request. */
  async verify(): Promise<void> {
    const { rows } = await this.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM segments',
    )
    if (Number(rows[0].count) === 0) {
      throw new Error(
        'The segments table is empty. Run `npm run db:migrate` then `npm run db:import`.',
      )
    }
  }

  /* --- Road network ------------------------------------------------------ */

  async listSegments(regionId?: number): Promise<Segment[]> {
    const query = regionId
      ? `SELECT ${SEGMENT_COLUMNS} FROM segments WHERE region_id = $1 ORDER BY id`
      : `SELECT ${SEGMENT_COLUMNS} FROM segments WHERE region_id = 1 OR region_id IS NULL ORDER BY id LIMIT 2000`
    const { rows } = await this.pool.query<SegmentRow>(
      query,
      regionId ? [regionId] : [],
    )
    return rows.map(toSegment)
  }

  async getSegment(id: number): Promise<Segment | null> {
    const { rows } = await this.pool.query<SegmentRow>(
      `SELECT ${SEGMENT_COLUMNS} FROM segments WHERE id = $1`,
      [id],
    )
    return rows[0] ? toSegment(rows[0]) : null
  }

  /* --- Regions -------------------------------------------------------------- */

  async listRegions(): Promise<Region[]> {
    // Counted in the query rather than by loading segments: a region can hold
    // tens of thousands of them.
    const { rows } = await this.pool.query(
      `SELECT r.*,
              count(s.id)::int AS segment_count,
              count(h.segment_id)::int AS surveyed_count
       FROM regions r
       LEFT JOIN segments s ON s.region_id = r.id
       LEFT JOIN LATERAL (
         SELECT 1 AS segment_id
         FROM segment_daily_scores d
         WHERE d.segment_id = s.id
         LIMIT 1
       ) h ON true
       GROUP BY r.id
       ORDER BY r.created_at`,
    )

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      south: num(r.south),
      west: num(r.west),
      north: num(r.north),
      east: num(r.east),
      createdAt: (r.created_at as Date).toISOString(),
      segmentCount: num(r.segment_count),
      surveyedCount: num(r.surveyed_count),
    }))
  }

  async upsertRegion(region: {
    name: string
    south: number
    west: number
    north: number
    east: number
  }): Promise<Region> {
    const { rows } = await this.pool.query(
      `INSERT INTO regions (name, south, west, north, east)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (south, west, north, east)
       DO UPDATE SET name = EXCLUDED.name
       RETURNING *`,
      [region.name, region.south, region.west, region.north, region.east],
    )

    const row = rows[0]
    return {
      id: row.id,
      name: row.name,
      south: num(row.south),
      west: num(row.west),
      north: num(row.north),
      east: num(row.east),
      createdAt: (row.created_at as Date).toISOString(),
      segmentCount: 0,
      surveyedCount: 0,
    }
  }

  async insertSegments(
    regionId: number,
    segments: Omit<Segment, 'id'>[],
  ): Promise<number> {
    if (segments.length === 0) return 0

    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')

      // Re-importing replaces the area rather than doubling it. Scores and
      // observations cascade away with the segments, which is correct: they
      // described geometry that no longer exists under those ids.
      await client.query('DELETE FROM segments WHERE region_id = $1', [
        regionId,
      ])

      // Batched. One statement per segment would be thousands of round trips
      // against a pooler on the other side of the country.
      const BATCH = 250
      for (let start = 0; start < segments.length; start += BATCH) {
        const slice = segments.slice(start, start + BATCH)
        const values: unknown[] = []
        const tuples: string[] = []

        for (const segment of slice) {
          const base = values.length
          const line = `LINESTRING(${segment.path
            .map(([lon, lat]) => `${lon} ${lat}`)
            .join(', ')})`

          values.push(
            regionId,
            segment.name,
            segment.highway,
            segment.roadClass,
            segment.lengthM,
            segment.nearSensitive,
            segment.busRoute,
            line,
            segment.center[0],
            segment.center[1],
          )

          tuples.push(
            `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::road_class,` +
              ` $${base + 5}, $${base + 6}, $${base + 7},` +
              ` ST_GeomFromText($${base + 8}, 4326),` +
              ` ST_SetSRID(ST_MakePoint($${base + 9}, $${base + 10}), 4326))`,
          )
        }

        await client.query(
          `INSERT INTO segments
             (region_id, name, highway, road_class, length_m,
              near_sensitive, bus_route, geom, center)
           VALUES ${tuples.join(', ')}`,
          values,
        )
      }

      await client.query('COMMIT')
      return segments.length
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  /* --- Condition history -------------------------------------------------- */

  async listHistory(segmentId: number): Promise<DailyScore[]> {
    const { rows } = await this.pool.query(
      `SELECT day, score FROM segment_daily_scores
       WHERE segment_id = $1 ORDER BY day`,
      [segmentId],
    )
    return rows.map((r) => ({ day: isoDay(r.day), score: num(r.score) }))
  }

  async listRecentHistories(days: number): Promise<Map<number, DailyScore[]>> {
    // One query for the whole network. The alternative is 1,108 round trips
    // on every dashboard load.
    const { rows } = await this.pool.query(
      `SELECT segment_id, day, score
       FROM segment_daily_scores
       WHERE day > CURRENT_DATE - $1::int
       ORDER BY segment_id, day`,
      [days],
    )

    const histories = new Map<number, DailyScore[]>()
    for (const row of rows) {
      const list = histories.get(row.segment_id) ?? []
      list.push({ day: isoDay(row.day), score: num(row.score) })
      histories.set(row.segment_id, list)
    }
    return histories
  }

  async listLatestScores(): Promise<Map<number, number>> {
    const { rows } = await this.pool.query(
      `SELECT DISTINCT ON (segment_id) segment_id, score
       FROM segment_daily_scores
       ORDER BY segment_id, day DESC`,
    )
    return new Map(rows.map((r) => [r.segment_id, num(r.score)]))
  }

  async putTodayScore(segmentId: number, score: number): Promise<void> {
    // One row per segment per day: a hundred impacts in an afternoon produce
    // one day of history, not a hundred.
    await this.pool.query(
      `INSERT INTO segment_daily_scores (segment_id, day, score, simulated)
       VALUES ($1, CURRENT_DATE, $2, false)
       ON CONFLICT (segment_id, day)
       DO UPDATE SET score = EXCLUDED.score, simulated = false`,
      [segmentId, score],
    )
  }

  /* --- Observations -------------------------------------------------------- */

  async insertBumps(bumps: BumpObservation[]): Promise<void> {
    if (bumps.length === 0) return

    // One statement for the batch. A trip can carry hundreds of readings and
    // a round trip each would dominate the request.
    const values: unknown[] = []
    const tuples: string[] = []

    for (const bump of bumps) {
      const base = values.length
      values.push(
        bump.id,
        bump.segmentId,
        bump.at.toISOString(),
        bump.lon,
        bump.lat,
        bump.magnitude,
        bump.speedMs,
        bump.deviceId,
        bump.tripId,
      )
      tuples.push(
        `($${base + 1}, $${base + 2}, $${base + 3},` +
          ` ST_SetSRID(ST_MakePoint($${base + 4}, $${base + 5}), 4326),` +
          ` $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9})`,
      )
    }

    await this.pool.query(
      `INSERT INTO bump_observations
         (id, segment_id, at, position, magnitude, speed_ms, device_id, trip_id)
       VALUES ${tuples.join(', ')}
       ON CONFLICT (id) DO NOTHING`,
      values,
    )
  }

  async countBumpsSince(since: Date): Promise<Map<number, number>> {
    const { rows } = await this.pool.query(
      `SELECT segment_id, count(*)::int AS count
       FROM bump_observations
       WHERE at >= $1 AND segment_id IS NOT NULL
       GROUP BY segment_id`,
      [since.toISOString()],
    )
    return new Map(rows.map((r) => [r.segment_id, num(r.count)]))
  }

  async countBumpsForSegment(segmentId: number, since: Date): Promise<number> {
    const { rows } = await this.pool.query(
      `SELECT count(*)::int AS count FROM bump_observations
       WHERE segment_id = $1 AND at >= $2`,
      [segmentId, since.toISOString()],
    )
    return num(rows[0].count)
  }

  /* --- Photo reports -------------------------------------------------------- */

  private toPhoto(row: Record<string, unknown>): PhotoReport {
    return {
      id: row.id as string,
      segmentId: row.segment_id as number,
      segmentName: (row.segment_name as string) ?? '',
      imageUrl: row.image_url as string,
      label: row.label as string,
      confidence: num(row.confidence),
      box: {
        x: num(row.box_x),
        y: num(row.box_y),
        w: num(row.box_w),
        h: num(row.box_h),
      },
      severity: row.severity as PhotoReport['severity'],
      status: row.status as PhotoStatus,
      createdAt: (row.created_at as Date).toISOString(),
      reporter: row.reporter as string,
    }
  }

  private readonly photoSelect = `
    SELECT p.*, s.name AS segment_name
    FROM photo_reports p
    JOIN segments s ON s.id = p.segment_id
  `

  async listPhotoReports(): Promise<PhotoReport[]> {
    const { rows } = await this.pool.query(
      `${this.photoSelect} ORDER BY p.created_at DESC`,
    )
    return rows.map((r) => this.toPhoto(r))
  }

  async insertPhotoReport(report: PhotoReport): Promise<PhotoReport> {
    await this.pool.query(
      `INSERT INTO photo_reports
         (id, segment_id, image_url, label, confidence,
          box_x, box_y, box_w, box_h, severity, status, reporter, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        report.id,
        report.segmentId,
        report.imageUrl,
        report.label,
        report.confidence,
        report.box.x,
        report.box.y,
        report.box.w,
        report.box.h,
        report.severity,
        report.status,
        report.reporter,
        report.createdAt,
      ],
    )
    return report
  }

  async setPhotoStatus(
    id: string,
    status: PhotoStatus,
  ): Promise<PhotoReport | null> {
    /*
     * reviewed_at is required by a CHECK for anything but pending.
     *
     * Both casts are load-bearing. The same parameter is used as a
     * photo_status and compared against a string literal, and Postgres will
     * not infer two types for one parameter — it fails the whole statement
     * with "inconsistent types deduced". Saying which is which resolves it.
     */
    await this.pool.query(
      `UPDATE photo_reports
       SET status = $2::photo_status,
           reviewed_at = CASE WHEN $2::text = 'pending' THEN NULL ELSE now() END
       WHERE id = $1`,
      [id, status],
    )

    const { rows } = await this.pool.query(
      `${this.photoSelect} WHERE p.id = $1`,
      [id],
    )
    return rows[0] ? this.toPhoto(rows[0]) : null
  }

  /* --- Work orders ---------------------------------------------------------- */

  private toWorkOrder(row: Record<string, unknown>): WorkOrder {
    return {
      id: row.id as string,
      segmentId: row.segment_id as number,
      segmentName: (row.segment_name as string) ?? '',
      status: row.status as WorkOrder['status'],
      assignee: row.assignee as string,
      costInr: num(row.cost_inr),
      repairType: row.repair_type as WorkOrder['repairType'],
      createdAt: (row.created_at as Date).toISOString(),
      updatedAt: (row.updated_at as Date).toISOString(),
      bumpRateBefore: num(row.bump_rate_before),
      bumpRateAfter:
        row.bump_rate_after === null ? undefined : num(row.bump_rate_after),
    }
  }

  private readonly workOrderSelect = `
    SELECT w.*, s.name AS segment_name
    FROM work_orders w
    JOIN segments s ON s.id = w.segment_id
  `

  async listWorkOrders(): Promise<WorkOrder[]> {
    const { rows } = await this.pool.query(
      `${this.workOrderSelect} ORDER BY w.created_at`,
    )
    return rows.map((r) => this.toWorkOrder(r))
  }

  async getWorkOrder(id: string): Promise<WorkOrder | null> {
    const { rows } = await this.pool.query(
      `${this.workOrderSelect} WHERE w.id = $1`,
      [id],
    )
    return rows[0] ? this.toWorkOrder(rows[0]) : null
  }

  async insertWorkOrders(orders: WorkOrder[]): Promise<WorkOrder[]> {
    const created: WorkOrder[] = []

    for (const order of orders) {
      try {
        await this.pool.query(
          `INSERT INTO work_orders
             (id, segment_id, status, assignee, cost_inr, repair_type,
              bump_rate_before, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            order.id,
            order.segmentId,
            order.status,
            order.assignee,
            order.costInr,
            order.repairType,
            order.bumpRateBefore,
            order.createdAt,
            order.updatedAt,
          ],
        )
        created.push(order)
      } catch (error) {
        // 23505 is the partial unique index refusing a second live order on
        // the same segment. Under concurrency the database is the only thing
        // that can enforce that, so losing the race is expected, not an error.
        if ((error as { code?: string }).code === '23505') continue
        throw error
      }
    }

    return created
  }

  async updateWorkOrder(
    id: string,
    patch: Partial<WorkOrder>,
  ): Promise<WorkOrder | null> {
    const sets: string[] = ['updated_at = now()']
    const values: unknown[] = [id]

    const assign = (column: string, value: unknown) => {
      values.push(value)
      sets.push(`${column} = $${values.length}`)
    }

    if (patch.status !== undefined) assign('status', patch.status)
    if (patch.assignee !== undefined) assign('assignee', patch.assignee)
    if (patch.costInr !== undefined) assign('cost_inr', patch.costInr)
    if (patch.bumpRateAfter !== undefined) {
      assign('bump_rate_after', patch.bumpRateAfter)
    }

    await this.pool.query(
      `UPDATE work_orders SET ${sets.join(', ')} WHERE id = $1`,
      values,
    )
    return this.getWorkOrder(id)
  }

  /* --- Escalations ----------------------------------------------------------- */

  private toEscalation(row: Record<string, unknown>): Escalation {
    return {
      id: row.id as string,
      segmentId: row.segment_id as number,
      segmentName: (row.segment_name as string) ?? '',
      status: row.status as Escalation['status'],
      authority: {
        kind: row.authority_kind as Escalation['authority']['kind'],
        name: row.authority_name as string,
        email: (row.authority_email as string) ?? '',
      },
      subject: row.subject as string,
      body: row.body as string,
      location: {
        lat: num(row.lat),
        lon: num(row.lon),
        mapsUrl: row.maps_url as string,
      },
      severity: row.severity as Escalation['severity'],
      photoReportIds: (row.photo_report_ids as string[]) ?? [],
      estimatedCostInr: num(row.estimated_cost_inr),
      createdAt: (row.created_at as Date).toISOString(),
      approvedAt: row.approved_at
        ? (row.approved_at as Date).toISOString()
        : undefined,
      sentAt: row.sent_at ? (row.sent_at as Date).toISOString() : undefined,
      dismissedReason: (row.dismissed_reason as string) ?? undefined,
    }
  }

  private readonly escalationSelect = `
    SELECT e.*, s.name AS segment_name
    FROM escalations e
    JOIN segments s ON s.id = e.segment_id
  `

  async listEscalations(): Promise<Escalation[]> {
    const { rows } = await this.pool.query(
      `${this.escalationSelect} ORDER BY e.created_at DESC`,
    )
    return rows.map((r) => this.toEscalation(r))
  }

  async getEscalation(id: string): Promise<Escalation | null> {
    const { rows } = await this.pool.query(
      `${this.escalationSelect} WHERE e.id = $1`,
      [id],
    )
    return rows[0] ? this.toEscalation(rows[0]) : null
  }

  async insertEscalation(escalation: Escalation): Promise<Escalation> {
    await this.pool.query(
      `INSERT INTO escalations
         (id, segment_id, status, authority_kind, authority_name, authority_email,
          subject, body, lat, lon, maps_url, severity, photo_report_ids,
          estimated_cost_inr, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        escalation.id,
        escalation.segmentId,
        escalation.status,
        escalation.authority.kind,
        escalation.authority.name,
        escalation.authority.email,
        escalation.subject,
        escalation.body,
        escalation.location.lat,
        escalation.location.lon,
        escalation.location.mapsUrl,
        escalation.severity,
        escalation.photoReportIds,
        escalation.estimatedCostInr,
        escalation.createdAt,
      ],
    )
    return escalation
  }

  async updateEscalation(
    id: string,
    patch: Partial<Escalation>,
  ): Promise<Escalation | null> {
    const sets: string[] = []
    const values: unknown[] = [id]

    const assign = (column: string, value: unknown) => {
      values.push(value)
      sets.push(`${column} = $${values.length}`)
    }

    if (patch.status !== undefined) assign('status', patch.status)
    if (patch.approvedAt !== undefined) assign('approved_at', patch.approvedAt)
    if (patch.sentAt !== undefined) assign('sent_at', patch.sentAt)
    if (patch.dismissedReason !== undefined) {
      assign('dismissed_reason', patch.dismissedReason)
    }
    if (sets.length === 0) return this.getEscalation(id)

    await this.pool.query(
      `UPDATE escalations SET ${sets.join(', ')} WHERE id = $1`,
      values,
    )
    return this.getEscalation(id)
  }

  async lastEscalatedAt(segmentId: number): Promise<string | null> {
    // A dismissed draft does not start a cooldown: someone decided that one
    // was not worth sending, which should not block a later, worse reading.
    const { rows } = await this.pool.query(
      `SELECT max(created_at) AS last FROM escalations
       WHERE segment_id = $1 AND status <> 'dismissed'`,
      [segmentId],
    )
    return rows[0]?.last ? (rows[0].last as Date).toISOString() : null
  }

  /* --- Demo ------------------------------------------------------------------- */

  async reset(): Promise<void> {
    if (process.env.NODE_ENV === 'production') {
      throw ApiError.conflict('Reset is not available against a live database.')
    }

    // The road network survives: re-importing it is a separate, slow step.
    await this.pool.query(
      `TRUNCATE bump_observations, photo_reports, work_order_events,
                work_orders, escalations RESTART IDENTITY CASCADE`,
    )
  }
}

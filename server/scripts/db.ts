/* Setting up, filling and checking a Postgres database.
 *
 *   npm run db:migrate   apply db/schema.sql
 *   npm run db:import    load the road network, and backfill seeded history
 *   npm run db:check     exercise every Repository method against the database
 *
 * `db:check` exists because PostgresRepository cannot be unit tested without a
 * database, and shipping an unverified data layer is how a demo dies on stage.
 * It writes only to its own scratch rows and cleans up after itself.
 */

import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import {
  generatePhotoReports,
  generateWorkOrders,
  segmentsFromGeoJson,
  simulateSegment,
  statusFor,
} from '@shared/simulate'
import { PostgresRepository } from '../src/repository/PostgresRepository.js'
// Imported for its side effect: it loads .env before DATABASE_URL is read.
import '../src/env.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCHEMA = resolve(HERE, '../db/schema.sql')
const MIGRATIONS = resolve(HERE, '../db/migrations')
const SEGMENTS = resolve(HERE, '../../public/data/segments.geojson')

function connectionString(): string {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL is not set.')
    console.error(
      'Copy .env.example to .env and put your connection string in it.',
    )
    process.exit(1)
  }
  return url
}

function pool(): pg.Pool {
  const url = connectionString()
  return new pg.Pool({
    connectionString: url,
    ssl: url.includes('localhost') ? undefined : { rejectUnauthorized: false },
    options: '-c search_path=public,extensions',
  })
}

/* --- migrate ------------------------------------------------------------- */

/*
 * PostGIS, wherever this provider likes to keep it.
 *
 * Supabase installs extensions into an `extensions` schema rather than
 * `public`, so a bare `CREATE EXTENSION postgis` may land the geometry type
 * somewhere the schema cannot see, and every `geometry(LineString, 4326)`
 * column fails with "type does not exist". Asking for that schema explicitly
 * works there, and falling back covers Neon, RDS and a local instance, which
 * put it in public.
 */
async function enablePostgis(db: pg.Pool) {
  try {
    await db.query('CREATE SCHEMA IF NOT EXISTS extensions')
    await db.query(
      'CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA extensions',
    )
    console.log('PostGIS enabled in the extensions schema.')
  } catch {
    await db.query('CREATE EXTENSION IF NOT EXISTS postgis')
    console.log('PostGIS enabled.')
  }

  // Whichever schema it landed in, make the type resolvable for the rest of
  // this migration and for every later connection.
  await db.query('SET search_path TO public, extensions')
  try {
    const { rows } = await db.query<{ current_database: string }>(
      'SELECT current_database()',
    )
    await db.query(
      `ALTER DATABASE "${rows[0].current_database}" SET search_path TO public, extensions`,
    )
  } catch {
    // Managed providers may not allow ALTER DATABASE. The pool sets the same
    // search_path per connection, so this is belt and braces.
    console.log(
      '(could not set the database search_path; the pool sets it per connection)',
    )
  }
}

async function migrate() {
  const db = pool()
  await enablePostgis(db)

  try {
    // The baseline, applied only to an empty database. After that it is
    // history: changes go in db/migrations as numbered files.
    const { rows } = await db.query<{ exists: boolean }>(
      `SELECT to_regclass('public.segments') IS NOT NULL AS exists`,
    )

    if (!rows[0].exists) {
      console.log('Applying db/schema.sql (baseline)...')
      await db.query(await readFile(SCHEMA, 'utf-8'))
      console.log('Baseline applied.')
    } else {
      console.log('Baseline already present.')
    }

    await db.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    )

    const { readdir } = await import('node:fs/promises')
    let files: string[] = []
    try {
      files = (await readdir(MIGRATIONS))
        .filter((f) => f.endsWith('.sql'))
        .sort()
    } catch {
      files = []
    }

    const applied = new Set(
      (
        await db.query<{ name: string }>('SELECT name FROM schema_migrations')
      ).rows.map((r) => r.name),
    )

    let count = 0
    for (const file of files) {
      if (applied.has(file)) continue

      // Each migration is one transaction: a half-applied schema change is
      // far worse to recover from than one that did not run.
      const client = await db.connect()
      try {
        await client.query('BEGIN')
        await client.query(await readFile(resolve(MIGRATIONS, file), 'utf-8'))
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [
          file,
        ])
        await client.query('COMMIT')
        console.log(`  applied ${file}`)
        count++
      } catch (error) {
        await client.query('ROLLBACK')
        throw new Error(`${file} failed: ${(error as Error).message}`)
      } finally {
        client.release()
      }
    }

    console.log(
      count === 0 ? 'No new migrations.' : `${count} migration(s) applied.`,
    )
  } finally {
    await db.end()
  }
}

/* --- import -------------------------------------------------------------- */

async function importData() {
  const db = pool()
  const geojson = JSON.parse(await readFile(SEGMENTS, 'utf-8'))
  const segments = segmentsFromGeoJson(geojson)

  console.log(`Importing ${segments.length} segments...`)

  // One transaction: a half-imported network is worse than none.
  const client = await db.connect()
  try {
    await client.query('BEGIN')

    for (const segment of segments) {
      const line = `LINESTRING(${segment.path.map(([lon, lat]) => `${lon} ${lat}`).join(', ')})`
      const [clon, clat] = segment.center

      await client.query(
        `INSERT INTO segments
           (id, osm_way_id, name, highway, road_class, length_m,
            near_sensitive, bus_route, geom, center, region_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,
                 ST_GeomFromText($9, 4326),
                 ST_SetSRID(ST_MakePoint($10, $11), 4326), $12)
         ON CONFLICT (id) DO NOTHING`,
        [
          segment.id,
          0,
          segment.name,
          segment.highway,
          segment.roadClass,
          segment.lengthM,
          segment.nearSensitive,
          segment.busRoute,
          line,
          clon,
          clat,
          1,
        ],
      )
    }

    console.log('Backfilling 180 days of seeded history...')

    const scores = new Map<number, number>()
    for (const segment of segments) {
      const sim = simulateSegment(segment)
      scores.set(segment.id, sim.history[sim.history.length - 1].score)

      // Marked simulated, so a chart can say which part is modelled rather
      // than measured. That distinction has to survive into the database.
      const values: unknown[] = []
      const tuples = sim.history.map((day, i) => {
        values.push(segment.id, day.day, day.score)
        return `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3}, true)`
      })

      await client.query(
        `INSERT INTO segment_daily_scores (segment_id, day, score, simulated)
         VALUES ${tuples.join(', ')}
         ON CONFLICT (segment_id, day) DO NOTHING`,
        values,
      )
    }

    const photos = generatePhotoReports(segments, scores)
    for (const photo of photos) {
      await client.query(
        `INSERT INTO photo_reports
           (id, segment_id, image_url, label, confidence,
            box_x, box_y, box_w, box_h, severity, status, reporter,
            created_at, reviewed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (id) DO NOTHING`,
        [
          photo.id,
          photo.segmentId,
          photo.imageUrl,
          photo.label,
          photo.confidence,
          photo.box.x,
          photo.box.y,
          photo.box.w,
          photo.box.h,
          photo.severity,
          photo.status,
          photo.reporter,
          photo.createdAt,
          // Decided here rather than in SQL: reusing the status parameter in
          // a CASE made Postgres try to read it as both photo_status and
          // text in one statement, which it will not do.
          photo.status === 'pending' ? null : photo.createdAt,
        ],
      )
    }

    const statuses = segments.map((segment) =>
      statusFor(
        segment,
        {
          history: simulateSegment(segment).history,
          breakdown: {
            base: 100,
            bumpPenalty: 0,
            roughnessPenalty: 0,
            photoPenalty: 0,
          },
          bumpsLast7Days: 0,
        },
        0,
      ),
    )

    for (const order of generateWorkOrders(segments, statuses)) {
      await client.query(
        `INSERT INTO work_orders
           (id, segment_id, status, assignee, cost_inr, repair_type,
            bump_rate_before, bump_rate_after, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT DO NOTHING`,
        [
          order.id,
          order.segmentId,
          order.status,
          order.assignee,
          order.costInr,
          order.repairType,
          order.bumpRateBefore,
          order.bumpRateAfter ?? null,
          order.createdAt,
          order.updatedAt,
        ],
      )
    }

    await client.query('COMMIT')
    console.log(
      `Imported ${segments.length} segments, ${photos.length} photo reports.`,
    )
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
    await db.end()
  }
}

/* --- check --------------------------------------------------------------- */

async function check() {
  const repo = new PostgresRepository(connectionString())
  let failures = 0

  async function step(name: string, fn: () => Promise<string>) {
    try {
      const detail = await fn()
      console.log(`  ok    ${name} — ${detail}`)
    } catch (error) {
      failures++
      console.error(`  FAIL  ${name} — ${(error as Error).message}`)
    }
  }

  console.log('Checking PostgresRepository against the live database.\n')

  const segments = await repo.listSegments()
  await step('listSegments', async () => {
    if (segments.length === 0) throw new Error('no segments — run db:import')
    const first = segments[0]
    if (first.path.length < 2) throw new Error('geometry did not round-trip')
    return `${segments.length} segments, first has ${first.path.length} points`
  })

  const probe = segments[Math.floor(segments.length / 2)]

  await step('getSegment', async () => {
    const one = await repo.getSegment(probe.id)
    if (!one) throw new Error('not found')
    if (one.name !== probe.name) throw new Error('wrong row')
    return one.name
  })

  await step('listHistory', async () => {
    const history = await repo.listHistory(probe.id)
    if (history.length === 0) throw new Error('empty — run db:import')
    return `${history.length} days`
  })

  await step('listRecentHistories', async () => {
    const histories = await repo.listRecentHistories(30)
    if (histories.size === 0) throw new Error('empty')
    return `${histories.size} segments in one query`
  })

  await step('listLatestScores', async () => {
    const scores = await repo.listLatestScores()
    return `${scores.size} scores`
  })

  await step('insertBumps and count', async () => {
    const at = new Date()
    await repo.insertBumps([
      {
        id: crypto.randomUUID(),
        segmentId: probe.id,
        at,
        lon: probe.center[0],
        lat: probe.center[1],
        magnitude: 12.5,
        speedMs: 11,
        deviceId: 'db-check',
        tripId: 'db-check',
      },
    ])

    const since = new Date(Date.now() - 60_000)
    const counts = await repo.countBumpsSince(since)
    const one = await repo.countBumpsForSegment(probe.id, since)
    if (one < 1) throw new Error('inserted bump was not counted')
    return `${counts.size} segments with recent impacts`
  })

  await step('work order status flow', async () => {
    const id = `WO-CHECK-${Date.now()}`
    const [created] = await repo.insertWorkOrders([
      {
        id,
        segmentId: probe.id,
        segmentName: probe.name,
        status: 'open',
        assignee: 'db-check',
        costInr: 1000,
        repairType: 'patching',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        bumpRateBefore: 1,
      },
    ])
    if (!created) throw new Error('insert returned nothing')

    const moved = await repo.updateWorkOrder(id, { status: 'in-progress' })
    if (moved?.status !== 'in-progress') throw new Error('update did not apply')
    return 'insert and update round-tripped'
  })

  await step('one live work order per segment', async () => {
    // The partial unique index is the only thing that can enforce this under
    // concurrency, so it is worth confirming it exists and bites.
    const second = await repo.insertWorkOrders([
      {
        id: `WO-CHECK-DUP-${Date.now()}`,
        segmentId: probe.id,
        segmentName: probe.name,
        status: 'open',
        assignee: 'db-check',
        costInr: 1000,
        repairType: 'patching',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        bumpRateBefore: 1,
      },
    ])
    if (second.length !== 0) {
      throw new Error('a second live order was allowed on the same segment')
    }
    return 'duplicate refused by the database'
  })

  await step('photo report status', async () => {
    const reports = await repo.listPhotoReports()
    if (reports.length === 0) throw new Error('none — run db:import')
    const first = reports[0]
    const updated = await repo.setPhotoStatus(first.id, 'approved')
    if (updated?.status !== 'approved') throw new Error('status did not stick')
    await repo.setPhotoStatus(first.id, first.status)
    return `${reports.length} reports`
  })

  await step('escalation round trip', async () => {
    const id = `IP-CHECK-${Date.now()}`
    await repo.insertEscalation({
      id,
      segmentId: probe.id,
      segmentName: probe.name,
      status: 'draft',
      authority: { kind: 'municipal', name: 'db-check', email: '' },
      subject: 'check',
      body: 'check',
      location: { lat: probe.center[1], lon: probe.center[0], mapsUrl: 'x' },
      severity: 'critical',
      photoReportIds: [],
      estimatedCostInr: 1,
      createdAt: new Date().toISOString(),
    })

    const approved = await repo.updateEscalation(id, {
      status: 'approved',
      approvedAt: new Date().toISOString(),
    })
    if (approved?.status !== 'approved') throw new Error('update did not apply')

    const last = await repo.lastEscalatedAt(probe.id)
    if (!last) throw new Error('cooldown lookup returned nothing')
    return 'insert, update and cooldown lookup all work'
  })

  console.log('\nCleaning up check rows...')
  const db = pool()
  await db.query(`DELETE FROM work_orders WHERE assignee = 'db-check'`)
  await db.query(`DELETE FROM escalations WHERE authority_name = 'db-check'`)
  await db.query(`DELETE FROM bump_observations WHERE device_id = 'db-check'`)
  await db.end()
  await repo.close()

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`)
    process.exit(1)
  }
  console.log('\nAll checks passed. The database is ready.')
}

const command = process.argv[2]
const commands: Record<string, () => Promise<void>> = {
  migrate,
  import: importData,
  check,
}

if (!commands[command]) {
  console.error('Usage: tsx scripts/db.ts <migrate|import|check>')
  process.exit(1)
}

commands[command]().catch((error) => {
  console.error(error)
  process.exit(1)
})

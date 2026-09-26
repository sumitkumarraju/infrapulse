import type { Segment } from '@shared/contract'

/* Matching a reported impact to a stretch of road.
 *
 * A phone reports a latitude and longitude; the network is 1,100 polylines of
 * about 50 metres each. Getting this wrong puts a pothole on the wrong street,
 * so the match is to the nearest point on a segment's line, not to its
 * midpoint — a 50m segment's midpoint can be 25m from an impact that is
 * actually on it.
 *
 * A Postgres implementation would hand this to PostGIS
 * (`ORDER BY geom <-> ST_Point(lon, lat) LIMIT 1`, with a GiST index). This
 * module exists so the in-memory repository can answer the same question, and
 * so the matching rule is written down in one testable place.
 */

/** Beyond this, an impact is assumed to be off the mapped network. */
export const MAX_MATCH_DISTANCE_M = 40

const METRES_PER_DEGREE_LAT = 110_540

function metresPerDegreeLon(lat: number): number {
  return 111_320 * Math.cos((lat * Math.PI) / 180)
}

/** Squared distance in metres from a point to a segment of a line. */
function distanceToSegmentSq(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax
  const dy = by - ay

  if (dx === 0 && dy === 0) return (px - ax) ** 2 + (py - ay) ** 2

  // Project the point onto the line, clamped to the segment's ends.
  const t = Math.max(
    0,
    Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)),
  )
  const cx = ax + t * dx
  const cy = ay + t * dy

  return (px - cx) ** 2 + (py - cy) ** 2
}

export interface SpatialIndex {
  nearest(
    lon: number,
    lat: number,
  ): { segmentId: number; distanceM: number } | null
}

/**
 * A uniform grid over the bounding box. With ~1,100 segments a linear scan
 * would also be fast enough, but ingest is the one endpoint that takes a whole
 * trip's worth of points at once, and a grid keeps that O(bumps) rather than
 * O(bumps × segments).
 */
export function buildSpatialIndex(segments: Segment[]): SpatialIndex {
  if (segments.length === 0) {
    return { nearest: () => null }
  }

  let minLon = Infinity
  let minLat = Infinity
  let maxLon = -Infinity
  let maxLat = -Infinity

  for (const segment of segments) {
    for (const [lon, lat] of segment.path) {
      if (lon < minLon) minLon = lon
      if (lat < minLat) minLat = lat
      if (lon > maxLon) maxLon = lon
      if (lat > maxLat) maxLat = lat
    }
  }

  // ~100m cells: big enough that a match is almost always in the cell or its
  // immediate neighbours, small enough that cells stay short.
  const midLat = (minLat + maxLat) / 2
  const cellLat = 100 / METRES_PER_DEGREE_LAT
  const cellLon = 100 / metresPerDegreeLon(midLat)

  const cells = new Map<string, number[]>()
  const key = (cx: number, cy: number) => `${cx}:${cy}`

  for (const segment of segments) {
    // Every cell the polyline's own points fall in, plus the cells between
    // them would be ideal; at 50m per segment against 100m cells, the endpoints
    // plus a neighbour sweep at query time covers it.
    const seen = new Set<string>()
    for (const [lon, lat] of segment.path) {
      const cx = Math.floor((lon - minLon) / cellLon)
      const cy = Math.floor((lat - minLat) / cellLat)
      const k = key(cx, cy)
      if (seen.has(k)) continue
      seen.add(k)
      const bucket = cells.get(k)
      if (bucket) bucket.push(segment.id)
      else cells.set(k, [segment.id])
    }
  }

  const byId = new Map(segments.map((s) => [s.id, s]))

  return {
    nearest(lon, lat) {
      const cx = Math.floor((lon - minLon) / cellLon)
      const cy = Math.floor((lat - minLat) / cellLat)

      const candidates = new Set<number>()
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (const id of cells.get(key(cx + dx, cy + dy)) ?? []) {
            candidates.add(id)
          }
        }
      }

      // Nothing nearby: fall back to a full scan rather than silently dropping
      // the observation. This is rare, and an unmatched bump is a real signal
      // that the network needs re-importing.
      const pool = candidates.size > 0 ? candidates : byId.keys()

      const mPerLon = metresPerDegreeLon(lat)
      let bestId: number | null = null
      let bestSq = Infinity

      for (const id of pool) {
        const segment = byId.get(id)
        if (!segment) continue

        for (let i = 1; i < segment.path.length; i++) {
          const [ax, ay] = segment.path[i - 1]
          const [bx, by] = segment.path[i]
          const d = distanceToSegmentSq(
            lon * mPerLon,
            lat * METRES_PER_DEGREE_LAT,
            ax * mPerLon,
            ay * METRES_PER_DEGREE_LAT,
            bx * mPerLon,
            by * METRES_PER_DEGREE_LAT,
          )
          if (d < bestSq) {
            bestSq = d
            bestId = id
          }
        }
      }

      if (bestId === null) return null
      const distanceM = Math.sqrt(bestSq)
      return distanceM <= MAX_MATCH_DISTANCE_M
        ? { segmentId: bestId, distanceM }
        : null
    },
  }
}

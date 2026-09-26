/* Downloads real roads around Chandigarh University, Gharuan from the Overpass
 * API, cuts them into 50m segments, and writes public/data/segments.geojson.
 *
 * Run once: `npm run fetch-roads`. The output is committed, so the app never
 * depends on Overpass being up — and neither does the demo.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { lineChunk, lineString, point } from '@turf/turf'
import distance from '@turf/distance'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(HERE, '../public/data/segments.geojson')

/** Chandigarh University, Gharuan. */
const CENTER = { lat: 30.768, lon: 76.575 }
/** Roughly a 3km x 3km box. */
const HALF_LAT = 0.0135
const HALF_LON = 0.0157

const BBOX = [
  CENTER.lat - HALF_LAT,
  CENTER.lon - HALF_LON,
  CENTER.lat + HALF_LAT,
  CENTER.lon + HALF_LON,
].join(',')

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
]

const QUERY = `
[out:json][timeout:90];
(
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street)$"](${BBOX});
);
out geom;
`

const POI_QUERY = `
[out:json][timeout:90];
(
  node["amenity"~"^(school|college|university|hospital|clinic)$"](${BBOX});
  way["amenity"~"^(school|college|university|hospital|clinic)$"](${BBOX});
);
out center;
`

export type RoadClass = 'arterial' | 'collector' | 'local'

/** OSM highway tag to the three classes the model uses (CLAUDE.md 4.2). */
export function roadClassOf(highway: string): RoadClass {
  if (['motorway', 'trunk', 'primary', 'secondary'].includes(highway)) {
    return 'arterial'
  }
  if (highway === 'tertiary') return 'collector'
  return 'local'
}

interface OverpassWay {
  id: number
  tags?: Record<string, string>
  geometry?: { lat: number; lon: number }[]
}

interface OverpassPoi {
  lat?: number
  lon?: number
  center?: { lat: number; lon: number }
  tags?: Record<string, string>
}

async function overpass<T>(query: string): Promise<T[]> {
  let lastError: unknown
  for (const endpoint of ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        body: query,
        headers: {
          'Content-Type': 'text/plain;charset=UTF-8',
          // Overpass answers 406 to clients that do not identify themselves.
          'User-Agent': 'infrapulse-road-fetch/1.0',
          Accept: 'application/json',
        },
      })
      if (!res.ok) throw new Error(`${endpoint} returned ${res.status}`)
      const json = (await res.json()) as { elements: T[] }
      return json.elements
    } catch (error) {
      lastError = error
      console.warn(`  ${endpoint} failed: ${String(error)}`)
    }
  }
  throw lastError
}

/**
 * Fallback when Overpass is unreachable: a plausible street grid at the same
 * location, so the demo still has roads to render (CLAUDE.md 4.2).
 */
function syntheticGrid(): OverpassWay[] {
  const ways: OverpassWay[] = []
  const rows = 11
  const cols = 11
  let id = 900_000

  for (let i = 0; i < rows; i++) {
    const lat = CENTER.lat - HALF_LAT + (2 * HALF_LAT * i) / (rows - 1)
    ways.push({
      id: id++,
      tags: {
        highway:
          i % 5 === 0 ? 'secondary' : i % 2 === 0 ? 'tertiary' : 'residential',
        name: `Synthetic Road E${i + 1}`,
      },
      geometry: [
        { lat, lon: CENTER.lon - HALF_LON },
        { lat, lon: CENTER.lon + HALF_LON },
      ],
    })
  }

  for (let j = 0; j < cols; j++) {
    const lon = CENTER.lon - HALF_LON + (2 * HALF_LON * j) / (cols - 1)
    ways.push({
      id: id++,
      tags: {
        highway:
          j % 5 === 0 ? 'primary' : j % 3 === 0 ? 'tertiary' : 'residential',
        name: `Synthetic Road N${j + 1}`,
      },
      geometry: [
        { lat: CENTER.lat - HALF_LAT, lon },
        { lat: CENTER.lat + HALF_LAT, lon },
      ],
    })
  }

  return ways
}

async function main() {
  console.log('Fetching roads from Overpass...')

  let ways: OverpassWay[]
  let pois: { lat: number; lon: number; kind: string }[] = []
  let source: 'overpass' | 'synthetic' = 'overpass'

  try {
    ways = await overpass<OverpassWay>(QUERY)
    console.log(`  ${ways.length} ways`)
  } catch {
    console.warn('Overpass unreachable — falling back to a synthetic grid.')
    ways = syntheticGrid()
    source = 'synthetic'
  }

  if (source === 'overpass') {
    try {
      const raw = await overpass<OverpassPoi>(POI_QUERY)
      pois = raw
        .map((p) => ({
          lat: p.lat ?? p.center?.lat,
          lon: p.lon ?? p.center?.lon,
          kind: p.tags?.amenity ?? 'school',
        }))
        .filter(
          (p): p is { lat: number; lon: number; kind: string } =>
            Number.isFinite(p.lat) && Number.isFinite(p.lon),
        )
      console.log(`  ${pois.length} schools and hospitals`)
    } catch {
      console.warn('  POI query failed; no sensitive-site flags.')
    }
  }

  if (pois.length === 0) {
    // Chandigarh University itself is the anchor sensitive site.
    pois = [{ lat: CENTER.lat, lon: CENTER.lon, kind: 'university' }]
  }

  const features: GeoJSON.Feature[] = []
  let id = 0

  for (const way of ways) {
    const geom = way.geometry
    if (!geom || geom.length < 2) continue

    const coords = geom.map((g) => [g.lon, g.lat] as [number, number])
    const highway = way.tags?.highway ?? 'residential'
    const name = way.tags?.name ?? `Unnamed ${highway}`

    // 50m pieces, so a pothole affects one addressable stretch of road.
    const chunks = lineChunk(lineString(coords), 0.05, { units: 'kilometers' })

    for (const chunk of chunks.features) {
      const line = chunk.geometry.coordinates as [number, number][]
      if (line.length < 2) continue

      const mid = line[Math.floor(line.length / 2)]
      const midPoint = point(mid)

      let nearSensitive = false
      for (const poi of pois) {
        if (distance(midPoint, point([poi.lon, poi.lat])) <= 0.3) {
          nearSensitive = true
          break
        }
      }

      // Length in metres, measured rather than assumed — lineChunk leaves a
      // short remainder at the end of every way.
      let length = 0
      for (let i = 1; i < line.length; i++) {
        length += distance(point(line[i - 1]), point(line[i])) * 1000
      }

      features.push({
        type: 'Feature',
        id,
        geometry: { type: 'LineString', coordinates: line },
        properties: {
          id,
          osmWayId: way.id,
          name,
          highway,
          roadClass: roadClassOf(highway),
          lengthM: Math.round(length * 10) / 10,
          nearSensitive,
          // A rough bus-route proxy: arterials carry the buses here.
          busRoute: roadClassOf(highway) === 'arterial',
        },
      })
      id++
    }
  }

  const collection = {
    type: 'FeatureCollection' as const,
    metadata: {
      source,
      center: CENTER,
      generatedAt: new Date().toISOString(),
      segmentCount: features.length,
    },
    features,
  }

  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify(collection))

  const byClass = features.reduce<Record<string, number>>((acc, f) => {
    const k = (f.properties as { roadClass: string }).roadClass
    acc[k] = (acc[k] ?? 0) + 1
    return acc
  }, {})

  console.log(`Wrote ${features.length} segments to ${OUT}`)
  console.log('  by class:', byClass)
  console.log(
    `  near a school or hospital: ${features.filter((f) => (f.properties as { nearSensitive: boolean }).nearSensitive).length}`,
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

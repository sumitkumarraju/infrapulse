import { chunkLine, lengthOf, metresBetween } from '@shared/chunk'
import { midpointOf } from '@shared/simulate'
import type { RoadClass, Segment } from '@shared/contract'
import { clampPlaceBox, findCuratedPlaces } from '@shared/places'

/* Importing a region's roads at runtime.
 *
 * The original network was fetched once by a script and committed, which is
 * right for a demo pinned to one campus and useless for anywhere else. This is
 * the same work done on demand, so the product is a road-condition system
 * rather than a road-condition system for Gharuan.
 */

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
]

/** Pieces a road is cut into, in metres. */
export const SEGMENT_LENGTH_M = 50

/**
 * How large an area one import may cover, in square degrees.
 *
 * Overpass is a shared public service with no charge and no quota to buy; a
 * request for a whole state would be refused by them and would deserve to be.
 * Roughly a city at this size. Larger areas are legitimate — they just have to
 * be imported as several regions.
 */
export const MAX_AREA_SQ_DEG = 0.25

export interface BoundingBox {
  south: number
  west: number
  north: number
  east: number
}

export class ImportError extends Error {}

export function validateBox(box: BoundingBox): void {
  const { south, west, north, east } = box

  if (
    [south, west, north, east].some((v) => !Number.isFinite(v)) ||
    south < -90 ||
    north > 90 ||
    west < -180 ||
    east > 180
  ) {
    throw new ImportError('Those coordinates are not on Earth.')
  }

  if (north <= south || east <= west) {
    throw new ImportError(
      'The north-east corner must be north and east of the south-west corner.',
    )
  }

  const area = (north - south) * (east - west)
  if (area > MAX_AREA_SQ_DEG) {
    throw new ImportError(
      `That area is too large for one import (${area.toFixed(2)} sq deg, limit ${MAX_AREA_SQ_DEG}). Import it as several smaller regions.`,
    )
  }
}

/** OSM highway tag to the three classes the priority model weights. */
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
}

/**
 * How long to wait on one mirror before giving up on it.
 *
 * Overpass is free and shared, and under load it will hold a connection open
 * for minutes before answering 504. Without a deadline the caller's HTTP
 * request hangs for as long as that takes — nearly four minutes, in the run
 * that prompted this — which reads as a broken application rather than a busy
 * third party. Better to fail the mirror quickly and try the other one.
 */
const ENDPOINT_TIMEOUT_MS = 45_000

async function overpass<T>(query: string, signal?: AbortSignal): Promise<T[]> {
  let lastError: unknown

  for (const endpoint of ENDPOINTS) {
    try {
      const deadline = AbortSignal.timeout(ENDPOINT_TIMEOUT_MS)
      const response = await fetch(endpoint, {
        method: 'POST',
        body: query,
        headers: {
          'Content-Type': 'text/plain;charset=UTF-8',
          // Overpass answers 406 to clients that do not identify themselves.
          'User-Agent': 'infrapulse/1.0 (road condition monitoring)',
          Accept: 'application/json',
        },
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      })

      if (response.status === 429 || response.status === 504) {
        // Busy rather than broken: worth trying the other mirror.
        throw new Error(`${endpoint} is busy (${response.status})`)
      }
      if (!response.ok) {
        throw new Error(`${endpoint} returned ${response.status}`)
      }

      const json = (await response.json()) as { elements: T[] }
      return json.elements
    } catch (error) {
      lastError = error
    }
  }

  const detail = (lastError as Error)?.message ?? ''
  throw new ImportError(
    detail.includes('timed out') || detail.includes('busy')
      ? 'OpenStreetMap is busy right now. It is a free shared service — wait a minute and try again, or try a smaller area.'
      : `Could not reach OpenStreetMap. ${detail}`.trim(),
  )
}

export interface ImportedRegion {
  segments: Omit<Segment, 'id'>[]
  sensitiveSites: number
  waysFound: number
}

/**
 * Fetches a bounding box of roads and cuts them into segments.
 *
 * Returns segments without ids: the caller assigns them, because uniqueness is
 * a property of the store rather than of the import.
 */
export async function importRegion(
  box: BoundingBox,
  signal?: AbortSignal,
): Promise<ImportedRegion> {
  validateBox(box)

  const bbox = `${box.south},${box.west},${box.north},${box.east}`

  const roadQuery = `
[out:json][timeout:90];
(
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street)$"](${bbox});
);
out geom;
`

  // Schools and hospitals raise a road's repair priority by half again, so
  // they are worth a second request.
  const poiQuery = `
[out:json][timeout:90];
(
  node["amenity"~"^(school|college|university|hospital|clinic)$"](${bbox});
  way["amenity"~"^(school|college|university|hospital|clinic)$"](${bbox});
);
out center;
`

  const ways = await overpass<OverpassWay>(roadQuery, signal)

  let sites: [number, number][] = []
  try {
    const pois = await overpass<OverpassPoi>(poiQuery, signal)
    sites = pois
      .map((p) => [p.lon ?? p.center?.lon, p.lat ?? p.center?.lat])
      .filter(
        (p): p is [number, number] =>
          Number.isFinite(p[0]) && Number.isFinite(p[1]),
      )
  } catch {
    // Not worth failing an import over: the flag only adjusts priority.
  }

  const segments: Omit<Segment, 'id'>[] = []

  for (const way of ways) {
    const geometry = way.geometry
    if (!geometry || geometry.length < 2) continue

    const coordinates = geometry.map((g) => [g.lon, g.lat] as [number, number])
    const highway = way.tags?.highway ?? 'residential'
    const name = way.tags?.name ?? `Unnamed ${highway}`
    const roadClass = roadClassOf(highway)

    for (const piece of chunkLine(coordinates, SEGMENT_LENGTH_M)) {
      if (piece.length < 2) continue
      const centre = midpointOf(piece)

      segments.push({
        name,
        highway,
        roadClass,
        lengthM: Math.round(lengthOf(piece) * 10) / 10,
        nearSensitive: sites.some((site) => metresBetween(centre, site) <= 300),
        // A rough proxy until a transit feed says otherwise.
        busRoute: roadClass === 'arterial',
        path: piece,
        center: centre,
      })
    }
  }

  if (segments.length === 0) {
    throw new ImportError(
      'OpenStreetMap has no mapped roads in that area. Try a larger box, or somewhere more built up.',
    )
  }

  return { segments, sensitiveSites: sites.length, waysFound: ways.length }
}

/**
 * Turns a place name into a bounding box, so a person can type "Ludhiana"
 * rather than four decimal numbers.
 */
export interface Place {
  name: string
  box: BoundingBox
}

export async function searchPlace(
  query: string,
  signal?: AbortSignal,
): Promise<Place[]> {
  const url = new URL('https://nominatim.openstreetmap.org/search')
  url.searchParams.set('q', query)
  url.searchParams.set('format', 'json')
  url.searchParams.set('limit', '5')

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'infrapulse/1.0 (contact: team@infrapulse.org)',
        Accept: 'application/json',
      },
      signal,
    })

    if (response.ok) {
      const results = (await response.json()) as {
        display_name: string
        boundingbox: [string, string, string, string]
      }[]

      if (Array.isArray(results) && results.length > 0) {
        return results.map((result) => {
          const [south, north, west, east] = result.boundingbox.map(Number)
          return {
            name: result.display_name,
            box: clampPlaceBox({ south, north, west, east }),
          }
        })
      }
    }
  } catch {
    // If Nominatim is slow or unreachable, fall through to curated places.
  }

  const curated = findCuratedPlaces(query)
  if (curated.length > 0) {
    return curated.map((c) => ({
      name: c.name,
      box: clampPlaceBox(c.box),
    }))
  }

  return []
}

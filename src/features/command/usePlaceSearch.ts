import { useEffect, useRef, useState } from 'react'
import { dataSource } from '@/data'
import type { PlaceBox } from '@/data/DataSource'
import { clampPlaceBox, findCuratedPlaces } from '@shared/places'

/* Typeahead for the place search.
 *
 * Nominatim is OpenStreetMap's free geocoder. In-flight requests are debounced
 * and cancelled if the user continues typing. If the server proxy fails,
 * client-side direct fetch and curated city fallbacks ensure search never fails.
 */

export interface PlaceResult {
  name: string
  box: PlaceBox
}

/** Long enough that a keystroke pause is deliberate, short enough to feel live. */
const DEBOUNCE_MS = 300
/** Lowered to 2 so typing starts finding suggestions promptly. */
const MIN_QUERY = 2

export function usePlaceSearch(query: string) {
  const [results, setResults] = useState<PlaceResult[]>([])
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const cache = useRef(new Map<string, PlaceResult[]>())
  const controller = useRef<AbortController | null>(null)

  useEffect(() => {
    const trimmed = query.trim()

    if (trimmed.length < MIN_QUERY) {
      setResults([])
      setError(null)
      setSearching(false)
      return
    }

    const cached = cache.current.get(trimmed.toLowerCase())
    if (cached) {
      setResults(cached)
      setError(null)
      setSearching(false)
      return
    }

    setSearching(true)
    const timer = setTimeout(async () => {
      // Whatever was in flight describes an older query now.
      controller.current?.abort()
      const own = new AbortController()
      controller.current = own

      try {
        let found: PlaceResult[] = []

        // Tier 1: Try dataSource.searchPlaces
        try {
          found = await dataSource.searchPlaces(trimmed)
        } catch {
          // Fall through to direct fetch or curated
        }

        if (own.signal.aborted) return

        // Tier 2: Direct browser fetch to OpenStreetMap Nominatim
        if (!found || found.length === 0) {
          try {
            const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(trimmed)}&format=json&limit=5`
            const res = await fetch(url, {
              headers: { Accept: 'application/json' },
              signal: own.signal,
            })
            if (res.ok) {
              const items = (await res.json()) as {
                display_name: string
                boundingbox: [string, string, string, string]
              }[]
              if (Array.isArray(items) && items.length > 0) {
                found = items.map((item) => {
                  const [south, north, west, east] = item.boundingbox.map(Number)
                  return {
                    name: item.display_name,
                    box: clampPlaceBox({ south, north, west, east }),
                  }
                })
              }
            }
          } catch {
            // Direct fetch unavailable, proceed to curated
          }
        }

        if (own.signal.aborted) return

        // Tier 3: Curated offline places
        if (!found || found.length === 0) {
          found = findCuratedPlaces(trimmed).map((p) => ({
            name: p.name,
            box: clampPlaceBox(p.box),
          }))
        }

        cache.current.set(trimmed.toLowerCase(), found)
        setResults(found)
        setError(found.length === 0 ? 'No places found. Try another city name.' : null)
      } catch (cause) {
        if (own.signal.aborted) return
        setResults([])
        setError(String((cause as Error).message ?? cause))
      } finally {
        if (!own.signal.aborted) setSearching(false)
      }
    }, DEBOUNCE_MS)

    return () => {
      clearTimeout(timer)
    }
  }, [query])

  useEffect(() => () => controller.current?.abort(), [])

  return { results, searching, error }
}


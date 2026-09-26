import { useEffect, useRef, useState } from 'react'
import { dataSource } from '@/data'
import type { PlaceBox } from '@/data/DataSource'

/* Typeahead for the place search.
 *
 * Nominatim is OpenStreetMap's free geocoder and its usage policy asks for at
 * most one request a second from an application. Firing on every keystroke
 * would breach that within a word, so the query is debounced, in-flight
 * requests are abandoned when the text moves on, and results are remembered
 * for the session — typing "Ludh" then deleting back to "Lud" costs nothing.
 */

export interface PlaceResult {
  name: string
  box: PlaceBox
}

/** Long enough that a keystroke pause is deliberate, short enough to feel live. */
const DEBOUNCE_MS = 350
/** Below this almost everything matches and nothing is useful. */
const MIN_QUERY = 3

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
        const found = await dataSource.searchPlaces(trimmed)
        if (own.signal.aborted) return

        cache.current.set(trimmed.toLowerCase(), found)
        setResults(found)
        setError(null)
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

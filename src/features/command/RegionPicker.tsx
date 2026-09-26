import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { GlassPanel } from '@/components/glass/GlassPanel'
import { Button } from '@/components/ui/Button'
import { dataSource } from '@/data'
import type { PlaceBox } from '@/data/DataSource'
import { useRegions } from '@/data/hooks'
import type { Region } from '@shared/contract'
import { cn } from '@/lib/utils'

/**
 * Choosing, and adding, the area the system covers.
 *
 * The network used to be a committed file for one 3km box. Anywhere with roads
 * in OpenStreetMap can be imported now, which is what makes this a
 * road-condition system rather than a road-condition system for one campus.
 *
 * An imported area arrives with geometry and no readings, and the panel says
 * so: claiming a road is in good condition because nobody has driven it yet is
 * the one mistake this whole product cannot afford.
 */
export function RegionPicker({
  selected,
  onSelect,
}: {
  selected: Region | null
  onSelect: (region: Region) => void
}) {
  const { data: regions = [] } = useRegions()
  const queryClient = useQueryClient()

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ name: string; box: PlaceBox }[]>([])
  const [busy, setBusy] = useState<'search' | 'import' | null>(null)

  async function search() {
    if (query.trim().length < 2) return
    setBusy('search')
    setResults([])
    try {
      setResults(await dataSource.searchPlaces(query.trim()))
    } catch (error) {
      toast.error(String((error as Error).message ?? error))
    } finally {
      setBusy(null)
    }
  }

  async function importPlace(place: { name: string; box: PlaceBox }) {
    setBusy('import')
    try {
      // Nominatim returns the whole administrative area, which for a city is
      // far more than one import should pull from a free shared service.
      const result = await dataSource.importRegion(
        place.name.split(',').slice(0, 2).join(',').trim(),
        place.box,
      )

      await queryClient.invalidateQueries()
      toast.success(`${result.segments} road segments imported`, {
        description:
          'No condition data yet — these stay grey until vehicles report from them.',
      })
      setResults([])
      setQuery('')
    } catch (error) {
      toast.error(String((error as Error).message ?? error), {
        duration: 9000,
      })
    } finally {
      setBusy(null)
    }
  }

  return (
    <GlassPanel className="flex w-[320px] flex-col gap-3 p-4" static>
      <div className="flex items-baseline justify-between">
        <span className="eyebrow">Area</span>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="eyebrow text-accent hover:text-accent-bright"
        >
          {open ? 'Close' : 'Add an area'}
        </button>
      </div>

      <ul className="flex flex-col gap-1">
        {regions.map((region) => {
          const unsurveyed = region.segmentCount - region.surveyedCount
          return (
            <li key={region.id}>
              <button
                type="button"
                onClick={() => onSelect(region)}
                className={cn(
                  'rounded-control flex w-full flex-col gap-0.5 px-2 py-2 text-left',
                  'hover:bg-surface-2/60 transition-colors duration-[120ms]',
                  selected?.id === region.id && 'bg-accent-wash',
                )}
              >
                <span className="truncate text-sm">{region.name}</span>
                <span className="metric text-metric-sm text-text-2">
                  {region.segmentCount.toLocaleString('en-IN')} segments
                  {unsurveyed > 0 && (
                    <span className="text-text-3">
                      {' '}
                      · {unsurveyed.toLocaleString('en-IN')} unsurveyed
                    </span>
                  )}
                </span>
              </button>
            </li>
          )
        })}
      </ul>

      {open && (
        <div className="border-hairline flex flex-col gap-2 border-t pt-3">
          <label className="flex flex-col gap-1">
            <span className="eyebrow">Search for a place</span>
            <div className="flex gap-2">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void search()
                }}
                placeholder="Ludhiana, Mohali, Sector 17…"
                className="border-hairline bg-surface-2 text-text-1 rounded-control h-10 min-w-0 flex-1 border px-2 text-sm"
              />
              <Button
                size="sm"
                onClick={() => void search()}
                disabled={busy !== null || query.trim().length < 2}
              >
                {busy === 'search' ? '…' : 'Find'}
              </Button>
            </div>
          </label>

          {results.length > 0 && (
            <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto">
              {results.map((place) => {
                const area =
                  (place.box.north - place.box.south) *
                  (place.box.east - place.box.west)
                // The server refuses anything over 0.25 sq deg; saying so here
                // saves a round trip and explains the refusal in advance.
                const tooLarge = area > 0.25

                return (
                  <li key={place.name}>
                    <button
                      type="button"
                      disabled={busy !== null || tooLarge}
                      onClick={() => void importPlace(place)}
                      className={cn(
                        'rounded-control w-full px-2 py-2 text-left text-xs',
                        tooLarge
                          ? 'text-text-3 cursor-not-allowed'
                          : 'hover:bg-surface-2/60 text-text-2',
                      )}
                    >
                      <span className="line-clamp-2">{place.name}</span>
                      {tooLarge && (
                        <span className="text-health-watch block">
                          Too large for one import — zoom in on a district
                        </span>
                      )}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}

          <p className="text-text-3 text-xs">
            Roads come from OpenStreetMap. An imported area has no condition
            data until vehicles drive it.
          </p>
        </div>
      )}
    </GlassPanel>
  )
}

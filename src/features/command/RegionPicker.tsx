import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { GlassPanel } from '@/components/glass/GlassPanel'
import { dataSource } from '@/data'
import type { PlaceBox } from '@/data/DataSource'
import { useRegions } from '@/data/hooks'
import { usePlaceSearch } from '@/features/command/usePlaceSearch'
import type { Region } from '@shared/contract'
import { clampPlaceBox } from '@shared/places'
import { cn } from '@/lib/utils'

/**
 * Choosing, and adding, the area the system covers.
 *
 * Anywhere with roads in OpenStreetMap can be imported now, which is what makes
 * this a flexible road-condition system.
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
  const [importing, setImporting] = useState(false)

  // Results follow the typing, debounced and cached with offline/curated fallbacks.
  const { results, searching, error } = usePlaceSearch(query)

  async function importPlace(place: { name: string; box: PlaceBox }) {
    setImporting(true)
    try {
      const trimmedName = place.name.split(',').slice(0, 2).join(',').trim()
      const boxToUse = clampPlaceBox(place.box)

      const result = await dataSource.importRegion(
        trimmedName,
        boxToUse,
      )

      await queryClient.invalidateQueries()

      // Fetch the updated region list and auto-select the newly added region
      const updatedRegions = await dataSource.getRegions()
      const newlyAdded =
        updatedRegions.find((r) => r.id === result.regionId) ?? {
          id: result.regionId,
          name: result.name || trimmedName,
          south: boxToUse.south,
          west: boxToUse.west,
          north: boxToUse.north,
          east: boxToUse.east,
          createdAt: new Date().toISOString(),
          segmentCount: result.segments,
          surveyedCount: 0,
        }

      onSelect(newlyAdded)
      setOpen(false)
      setQuery('')

      toast.success(`${result.segments} road segments imported`, {
        description: `Active area switched to ${newlyAdded.name}.`,
      })
    } catch (cause) {
      toast.error(String((cause as Error).message ?? cause), {
        duration: 9000,
      })
    } finally {
      setImporting(false)
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
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Start typing: Ludhiana, Mohali, Sector 17…"
              autoComplete="off"
              spellCheck={false}
              role="combobox"
              aria-expanded={results.length > 0}
              aria-controls="place-results"
              className="border-hairline bg-surface-2 text-text-1 rounded-control h-10 w-full border px-2 text-sm"
            />
            <span className="text-text-3 h-4 text-xs">
              {searching
                ? 'Searching…'
                : error
                  ? error
                  : query.trim().length > 0 && query.trim().length < 2
                    ? 'Keep typing…'
                    : results.length > 0
                      ? `${results.length} match${results.length === 1 ? '' : 'es'}`
                      : ''}
            </span>
          </label>

          {results.length > 0 && (
            <ul
              id="place-results"
              role="listbox"
              className="flex max-h-56 flex-col gap-1 overflow-y-auto"
            >
              {results.map((place) => {
                const area =
                  (place.box.north - place.box.south) *
                  (place.box.east - place.box.west)
                const isLarge = area > 0.24

                return (
                  <li
                    key={`${place.name}:${place.box.south},${place.box.west}`}
                    role="option"
                    aria-selected={false}
                  >
                    <button
                      type="button"
                      disabled={importing}
                      onClick={() => void importPlace(place)}
                      className={cn(
                        'rounded-control w-full px-2 py-2 text-left text-xs transition-colors',
                        'hover:bg-surface-2/80 text-text-1 group',
                        importing && 'opacity-60 cursor-wait',
                      )}
                    >
                      <div className="flex items-start justify-between gap-1">
                        <span className="line-clamp-2 font-medium">{place.name}</span>
                        {isLarge && (
                          <span className="shrink-0 text-[10px] text-accent bg-accent/10 px-1 py-0.5 rounded">
                            Central zone
                          </span>
                        )}
                      </div>
                      <span className="text-text-3 text-[11px] block mt-0.5">
                        {isLarge
                          ? 'Auto-clamps to city center (~15km) for Overpass limits'
                          : 'Click to import road network'}
                      </span>
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


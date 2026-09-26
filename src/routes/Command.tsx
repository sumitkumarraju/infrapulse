import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { CityMap, type Pulse } from '@/components/map/CityMap'
import { Button } from '@/components/ui/Button'
import {
  useLiveEvents,
  useProjectedScores,
  useSegmentsWithStatus,
} from '@/data/hooks'
import { useDemoMode } from '@/demo/demoState'
import { ActivityFeed } from '@/features/command/ActivityFeed'
import { KpiBar } from '@/features/command/KpiBar'
import { PriorityQueue } from '@/features/command/PriorityQueue'
import { RegionPicker } from '@/features/command/RegionPicker'
import { SegmentDrawer } from '@/features/command/SegmentDrawer'
import { worstPothole } from '@shared/potholes'
import type { Region } from '@shared/contract'
import { cn } from '@/lib/utils'

const MAX_PULSES = 3

export function Command() {
  const { data: segments, byId, isLoading, error } = useSegmentsWithStatus()
  const { events, latest } = useLiveEvents()
  // Demo mode can project the whole city forward without leaving this screen.
  const fastForwardDays = useDemoMode((s) => s.fastForwardDays)
  const { data: projected } = useProjectedScores(fastForwardDays)
  const [searchParams, setSearchParams] = useSearchParams()
  const [highlightId, setHighlightId] = useState<number | null>(null)
  const [pulses, setPulses] = useState<Pulse[]>([])
  const [showHexagons, setShowHexagons] = useState(false)
  const [railsOpen, setRailsOpen] = useState(false)
  const [region, setRegion] = useState<Region | null>(null)
  const [flyTo, setFlyTo] = useState<{
    center: [number, number]
    token: number
    cinematic?: boolean
  } | null>(null)
  const flyToken = useRef(0)

  // The drawer is driven by the URL, so ?segment=214 survives a refresh.
  const selectedId = searchParams.get('segment')
    ? Number(searchParams.get('segment'))
    : null
  const selected = selectedId !== null ? (byId.get(selectedId) ?? null) : null

  const select = useCallback(
    (id: number) => {
      setSearchParams((params) => {
        const next = new URLSearchParams(params)
        next.set('segment', String(id))
        return next
      })
    },
    [setSearchParams],
  )

  const close = useCallback(() => {
    setSearchParams((params) => {
      const next = new URLSearchParams(params)
      next.delete('segment')
      return next
    })
  }, [setSearchParams])

  // Fly the camera whenever the selection changes, including on a deep link.
  useEffect(() => {
    if (!selected) return
    flyToken.current += 1
    setFlyTo({ center: selected.center, token: flyToken.current })
  }, [selected])

  // Live events become pulse rings on the map and, rarely, a toast.
  useEffect(() => {
    if (!latest) return

    if (latest.type === 'bump') {
      setPulses((previous) =>
        [
          {
            key: `${latest.segmentId}-${latest.at}`,
            position: latest.position,
            start: performance.now(),
            real: latest.real,
          },
          ...previous,
        ].slice(0, MAX_PULSES),
      )
    }

    if (latest.type === 'alert') {
      const segment = byId.get(latest.segmentId)
      toast(latest.message, {
        description: segment
          ? `Score ${Math.round(segment.status.score)} · ${Math.round(segment.status.risk30 * 100)}% risk in 30 days`
          : undefined,
        duration: 8000,
        action: {
          label: 'Inspect',
          onClick: () => {
            select(latest.segmentId)
            const target = byId.get(latest.segmentId)
            if (!target) return
            const worst = worstPothole(target, target.status.score)
            flyToken.current += 1
            setFlyTo({
              center: worst?.position ?? target.center,
              token: flyToken.current,
              cinematic: true,
            })
          },
        },
      })
    }
  }, [latest, byId, select])

  const photoPins = events
    .filter((e) => e.type === 'photo')
    .slice(0, 12)
    .map((e) => ({
      id: e.report.id,
      position: (byId.get(e.segmentId)?.center ?? [0, 0]) as [number, number],
    }))

  if (error) {
    return (
      <div className="mx-auto flex max-w-lg flex-col gap-3 px-6 py-24">
        <h1 className="text-h2">The road network did not load</h1>
        <p className="text-body text-text-2">
          {String((error as Error).message ?? error)}
        </p>
      </div>
    )
  }

  return (
    <div className="relative h-[calc(100vh-3.5rem)] w-full overflow-hidden">
      <CityMap
        segments={segments}
        scoreOverride={fastForwardDays > 0 ? projected : null}
        highlightId={highlightId}
        selectedId={selectedId}
        pulses={pulses}
        photoPins={photoPins}
        showHexagons={showHexagons}
        flyTo={flyTo}
        onSelect={select}
        onHoverSegment={setHighlightId}
      />

      {/* Overlays sit in a non-interactive grid so the map keeps the clicks
          everywhere they are not. */}
      <div className="pointer-events-none absolute inset-0 flex flex-col gap-4 p-4">
        <div className="pointer-events-auto">
          <KpiBar />
        </div>

        <div className="flex min-h-0 flex-1 items-start gap-4">
          {/* The rails are 360px each and the map is the point, so below `lg`
              they collapse behind a toggle rather than covering the city. */}
          <div
            className={cn(
              'pointer-events-auto h-full min-h-0 flex-col gap-4',
              railsOpen ? 'flex' : 'hidden',
              'lg:flex',
            )}
          >
            <div className="min-h-0 flex-1">
              <PriorityQueue
                segments={segments}
                selectedId={selectedId}
                onSelect={select}
                onHover={setHighlightId}
              />
            </div>
            <div className="hidden xl:block">
              <ActivityFeed events={events} onSelect={select} />
            </div>
          </div>

          <div className="pointer-events-auto ml-auto flex flex-col items-end gap-2">
            <div className="hidden lg:block">
              <RegionPicker
                selected={region}
                onSelect={(next) => {
                  setRegion(next)
                  // Fly to the middle of the area that was chosen.
                  flyToken.current += 1
                  setFlyTo({
                    center: [
                      (next.west + next.east) / 2,
                      (next.south + next.north) / 2,
                    ],
                    token: flyToken.current,
                  })
                }}
              />
            </div>
            <Button
              variant={railsOpen ? 'primary' : 'secondary'}
              size="sm"
              className="lg:hidden"
              onClick={() => setRailsOpen((v) => !v)}
            >
              {railsOpen ? 'Hide list' : 'Priorities'}
            </Button>
            <Button
              variant={showHexagons ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => setShowHexagons((v) => !v)}
            >
              {showHexagons ? 'Health view' : 'Density view'}
            </Button>
          </div>
        </div>
      </div>

      <SegmentDrawer
        segment={selected}
        onClose={close}
        onInspect={(position) => {
          flyToken.current += 1
          setFlyTo({
            center: position,
            token: flyToken.current,
            cinematic: true,
          })
        }}
      />

      {isLoading && (
        <div className="bg-void/70 absolute inset-0 z-40 flex items-center justify-center">
          <span className="eyebrow text-accent animate-pulse">
            Loading 1,100 road segments
          </span>
        </div>
      )}
    </div>
  )
}

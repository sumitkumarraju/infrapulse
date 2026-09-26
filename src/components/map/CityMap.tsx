import { MapboxOverlay } from '@deck.gl/mapbox'
import { ColumnLayer, PathLayer, ScatterplotLayer } from '@deck.gl/layers'
import { HexagonLayer } from '@deck.gl/aggregation-layers'
import type { Layer, PickingInfo } from '@deck.gl/core'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Map, { useControl, type MapRef } from 'react-map-gl/maplibre'
import 'maplibre-gl/dist/maplibre-gl.css'
import '@/components/map/mapWorker'
import { CENTER, INITIAL_VIEW, darkStyle, liteStyle } from '@/components/map/darkStyle'
import type { SegmentWithStatus } from '@/data/hooks'
import { BAND_WIDTH, scoreColorRgba } from '@/lib/health'
import { cn } from '@/lib/utils'

export interface Pulse {
  key: string
  position: [number, number]
  start: number
  real?: boolean
}

export interface CityMapProps {
  segments: SegmentWithStatus[]
  /** Replaces live scores — the Time Machine projects the whole city forward. */
  scoreOverride?: Map<number, number> | null
  /** Highlighted from a list hover: brighter and thicker, no camera move. */
  highlightId?: number | null
  selectedId?: number | null
  /** Budget planner: these lift and glow, everything else dims. */
  fundedIds?: Set<number> | null
  pulses?: Pulse[]
  photoPins?: { id: string; position: [number, number] }[]
  showTowers?: boolean
  showHexagons?: boolean
  flyTo?: { center: [number, number]; token: number } | null
  onSelect?: (id: number) => void
  onHoverSegment?: (id: number | null) => void
  className?: string
}

const PULSE_MS = 900
const PULSE_MAX_M = 60

function DeckOverlay(props: { layers: Layer[]; interleaved?: boolean }) {
  const overlay = useControl(() => new MapboxOverlay(props)) as MapboxOverlay
  overlay.setProps(props)
  return null
}

/** WebGL availability, checked once — the lite-mode trigger from UI_DESIGN 4. */
function hasWebGl(): boolean {
  if (typeof document === 'undefined') return false
  try {
    const canvas = document.createElement('canvas')
    return Boolean(
      canvas.getContext('webgl2') ?? canvas.getContext('webgl'),
    )
  } catch {
    return false
  }
}

export function CityMap({
  segments,
  scoreOverride = null,
  highlightId = null,
  selectedId = null,
  fundedIds = null,
  pulses = [],
  photoPins = [],
  showTowers = true,
  showHexagons = false,
  flyTo = null,
  onSelect,
  onHoverSegment,
  className,
}: CityMapProps) {
  const mapRef = useRef<MapRef | null>(null)
  const [lite, setLite] = useState(() => !hasWebGl())
  const [tick, setTick] = useState(0)
  const [hover, setHover] = useState<{
    segment: SegmentWithStatus
    x: number
    y: number
  } | null>(null)

  /* --- Lite mode: two seconds under 30fps and the heavy layers go away. --- */
  useEffect(() => {
    if (lite) return
    let frames = 0
    let slowSince = 0
    let raf = 0
    let last = performance.now()

    const loop = (now: number) => {
      frames++
      // A hidden or backgrounded tab is throttled to a few frames a second by
      // the browser. That is not a slow GPU, and dropping to lite mode because
      // of it would greet the viewer with a flat map when they came back.
      if (typeof document !== 'undefined' && document.hidden) {
        frames = 0
        last = now
        slowSince = 0
        raf = requestAnimationFrame(loop)
        return
      }
      if (now - last >= 500) {
        const fps = (frames * 1000) / (now - last)
        frames = 0
        last = now
        if (fps < 30) {
          if (slowSince === 0) slowSince = now
          else if (now - slowSince > 2000) {
            setLite(true)
            return
          }
        } else {
          slowSince = 0
        }
      }
      raf = requestAnimationFrame(loop)
    }

    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [lite])

  /* --- Pulse rings animate on their own clock. --- */
  useEffect(() => {
    if (pulses.length === 0) return
    let raf = 0
    const loop = () => {
      setTick((t) => t + 1)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [pulses.length])

  /* --- Camera fly-to, triggered by a token so repeat clicks still fly. --- */
  useEffect(() => {
    if (!flyTo) return
    mapRef.current?.getMap().flyTo({
      center: flyTo.center,
      zoom: 16.4,
      duration: 1200,
      essential: true,
    })
  }, [flyTo])

  const scoreOf = useCallback(
    (segment: SegmentWithStatus) =>
      scoreOverride?.get(segment.id) ?? segment.status.score,
    [scoreOverride],
  )

  const handleHover = useCallback(
    (info: PickingInfo) => {
      const segment = info.object as SegmentWithStatus | undefined
      if (segment && info.x !== undefined) {
        setHover({ segment, x: info.x, y: info.y })
        onHoverSegment?.(segment.id)
      } else {
        setHover(null)
        onHoverSegment?.(null)
      }
    },
    [onHoverSegment],
  )

  const layers = useMemo(() => {
    const result: Layer[] = []
    const dimmed = fundedIds !== null

    if (showHexagons) {
      // Density replaces the health view entirely (UI_DESIGN 4, layer 6).
      result.push(
        new HexagonLayer<SegmentWithStatus>({
          id: 'hexagons',
          data: segments,
          getPosition: (d) => d.center,
          getElevationWeight: (d) => d.status.bumpsLast7Days,
          elevationScale: 4,
          radius: 120,
          extruded: !lite,
          opacity: 0.75,
          colorRange: [
            [14, 116, 144],
            [34, 211, 238],
            [163, 230, 53],
            [251, 191, 36],
            [244, 63, 94],
            [180, 18, 60],
          ],
        }),
      )
      return result
    }

    // Glow pass: the same paths, wider and faint, under the real lines.
    if (!lite) {
      result.push(
        new PathLayer<SegmentWithStatus>({
          id: 'health-glow',
          data: segments,
          getPath: (d) => d.path,
          getColor: (d) => {
            const score = scoreOf(d)
            const alpha = score < 40 ? 80 : score < 70 ? 55 : 35
            return scoreColorRgba(score, dimmed && !fundedIds?.has(d.id) ? 12 : alpha)
          },
          getWidth: (d) => BAND_WIDTH[d.status.band] * 4,
          widthUnits: 'pixels',
          widthMinPixels: 6,
          capRounded: true,
          jointRounded: true,
          pickable: false,
          updateTriggers: {
            getColor: [scoreOverride, fundedIds],
          },
        }),
      )
    }

    result.push(
      new PathLayer<SegmentWithStatus>({
        id: 'health-paths',
        data: segments,
        getPath: (d) => d.path,
        getColor: (d) => {
          const highlighted = d.id === highlightId || d.id === selectedId
          const faded = dimmed && !fundedIds?.has(d.id)
          return scoreColorRgba(
            scoreOf(d),
            faded ? 60 : highlighted ? 255 : 220,
          )
        },
        getWidth: (d) =>
          BAND_WIDTH[d.status.band] +
          (d.id === highlightId || d.id === selectedId ? 3 : 0),
        widthUnits: 'pixels',
        widthMinPixels: 2,
        capRounded: true,
        jointRounded: true,
        pickable: true,
        autoHighlight: true,
        highlightColor: [103, 232, 249, 255],
        onHover: handleHover,
        onClick: (info) => {
          const segment = info.object as SegmentWithStatus | undefined
          if (segment) onSelect?.(segment.id)
        },
        updateTriggers: {
          getColor: [highlightId, selectedId, scoreOverride, fundedIds],
          getWidth: [highlightId, selectedId],
        },
      }),
    )

    // Risk towers: height is risk30, and good roads get none at all, so an
    // empty stretch of map is itself the "this district is fine" signal.
    if (showTowers && !lite) {
      const towers = segments.filter(
        (s) =>
          (scoreOverride?.get(s.id) ?? s.status.score) < 70 ||
          fundedIds?.has(s.id),
      )
      result.push(
        new ColumnLayer<SegmentWithStatus>({
          id: 'risk-towers',
          data: towers,
          diskResolution: 6,
          radius: 8,
          extruded: true,
          getPosition: (d) => d.center,
          getElevation: (d) => {
            if (fundedIds?.has(d.id)) return 40
            // With a projection applied the tower has to grow with the
            // projected decay, not stay pinned to today's risk — the towers
            // rising as the timeline plays is the whole point of that screen.
            const override = scoreOverride?.get(d.id)
            return override === undefined
              ? d.status.risk30 * 220
              : (1 - override / 100) ** 1.6 * 260
          },
          getFillColor: (d) =>
            fundedIds?.has(d.id)
              ? [34, 211, 238, 220]
              : scoreColorRgba(scoreOf(d), 165),
          pickable: true,
          onClick: (info) => {
            const segment = info.object as SegmentWithStatus | undefined
            if (segment) onSelect?.(segment.id)
          },
          updateTriggers: {
            getElevation: [scoreOverride, fundedIds],
            getFillColor: [scoreOverride, fundedIds],
          },
        }),
      )
    }

    if (photoPins.length > 0) {
      result.push(
        new ScatterplotLayer<{ id: string; position: [number, number] }>({
          id: 'photo-pins',
          data: photoPins,
          getPosition: (d) => d.position,
          getRadius: 14,
          radiusUnits: 'pixels',
          getFillColor: [15, 23, 46, 230],
          getLineColor: [34, 211, 238, 220],
          lineWidthMinPixels: 1.5,
          stroked: true,
        }),
      )
    }

    if (pulses.length > 0) {
      const now = performance.now()
      const live = pulses.filter((p) => now - p.start < PULSE_MS)
      if (live.length > 0) {
        result.push(
          new ScatterplotLayer<Pulse>({
            id: `pulses-${tick % 2}`,
            data: live,
            getPosition: (d) => d.position,
            getRadius: (d) => ((now - d.start) / PULSE_MS) * PULSE_MAX_M,
            radiusUnits: 'meters',
            stroked: true,
            filled: false,
            getLineColor: (d) => [
              d.real ? 103 : 34,
              d.real ? 232 : 211,
              d.real ? 249 : 238,
              Math.round(255 * (1 - (now - d.start) / PULSE_MS)),
            ],
            lineWidthMinPixels: 2,
            updateTriggers: { getRadius: tick, getLineColor: tick },
          }),
        )
      }
    }

    return result
  }, [
    segments,
    scoreOf,
    scoreOverride,
    highlightId,
    selectedId,
    fundedIds,
    pulses,
    photoPins,
    showTowers,
    showHexagons,
    lite,
    tick,
    handleHover,
    onSelect,
  ])

  return (
    <div className={cn('relative h-full w-full', className)}>
      <Map
        ref={mapRef}
        initialViewState={{
          ...INITIAL_VIEW,
          pitch: lite ? 0 : INITIAL_VIEW.pitch,
        }}
        mapStyle={lite ? liteStyle : darkStyle}
        attributionControl={{ compact: true }}
        onError={() => setLite(true)}
        style={{ position: 'absolute', inset: 0 }}
      >
        <DeckOverlay layers={layers} />
      </Map>

      {hover && (
        <div
          className="pointer-events-none absolute z-20 rounded-chip border border-hairline-strong bg-void/90 px-2 py-1 font-mono text-metric-sm text-text-1"
          style={{ left: hover.x + 12, top: hover.y + 12 }}
        >
          SEG-{String(hover.segment.id).padStart(4, '0')} · score{' '}
          {Math.round(scoreOf(hover.segment))} · risk30{' '}
          {Math.round(hover.segment.status.risk30 * 100)}%
        </div>
      )}

      {lite && (
        <button
          type="button"
          onClick={() => setLite(false)}
          className="absolute bottom-4 left-1/2 z-20 -translate-x-1/2 rounded-chip border border-hairline-strong bg-void/85 px-3 py-1.5 text-xs text-text-2 hover:text-text-1"
        >
          LITE MODE — 3D is off because this machine could not hold 30fps. Tap to
          try again.
        </button>
      )}
    </div>
  )
}

export { CENTER }

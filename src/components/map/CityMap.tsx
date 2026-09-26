import { MapboxOverlay } from '@deck.gl/mapbox'
import {
  ColumnLayer,
  PathLayer,
  ScatterplotLayer,
  TextLayer,
} from '@deck.gl/layers'
import { HexagonLayer } from '@deck.gl/aggregation-layers'
import type { Layer, PickingInfo } from '@deck.gl/core'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Map, { useControl, type MapRef } from 'react-map-gl/maplibre'
import 'maplibre-gl/dist/maplibre-gl.css'
import '@/components/map/mapWorker'
import {
  CENTER,
  INITIAL_VIEW,
  darkStyle,
  liteStyle,
} from '@/components/map/darkStyle'
import type { SegmentWithStatus } from '@/data/hooks'
import { BAND_WIDTH, scoreColorRgba } from '@/lib/health'
import { potholesFor, type Pothole } from '@shared/potholes'
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
  /**
   * `cinematic` swings the camera out and back down instead of sliding across,
   * which is what makes a jump to a single pothole read as an inspection
   * rather than a scroll.
   */
  flyTo?: {
    center: [number, number]
    token: number
    cinematic?: boolean
  } | null
  /** Individual defects, drawn once the camera is close enough to place them. */
  showPotholes?: boolean
  onSelect?: (id: number) => void
  onHoverSegment?: (id: number | null) => void
  className?: string
}

const PULSE_MS = 900
const PULSE_MAX_M = 60

/* Zoom thresholds. Everything below is a judgement about what is legible at a
   given altitude rather than what the GPU can manage: a thousand pothole
   markers at zoom 13 is noise, and the same markers at zoom 17 are the point. */
const ZOOM_POTHOLES = 15.2
const ZOOM_POTHOLE_LABELS = 17.2
const ZOOM_SEGMENT_LABELS = 15.4
/** How many segments get a name label — enough to orient, not enough to crowd. */
const LABELLED_SEGMENTS = 24
/* Risk towers are a city-scale device: 220m columns read as a skyline from
   above and as walls from street level. Past this zoom the viewer has flown
   down to look at a specific defect, and the towers are in the way. */
const ZOOM_TOWERS_MAX = 17

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
    return Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'))
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
  showPotholes = true,
  onSelect,
  onHoverSegment,
  className,
}: CityMapProps) {
  const mapRef = useRef<MapRef | null>(null)
  const [lite, setLite] = useState(() => !hasWebGl())
  const [tick, setTick] = useState(0)
  const [zoom, setZoom] = useState(INITIAL_VIEW.zoom)
  /** Ring drawn where the camera just landed, so the target is unmistakable. */
  const [focus, setFocus] = useState<{
    position: [number, number]
    at: number
  } | null>(null)
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
    if (pulses.length === 0 && !focus) return
    let raf = 0
    const loop = () => {
      setTick((t) => t + 1)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [pulses.length, focus])

  /* --- Camera fly-to, triggered by a token so repeat clicks still fly. --- */
  useEffect(() => {
    if (!flyTo) return
    const map = mapRef.current?.getMap()
    if (!map) return

    if (!flyTo.cinematic) {
      map.flyTo({
        center: flyTo.center,
        zoom: 16.4,
        duration: 1200,
        essential: true,
      })
      setFocus({ position: flyTo.center, at: performance.now() })
      return
    }

    /* Two moves, not one.
     *
     * Sliding straight to a target at high zoom loses the viewer: the ground
     * rushes past with nothing to track. Lifting out first, turning, and then
     * descending keeps the surroundings visible through the whole move, so the
     * destination arrives in context. It is the same reason a camera operator
     * pulls back before pushing in.
     */
    const bearing = map.getBearing()

    /* Lite mode is about how much the GPU is asked to draw, not about how the
       camera moves — easing costs nothing. The one thing it does suppress is
       the pitch, because a flat map is the whole point of lite mode. */
    map.easeTo({
      zoom: Math.max(13.6, map.getZoom() - 1.2),
      ...(lite ? {} : { pitch: 35 }),
      bearing: bearing + 28,
      duration: 620,
      essential: true,
    })

    const descend = setTimeout(() => {
      map.flyTo({
        center: flyTo.center,
        zoom: 17.8,
        ...(lite ? {} : { pitch: 62 }),
        bearing: bearing - 12,
        duration: 1700,
        // A flatter curve than the default: less arc, more approach.
        curve: 1.5,
        essential: true,
      })
      setFocus({ position: flyTo.center, at: performance.now() + 1500 })
    }, 640)

    return () => clearTimeout(descend)
  }, [flyTo, lite])

  /** The landing ring fades itself out. */
  useEffect(() => {
    if (!focus) return
    const timer = setTimeout(() => setFocus(null), 4200)
    return () => clearTimeout(timer)
  }, [focus])

  const scoreOf = useCallback(
    (segment: SegmentWithStatus) =>
      scoreOverride?.get(segment.id) ?? segment.status.score,
    [scoreOverride],
  )

  /*
   * Derived once per dataset rather than per frame: seeding a generator for
   * every damaged segment is cheap enough to do on a data change and far too
   * expensive to do while the camera moves.
   */
  const potholes = useMemo(() => {
    if (!showPotholes) return []
    const all: Pothole[] = []
    for (const segment of segments) {
      const score = scoreOverride?.get(segment.id) ?? segment.status.score
      all.push(...potholesFor(segment, score))
    }
    return all
  }, [segments, scoreOverride, showPotholes])

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
            return scoreColorRgba(
              score,
              dimmed && !fundedIds?.has(d.id) ? 12 : alpha,
            )
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
    if (showTowers && !lite && zoom < ZOOM_TOWERS_MAX) {
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
          getFillColor: (d) => {
            // Dissolve over the last zoom level so they leave rather than blink.
            const fade = Math.max(
              0,
              Math.min(1, (ZOOM_TOWERS_MAX - zoom) / 1.2),
            )
            return fundedIds?.has(d.id)
              ? [34, 211, 238, Math.round(220 * fade)]
              : scoreColorRgba(scoreOf(d), Math.round(165 * fade))
          },
          pickable: true,
          onClick: (info) => {
            const segment = info.object as SegmentWithStatus | undefined
            if (segment) onSelect?.(segment.id)
          },
          updateTriggers: {
            getElevation: [scoreOverride, fundedIds],
            getFillColor: [scoreOverride, fundedIds, zoom],
          },
        }),
      )
    }

    /* --- Individual defects ------------------------------------------- */

    if (potholes.length > 0 && zoom >= ZOOM_POTHOLES && !lite) {
      // A dark disc with a lit rim: it reads as a hole in the surface rather
      // than a dot on top of it, which matters when the camera is low.
      result.push(
        new ScatterplotLayer<Pothole>({
          id: 'potholes',
          data: potholes,
          getPosition: (d) => d.position,
          // Real metres, so a 90cm crater is visibly bigger than a 20cm one
          // and both shrink correctly as the camera pulls away.
          getRadius: (d) => Math.max(0.6, d.widthCm / 200),
          radiusUnits: 'meters',
          radiusMinPixels: 2,
          radiusMaxPixels: 26,
          filled: true,
          stroked: true,
          getFillColor: [8, 10, 16, 235],
          getLineColor: (d) =>
            d.severity === 'severe'
              ? [244, 63, 94, 235]
              : d.severity === 'moderate'
                ? [251, 191, 36, 205]
                : [151, 163, 189, 160],
          lineWidthUnits: 'pixels',
          getLineWidth: (d) => (d.severity === 'severe' ? 2 : 1.2),
          lineWidthMinPixels: 1,
          pickable: true,
          onClick: (info) => {
            const pothole = info.object as Pothole | undefined
            if (pothole) onSelect?.(pothole.segmentId)
          },
        }),
      )
    }

    /* --- Labels ---------------------------------------------------------- */

    if (potholes.length > 0 && zoom >= ZOOM_POTHOLE_LABELS && !lite) {
      const severe = potholes.filter((p) => p.severity === 'severe')
      result.push(
        new TextLayer<Pothole>({
          id: 'pothole-labels',
          data: severe,
          getPosition: (d) => d.position,
          getText: (d) => `${d.depthCm.toFixed(0)}cm`,
          getSize: 11,
          sizeUnits: 'pixels',
          getColor: [232, 237, 247, 230],
          getPixelOffset: [0, -14],
          fontFamily: 'JetBrains Mono, ui-monospace, monospace',
          characterSet: 'auto',
          outlineWidth: 3,
          outlineColor: [6, 11, 24, 255],
          fontSettings: { sdf: true },
          background: true,
          getBackgroundColor: [6, 11, 24, 170],
          backgroundPadding: [3, 1],
        }),
      )
    }

    if (zoom >= ZOOM_SEGMENT_LABELS) {
      // Only the worst handful are named. Labelling all 1,100 would be a wall
      // of text, and the ones worth finding are the ones near the top anyway.
      const labelled = [...segments]
        .filter((d) => (scoreOverride?.get(d.id) ?? d.status.score) < 70)
        .sort((a, b) => b.status.priority - a.status.priority)
        .slice(0, LABELLED_SEGMENTS)

      result.push(
        new TextLayer<SegmentWithStatus>({
          id: 'segment-labels',
          data: labelled,
          getPosition: (d) => d.center,
          getText: (d) =>
            `${d.name}  ${Math.round(scoreOverride?.get(d.id) ?? d.status.score)}${
              d.nearSensitive ? '  • SCHOOL' : ''
            }`,
          getSize: 11,
          sizeUnits: 'pixels',
          getColor: (d) => {
            const [r, g, b] = scoreColorRgba(
              scoreOverride?.get(d.id) ?? d.status.score,
            )
            return [r, g, b, 235]
          },
          getPixelOffset: [0, 16],
          fontFamily: 'Inter, sans-serif',
          characterSet: 'auto',
          outlineWidth: 3,
          outlineColor: [6, 11, 24, 255],
          fontSettings: { sdf: true },
          background: true,
          getBackgroundColor: [6, 11, 24, 190],
          backgroundPadding: [4, 2],
          pickable: true,
          onClick: (info) => {
            const segment = info.object as SegmentWithStatus | undefined
            if (segment) onSelect?.(segment.id)
          },
          updateTriggers: {
            getText: [scoreOverride],
            getColor: [scoreOverride],
          },
        }),
      )
    }

    /* --- Where the camera just landed ------------------------------------ */

    if (focus) {
      const age = (performance.now() - focus.at) / 1000
      if (age >= 0 && age < 4) {
        result.push(
          new ScatterplotLayer<{ position: [number, number] }>({
            id: `focus-ring-${tick % 2}`,
            data: [{ position: focus.position }],
            getPosition: (d) => d.position,
            // Contracts onto the target rather than expanding away from it.
            getRadius: 26 - Math.min(22, age * 16),
            radiusUnits: 'meters',
            stroked: true,
            filled: false,
            getLineColor: [103, 232, 249, Math.round(255 * (1 - age / 4))],
            lineWidthMinPixels: 2,
            updateTriggers: { getRadius: tick, getLineColor: tick },
          }),
        )
      }
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
    potholes,
    zoom,
    focus,
    handleHover,
    onSelect,
  ])

  return (
    <div
      className={cn('relative h-full w-full', className)}
      /* Camera state, surfaced for end-to-end tests: there is no other way to
         assert that "Inspect" actually flew the camera down to the defect. */
      data-map-zoom={zoom.toFixed(2)}
      data-map-lite={lite ? 'true' : 'false'}
    >
      <Map
        ref={mapRef}
        initialViewState={{
          ...INITIAL_VIEW,
          pitch: lite ? 0 : INITIAL_VIEW.pitch,
        }}
        mapStyle={lite ? liteStyle : darkStyle}
        attributionControl={{ compact: true }}
        onMove={(event) => setZoom(event.viewState.zoom)}
        onError={() => setLite(true)}
        style={{ position: 'absolute', inset: 0 }}
      >
        <DeckOverlay layers={layers} />
      </Map>

      {hover && (
        <div
          className="rounded-chip border-hairline-strong bg-void/90 text-metric-sm text-text-1 pointer-events-none absolute z-20 border px-2 py-1 font-mono"
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
          className="rounded-chip border-hairline-strong bg-void/85 text-text-2 hover:text-text-1 absolute bottom-4 left-1/2 z-20 -translate-x-1/2 border px-3 py-1.5 text-xs"
        >
          LITE MODE — 3D is off because this machine could not hold 30fps. Tap
          to try again.
        </button>
      )}
    </div>
  )
}

export { CENTER }

/* A stripped-down MapLibre map for the driver's trip view.
 *
 * Shows three things and nothing else:
 *   1. The route driven so far (a cyan polyline).
 *   2. Red pulsing markers where bumps were detected.
 *   3. The driver's current position (a blue dot with heading).
 *
 * It uses react-map-gl/maplibre so it shares the same tile source as the
 * desktop CityMap, but carries none of the deck.gl overlay weight — a phone
 * does not need hexagon aggregation or risk towers.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import Map, { Layer, Marker, Source, type MapRef } from 'react-map-gl/maplibre'
import 'maplibre-gl/dist/maplibre-gl.css'
import { liteStyle } from '@/components/map/darkStyle'
import type { DetectedBump } from '@/features/driver/sensors/useBumpDetection'
import { cn } from '@/lib/utils'

export interface TripMapProps {
  /** Current GPS position as [lon, lat]. */
  position: [number, number] | null
  /** Speed in m/s — used for the heading cone. */
  speedMs: number
  /** Complete trail of [lon, lat] coordinates driven so far. */
  route: [number, number][]
  /** Potholes detected or manually marked. */
  bumps: DetectedBump[]
  /** Optional manual markers from the driver. */
  manualMarkers?: { at: number; position: [number, number]; severity?: string; photoUrl?: string | null }[]
  className?: string
}

const INITIAL = {
  longitude: 76.575,
  latitude: 30.768,
  zoom: 16,
  pitch: 0,
  bearing: 0,
}

export function TripMap({
  position,
  speedMs,
  route,
  bumps,
  manualMarkers = [],
  className,
}: TripMapProps) {
  const mapRef = useRef<MapRef>(null)
  const [followDriver, setFollowDriver] = useState(true)

  // Follow the driver when enabled.
  useEffect(() => {
    if (!followDriver || !position || !mapRef.current) return
    mapRef.current.easeTo({
      center: position,
      duration: 800,
      easing: (t: number) => t * (2 - t),
    })
  }, [position, followDriver])

  // Stop following on user drag, resume on tap.
  const handleDragStart = useCallback(() => setFollowDriver(false), [])

  const routeGeoJSON: GeoJSON.Feature<GeoJSON.LineString> | null =
    route.length >= 2
      ? {
          type: 'Feature',
          properties: {},
          geometry: { type: 'LineString', coordinates: route },
        }
      : null

  const bumpMarkers = bumps.filter((b) => b.position)

  return (
    <div className={cn('relative overflow-hidden rounded-xl', className)}>
      <Map
        ref={mapRef}
        initialViewState={
          position
            ? { ...INITIAL, longitude: position[0], latitude: position[1] }
            : INITIAL
        }
        style={{ width: '100%', height: '100%' }}
        mapStyle={liteStyle}
        onDragStart={handleDragStart}
        attributionControl={false}
      >
        {/* Route polyline */}
        {routeGeoJSON && (
          <Source id="trip-route" type="geojson" data={routeGeoJSON}>
            <Layer
              id="trip-route-glow"
              type="line"
              paint={{
                'line-color': '#0E7490',
                'line-width': 6,
                'line-opacity': 0.25,
                'line-blur': 4,
              }}
            />
            <Layer
              id="trip-route-line"
              type="line"
              paint={{
                'line-color': '#0E7490',
                'line-width': 3,
                'line-opacity': 0.9,
              }}
            />
          </Source>
        )}

        {/* Bump markers */}
        {bumpMarkers.map((bump) => (
          <Marker
            key={bump.at}
            longitude={bump.position![0]}
            latitude={bump.position![1]}
            anchor="center"
          >
            <span className="trip-bump-marker" />
          </Marker>
        ))}

        {/* Manual markers (pothole reports) */}
        {manualMarkers.map((m) => (
          <Marker
            key={m.at}
            longitude={m.position[0]}
            latitude={m.position[1]}
            anchor="center"
          >
            <span
              className={cn(
                'trip-manual-marker',
                m.severity === 'severe' && 'trip-manual-marker--severe',
                m.severity === 'minor' && 'trip-manual-marker--minor',
              )}
            >
              {m.photoUrl ? '📸' : '⚠️'}
            </span>
          </Marker>
        ))}

        {/* Driver position */}
        {position && (
          <Marker longitude={position[0]} latitude={position[1]} anchor="center">
            <div className="trip-driver-dot">
              <span className="trip-driver-dot__ring" />
              <span className="trip-driver-dot__core" />
            </div>
          </Marker>
        )}
      </Map>

      {/* Re-centre FAB */}
      {!followDriver && position && (
        <button
          type="button"
          onClick={() => setFollowDriver(true)}
          className="absolute right-3 bottom-3 flex size-10 items-center justify-center rounded-full bg-white/90 shadow-lg backdrop-blur active:scale-95"
          aria-label="Re-centre on driver"
        >
          <svg viewBox="0 0 24 24" className="size-5 fill-current text-cyan-700">
            <path d="M12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm8.94 3A8.994 8.994 0 0 0 13 3.06V1h-2v2.06A8.994 8.994 0 0 0 3.06 11H1v2h2.06A8.994 8.994 0 0 0 11 20.94V23h2v-2.06A8.994 8.994 0 0 0 20.94 13H23v-2h-2.06zM12 19c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z" />
          </svg>
        </button>
      )}

      {/* Speed badge */}
      {speedMs > 0.5 && (
        <div className="absolute left-3 bottom-3 rounded-lg bg-black/70 px-2.5 py-1 text-xs font-semibold text-white backdrop-blur">
          {Math.round(speedMs * 3.6)} km/h
        </div>
      )}
    </div>
  )
}

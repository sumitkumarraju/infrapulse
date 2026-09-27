/* Full-screen map of every pothole and trip recorded from this phone.
 *
 * Reads from localStorage so it works entirely offline — the same trips that
 * the BumpUploader sends to the server are also kept here for instant local
 * viewing. If the phone has no server connection at all, the data still lives
 * on the device and shows up on this map.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Map, { Layer, Marker, Source, type MapRef } from 'react-map-gl/maplibre'
import { useSearchParams, useNavigate } from 'react-router'
import 'maplibre-gl/dist/maplibre-gl.css'
import { liteStyle, CENTER } from '@/components/map/darkStyle'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'

export interface StoredPothole {
  at: number
  position: [number, number]
  magnitude?: number
  severity?: string
  photoUrl?: string | null
  source: 'auto' | 'manual'
}

export interface StoredTrip {
  id: string
  startTime: number
  endTime: number
  distanceM: number
  route: [number, number][]
  bumps: { at: number; magnitude: number; position: [number, number] }[]
  manualMarkers: {
    at: number
    position: [number, number]
    severity: string
    photoUrl?: string | null
  }[]
}

const STORAGE_KEY_POTHOLES = 'infrapulse-local-potholes'
const STORAGE_KEY_TRIPS = 'infrapulse-local-trips'

function loadPotholes(): StoredPothole[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_POTHOLES)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function loadTrips(): StoredTrip[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_TRIPS)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function severityColor(severity?: string): string {
  if (severity === 'severe') return '#be123c'
  if (severity === 'minor') return '#059669'
  return '#b45309'
}

// Sample demonstration drive for quick testing without needing to drive outside
const DEMO_ROUTE: [number, number][] = [
  [76.575, 30.768],
  [76.5772, 30.7695],
  [76.5805, 30.7715],
  [76.5845, 30.7732],
  [76.5885, 30.7745],
  [76.592, 30.7725],
  [76.59, 30.769],
  [76.5855, 30.7665],
  [76.5805, 30.7655],
  [76.576, 30.7665],
  [76.575, 30.768],
]

const DEMO_POTHOLES: StoredPothole[] = [
  {
    at: Date.now() - 3600000,
    position: [76.5772, 30.7695],
    magnitude: 14.2,
    source: 'auto',
  },
  {
    at: Date.now() - 3200000,
    position: [76.5805, 30.7715],
    magnitude: 18.6,
    source: 'auto',
  },
  {
    at: Date.now() - 2800000,
    position: [76.5845, 30.7732],
    severity: 'severe',
    source: 'manual',
  },
  {
    at: Date.now() - 2100000,
    position: [76.59, 30.769],
    magnitude: 12.8,
    source: 'auto',
  },
  {
    at: Date.now() - 1400000,
    position: [76.5855, 30.7665],
    severity: 'moderate',
    source: 'manual',
  },
]

export function PotholeMap() {
  const mapRef = useRef<MapRef>(null)
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  const [potholes, setPotholes] = useState<StoredPothole[]>([])
  const [trips, setTrips] = useState<StoredTrip[]>([])
  const [selected, setSelected] = useState<StoredPothole | null>(null)
  const [viewTab, setViewTab] = useState<'map' | 'list'>('map')
  const [copied, setCopied] = useState(false)
  const [photoPreview, setPhotoPreview] = useState<string | null>(null)
  const [myLocation, setMyLocation] = useState<[number, number] | null>(null)

  // Reload data from localStorage
  const refreshData = useCallback(() => {
    setPotholes(loadPotholes())
    setTrips(loadTrips())
  }, [])

  useEffect(() => {
    refreshData()
    const handler = (e: StorageEvent) => {
      if (
        e.key === STORAGE_KEY_POTHOLES ||
        e.key === STORAGE_KEY_TRIPS
      ) {
        refreshData()
      }
    }
    window.addEventListener('storage', handler)
    return () => window.removeEventListener('storage', handler)
  }, [refreshData])

  // If query params lat and lon are present, fly to that position
  useEffect(() => {
    const latStr = searchParams.get('lat')
    const lonStr = searchParams.get('lon')
    if (latStr && lonStr) {
      const lat = parseFloat(latStr)
      const lon = parseFloat(lonStr)
      if (!isNaN(lat) && !isNaN(lon)) {
        mapRef.current?.flyTo({
          center: [lon, lat],
          zoom: 17,
          duration: 900,
        })
        // Find if we have an existing pothole close to these coords
        const found = potholes.find(
          (p) =>
            Math.abs(p.position[0] - lon) < 0.0001 &&
            Math.abs(p.position[1] - lat) < 0.0001,
        )
        if (found) {
          setSelected(found)
        } else {
          setSelected({
            at: Date.now(),
            position: [lon, lat],
            magnitude: 12.0,
            source: 'auto',
          })
        }
      }
    }
  }, [searchParams, potholes])

  // Fly to a pothole on tap
  const handleSelect = useCallback((p: StoredPothole) => {
    setSelected(p)
    setViewTab('map')
    mapRef.current?.flyTo({
      center: p.position,
      zoom: 17,
      duration: 800,
    })
  }, [])

  // Copy coordinates to clipboard
  const handleCopyCoords = useCallback((pos: [number, number]) => {
    const text = `${pos[1].toFixed(6)}, ${pos[0].toFixed(6)}`
    void navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [])

  // Geolocation locate me
  const handleLocateMe = useCallback(() => {
    if ('geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const coords: [number, number] = [
            pos.coords.longitude,
            pos.coords.latitude,
          ]
          setMyLocation(coords)
          mapRef.current?.flyTo({
            center: coords,
            zoom: 16,
            duration: 800,
          })
        },
        () => undefined,
        { enableHighAccuracy: true, timeout: 8000 },
      )
    }
  }, [])

  // Populate sample drive & demo potholes
  const handleLoadDemo = useCallback(() => {
    const sampleTrip: StoredTrip = {
      id: `trip-demo-${Date.now()}`,
      startTime: Date.now() - 3600000,
      endTime: Date.now() - 1200000,
      distanceM: 3200,
      route: DEMO_ROUTE,
      bumps: DEMO_POTHOLES.filter((p) => p.source === 'auto').map((p) => ({
        at: p.at,
        magnitude: p.magnitude ?? 12,
        position: p.position,
      })),
      manualMarkers: DEMO_POTHOLES.filter((p) => p.source === 'manual').map(
        (p) => ({
          at: p.at,
          position: p.position,
          severity: p.severity ?? 'moderate',
        }),
      ),
    }

    localStorage.setItem(
      STORAGE_KEY_POTHOLES,
      JSON.stringify(DEMO_POTHOLES),
    )
    localStorage.setItem(
      STORAGE_KEY_TRIPS,
      JSON.stringify([sampleTrip]),
    )
    refreshData()

    mapRef.current?.flyTo({
      center: DEMO_ROUTE[0],
      zoom: 15,
      duration: 800,
    })
  }, [refreshData])

  // Clear all local records
  const handleClearData = useCallback(() => {
    if (window.confirm('Delete all recorded potholes and trips on this phone?')) {
      localStorage.removeItem(STORAGE_KEY_POTHOLES)
      localStorage.removeItem(STORAGE_KEY_TRIPS)
      setSelected(null)
      refreshData()
    }
  }, [refreshData])

  // Driven routes GeoJSON
  const routesGeoJSON: GeoJSON.FeatureCollection<GeoJSON.LineString> = useMemo(() => {
    const features: GeoJSON.Feature<GeoJSON.LineString>[] = []
    trips.forEach((t) => {
      if (t.route && t.route.length >= 2) {
        features.push({
          type: 'Feature',
          properties: { id: t.id, distance: t.distanceM },
          geometry: {
            type: 'LineString',
            coordinates: t.route,
          },
        })
      }
    })
    return {
      type: 'FeatureCollection',
      features,
    }
  }, [trips])

  const autoPotholes = potholes.filter((p) => p.source === 'auto')
  const manualPotholes = potholes.filter((p) => p.source === 'manual')

  return (
    <div className="relative flex h-[calc(100vh-4.5rem)] flex-col bg-surface-1">
      {/* Header bar */}
      <div className="flex items-center justify-between border-b border-hairline px-4 py-2.5 bg-surface-1 shrink-0">
        <div className="flex flex-col">
          <div className="flex items-center gap-2">
            <h1 className="text-h3 leading-tight">Pothole Map</h1>
            <span className="rounded-full bg-cyan-950 border border-cyan-800/60 px-2 py-0.5 text-[11px] font-semibold text-cyan-300">
              {potholes.length} found
            </span>
          </div>
          <span className="text-text-2 text-xs">
            {trips.length} trip{trips.length !== 1 && 's'} covered
          </span>
        </div>

        {/* View toggle (Map / List) */}
        <div className="flex items-center rounded-lg bg-surface-2 p-1 border border-hairline">
          <button
            type="button"
            onClick={() => setViewTab('map')}
            className={cn(
              'rounded-md px-3 py-1 text-xs font-medium transition-colors',
              viewTab === 'map'
                ? 'bg-surface-1 text-accent shadow-sm'
                : 'text-text-2 hover:text-text-1',
            )}
          >
            🗺️ Map
          </button>
          <button
            type="button"
            onClick={() => setViewTab('list')}
            className={cn(
              'rounded-md px-3 py-1 text-xs font-medium transition-colors',
              viewTab === 'list'
                ? 'bg-surface-1 text-accent shadow-sm'
                : 'text-text-2 hover:text-text-1',
            )}
          >
            📋 List ({potholes.length})
          </button>
        </div>
      </div>

      {/* Main View Area */}
      {viewTab === 'map' ? (
        <div className="relative flex-1 overflow-hidden">
          <Map
            ref={mapRef}
            initialViewState={{
              longitude: CENTER[0],
              latitude: CENTER[1],
              zoom: 14.5,
              pitch: 0,
              bearing: 0,
            }}
            style={{ width: '100%', height: '100%' }}
            mapStyle={liteStyle}
            attributionControl={false}
          >
            {/* Routes covered polyline layer */}
            {routesGeoJSON.features.length > 0 && (
              <Source id="trip-routes-src" type="geojson" data={routesGeoJSON}>
                <Layer
                  id="trip-routes-glow"
                  type="line"
                  paint={{
                    'line-color': '#0891b2',
                    'line-width': 6,
                    'line-opacity': 0.3,
                    'line-blur': 4,
                  }}
                />
                <Layer
                  id="trip-routes-line"
                  type="line"
                  paint={{
                    'line-color': '#06b6d4',
                    'line-width': 3,
                    'line-opacity': 0.9,
                  }}
                />
              </Source>
            )}

            {/* Auto-detected potholes markers */}
            {autoPotholes.map((p) => {
              const isSelected =
                selected?.at === p.at &&
                selected?.position[0] === p.position[0]
              return (
                <Marker
                  key={`auto-${p.at}-${p.position[0]}`}
                  longitude={p.position[0]}
                  latitude={p.position[1]}
                  anchor="center"
                  onClick={(e) => {
                    e.originalEvent.stopPropagation()
                    handleSelect(p)
                  }}
                >
                  <button
                    type="button"
                    className={cn(
                      'group relative flex items-center justify-center transition-transform active:scale-90',
                      isSelected && 'scale-125 z-20',
                    )}
                    aria-label={`Pothole ${p.magnitude ? p.magnitude.toFixed(1) : ''} m/s²`}
                  >
                    <span className="trip-bump-marker" />
                    {isSelected && (
                      <span className="absolute -top-6 rounded bg-rose-950/90 text-rose-200 border border-rose-700/80 px-1.5 py-0.5 text-[10px] font-mono whitespace-nowrap shadow-lg">
                        {p.magnitude ? `${p.magnitude.toFixed(1)} m/s²` : 'Pothole'}
                      </span>
                    )}
                  </button>
                </Marker>
              )
            })}

            {/* Manual pothole markers */}
            {manualPotholes.map((p) => {
              const isSelected =
                selected?.at === p.at &&
                selected?.position[0] === p.position[0]
              return (
                <Marker
                  key={`manual-${p.at}-${p.position[0]}`}
                  longitude={p.position[0]}
                  latitude={p.position[1]}
                  anchor="center"
                  onClick={(e) => {
                    e.originalEvent.stopPropagation()
                    handleSelect(p)
                  }}
                >
                  <button
                    type="button"
                    className={cn(
                      'group relative flex size-7 items-center justify-center rounded-full border-2 border-white text-xs shadow-lg transition-transform active:scale-90',
                      isSelected && 'scale-125 ring-2 ring-amber-400 z-20',
                    )}
                    style={{ background: severityColor(p.severity) }}
                    aria-label={`Reported pothole ${p.severity}`}
                  >
                    {p.photoUrl ? '📸' : '⚠️'}
                  </button>
                </Marker>
              )
            })}

            {/* My GPS location pin */}
            {myLocation && (
              <Marker
                longitude={myLocation[0]}
                latitude={myLocation[1]}
                anchor="center"
              >
                <div className="trip-driver-dot">
                  <span className="trip-driver-dot__ring" />
                  <span className="trip-driver-dot__core" />
                </div>
              </Marker>
            )}
          </Map>

          {/* Floating Map Controls */}
          <div className="absolute right-3 top-3 flex flex-col gap-2 z-10">
            <button
              type="button"
              onClick={handleLocateMe}
              className="flex size-10 items-center justify-center rounded-xl bg-surface-1/90 border border-hairline text-accent shadow-lg backdrop-blur active:scale-95"
              title="Locate my position"
              aria-label="Locate me"
            >
              <svg viewBox="0 0 24 24" className="size-5 fill-current">
                <path d="M12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm8.94 3A8.994 8.994 0 0 0 13 3.06V1h-2v2.06A8.994 8.994 0 0 0 3.06 11H1v2h2.06A8.994 8.994 0 0 0 11 20.94V23h2v-2.06A8.994 8.994 0 0 0 20.94 13H23v-2h-2.06zM12 19c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z" />
              </svg>
            </button>
          </div>

          {/* Selected Pothole Detail Card */}
          {selected && (
            <div className="absolute inset-x-3 bottom-4 z-20 rounded-2xl bg-surface-1/95 border border-hairline p-4 shadow-2xl backdrop-blur-md">
              <div className="flex items-start justify-between">
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        'size-2.5 rounded-full shrink-0',
                        selected.source === 'auto'
                          ? 'bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.7)]'
                          : 'bg-amber-500',
                      )}
                    />
                    <span className="eyebrow text-accent">
                      {selected.source === 'auto'
                        ? 'Auto-detected Pothole'
                        : 'Driver Reported Pothole'}
                    </span>
                  </div>

                  <span className="text-base font-bold text-text-1">
                    {selected.magnitude
                      ? `${selected.magnitude.toFixed(1)} m/s² Vertical Impact`
                      : `${selected.severity ?? 'Moderate'} Severity Report`}
                  </span>

                  <span className="text-text-2 text-xs">
                    Recorded {new Date(selected.at).toLocaleString()}
                  </span>

                  {/* Precise GPS Coordinates */}
                  <div className="mt-1 flex items-center gap-2 font-mono text-xs text-text-1 bg-surface-2/80 rounded-lg px-2.5 py-1.5 border border-hairline">
                    <span className="text-accent font-semibold">📍 GPS:</span>
                    <span>
                      {selected.position[1].toFixed(5)}° N,{' '}
                      {selected.position[0].toFixed(5)}° E
                    </span>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => setSelected(null)}
                  className="rounded-full bg-surface-2 p-1 text-text-2 hover:text-text-1 text-sm size-7 flex items-center justify-center"
                  aria-label="Close"
                >
                  ✕
                </button>
              </div>

              {/* Photo preview if available */}
              {selected.photoUrl && (
                <div className="mt-3">
                  <button
                    type="button"
                    onClick={() => setPhotoPreview(selected.photoUrl ?? null)}
                    className="overflow-hidden rounded-lg border border-hairline"
                  >
                    <img
                      src={selected.photoUrl}
                      alt="Pothole"
                      className="h-24 w-full object-cover"
                    />
                  </button>
                </div>
              )}

              {/* Action buttons */}
              <div className="mt-3.5 flex gap-2">
                <a
                  href={`https://www.google.com/maps?q=${selected.position[1]},${selected.position[0]}`}
                  target="_blank"
                  rel="noreferrer"
                  className="flex-1 rounded-xl bg-cyan-700 hover:bg-cyan-600 text-white font-medium text-xs py-2.5 text-center shadow transition-colors flex items-center justify-center gap-1.5"
                >
                  <span>🗺️</span> Open in Google Maps
                </a>

                <button
                  type="button"
                  onClick={() => handleCopyCoords(selected.position)}
                  className="rounded-xl bg-surface-2 hover:bg-surface-3 text-text-1 border border-hairline text-xs px-3.5 py-2.5 font-medium transition-colors"
                >
                  {copied ? '✓ Copied' : '📋 Copy Coords'}
                </button>
              </div>
            </div>
          )}

          {/* Empty state overlay with Demo button */}
          {potholes.length === 0 && (
            <div className="absolute inset-x-4 bottom-4 z-10 rounded-2xl bg-surface-1/95 border border-hairline p-5 text-center shadow-xl backdrop-blur-md flex flex-col items-center gap-3">
              <span className="text-3xl">🚗</span>
              <div className="flex flex-col">
                <span className="text-sm font-semibold text-text-1">
                  No drive data recorded yet
                </span>
                <span className="text-text-2 text-xs mt-0.5">
                  Start driving from the Drive tab or load sample road data to explore the map.
                </span>
              </div>
              <div className="flex w-full gap-2 mt-1">
                <Button
                  size="sm"
                  className="flex-1"
                  onClick={() => navigate('/app/trip')}
                >
                  Start Drive
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  className="flex-1"
                  onClick={handleLoadDemo}
                >
                  Load Sample Drive
                </Button>
              </div>
            </div>
          )}
        </div>
      ) : (
        /* List View */
        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="eyebrow">
              All Marked Potholes ({potholes.length})
            </span>
            {potholes.length > 0 && (
              <button
                type="button"
                onClick={handleClearData}
                className="text-xs text-rose-400 hover:underline"
              >
                Clear all data
              </button>
            )}
          </div>

          {potholes.length === 0 ? (
            <div className="rounded-card border border-hairline p-6 text-center flex flex-col items-center gap-3 bg-surface-2/40">
              <p className="text-text-2 text-sm">
                No potholes have been recorded yet.
              </p>
              <Button size="sm" onClick={handleLoadDemo}>
                Load Sample Road Drive
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-2.5">
              {potholes.map((p, idx) => (
                <div
                  key={`${p.at}-${idx}`}
                  className="rounded-card border border-hairline bg-surface-2/60 p-3 flex flex-col gap-2 transition-colors hover:border-accent/40"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          'size-3 rounded-full shrink-0',
                          p.source === 'auto'
                            ? 'bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.6)]'
                            : 'bg-amber-500',
                        )}
                      />
                      <span className="text-xs font-bold text-text-1">
                        {p.source === 'auto'
                          ? `Auto Impact · ${p.magnitude ? p.magnitude.toFixed(1) : ''} m/s²`
                          : `Manual Report · ${p.severity ?? 'Moderate'}`}
                      </span>
                    </div>
                    <span className="text-[11px] text-text-3 font-mono">
                      {new Date(p.at).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs text-text-2">
                      📍 {p.position[1].toFixed(5)}°N, {p.position[0].toFixed(5)}°E
                    </span>

                    <div className="flex items-center gap-2">
                      <a
                        href={`https://www.google.com/maps?q=${p.position[1]},${p.position[0]}`}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded-lg bg-surface-3 hover:bg-surface-2 px-2.5 py-1 text-xs text-text-2 hover:text-text-1 border border-hairline"
                      >
                        Google Maps
                      </a>
                      <button
                        type="button"
                        onClick={() => handleSelect(p)}
                        className="rounded-lg bg-cyan-900/50 text-cyan-300 border border-cyan-500/30 px-2.5 py-1 text-xs font-semibold active:scale-95"
                      >
                        Inspect on Map
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Expanded photo modal */}
      {photoPreview && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur"
          onClick={() => setPhotoPreview(null)}
        >
          <div className="relative max-w-lg w-full">
            <img
              src={photoPreview}
              alt="Pothole full view"
              className="w-full rounded-2xl object-contain max-h-[80vh]"
            />
            <button
              type="button"
              onClick={() => setPhotoPreview(null)}
              className="absolute top-3 right-3 flex size-8 items-center justify-center rounded-full bg-black/60 text-white"
            >
              ✕
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

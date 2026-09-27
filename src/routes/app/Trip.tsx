import { Canvas, useFrame } from '@react-three/fiber'
import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import * as THREE from 'three'
import { CountUp } from '@/components/data-viz/Metric'
import { TripMap } from '@/components/map/TripMap'
import { Button } from '@/components/ui/Button'
import { useCamera } from '@/features/driver/useCamera'
import { useBumpDetection } from '@/features/driver/sensors/useBumpDetection'
import { useWakeLock } from '@/features/driver/sensors/useWakeLock'

/* -----------------------------------------------------------------------
   Manual Marker — a pothole the driver tapped to report, possibly with
   a photo and severity tag.
   ----------------------------------------------------------------------- */

interface ManualMarker {
  at: number
  position: [number, number]
  severity: 'minor' | 'moderate' | 'severe'
  photoUrl: string | null
}

/* -----------------------------------------------------------------------
   Sub-components
   ----------------------------------------------------------------------- */

/** A live trace of vertical acceleration — the road, drawn as it is driven. */
function Seismograph({
  history,
  flash,
}: {
  history: number[]
  flash: boolean
}) {
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const element = canvas.current
    const context = element?.getContext('2d')
    if (!element || !context) return

    const ratio = window.devicePixelRatio || 1
    const width = element.clientWidth
    const height = element.clientHeight
    element.width = width * ratio
    element.height = height * ratio
    context.setTransform(ratio, 0, 0, ratio, 0, 0)

    context.clearRect(0, 0, width, height)

    // Centre line and the ±6 m/s² floor, so the trace has a scale.
    context.strokeStyle = 'rgba(10,16,34,0.12)'
    context.lineWidth = 1
    for (const level of [-6, 0, 6]) {
      const y = height / 2 - (level / 20) * (height / 2)
      context.beginPath()
      context.moveTo(0, y)
      context.lineTo(width, y)
      context.stroke()
    }

    if (history.length > 1) {
      context.beginPath()
      context.strokeStyle = flash ? '#BE123C' : '#0E7490'
      context.lineWidth = 2
      history.forEach((value, index) => {
        const x = (index / (history.length - 1)) * width
        const y = height / 2 - (value / 20) * (height / 2)
        if (index === 0) context.moveTo(x, y)
        else context.lineTo(x, y)
      })
      context.stroke()
    }
  }, [history, flash])

  return (
    <canvas
      ref={canvas}
      className="h-24 w-full"
      role="img"
      aria-label="Live trace of vertical acceleration"
    />
  )
}

function Cube({ beta, gamma }: { beta: number; gamma: number }) {
  const mesh = useRef<THREE.Mesh>(null)

  useFrame(() => {
    if (!mesh.current) return
    mesh.current.rotation.x +=
      ((beta * Math.PI) / 180 - mesh.current.rotation.x) * 0.1
    mesh.current.rotation.z +=
      ((-gamma * Math.PI) / 180 - mesh.current.rotation.z) * 0.1
  })

  return (
    <mesh ref={mesh}>
      <boxGeometry args={[1.1, 0.25, 2]} />
      <meshStandardMaterial color="#0E7490" roughness={0.4} />
    </mesh>
  )
}

/** Speed as a 240° arc. */
function SpeedArc({ kmh }: { kmh: number }) {
  const max = 80
  const fraction = Math.min(1, kmh / max)
  const radius = 52
  const arc = (240 / 360) * 2 * Math.PI * radius

  return (
    <div className="relative size-[120px] shrink-0">
      <svg viewBox="0 0 120 120" className="size-full -rotate-[210deg]">
        <circle
          cx="60"
          cy="60"
          r={radius}
          fill="none"
          stroke="var(--color-surface-3)"
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={`${arc} 999`}
        />
        <circle
          cx="60"
          cy="60"
          r={radius}
          fill="none"
          stroke="var(--color-accent)"
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={`${arc * fraction} 999`}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <CountUp value={kmh} className="text-metric-lg" />
        <span className="eyebrow">km/h</span>
      </div>
    </div>
  )
}

/* -----------------------------------------------------------------------
   Severity Picker — shown after a manual pothole mark.
   ----------------------------------------------------------------------- */

function SeverityPicker({
  onPick,
  onCancel,
}: {
  onPick: (severity: 'minor' | 'moderate' | 'severe') => void
  onCancel: () => void
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 20 }}
      className="absolute inset-x-0 bottom-0 z-30 rounded-t-2xl bg-white p-4 shadow-[0_-8px_30px_rgba(0,0,0,0.15)]"
    >
      <p className="eyebrow mb-3">How bad is it?</p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => onPick('minor')}
          className="flex-1 rounded-xl bg-emerald-50 py-3 text-sm font-semibold text-emerald-700 active:scale-95"
        >
          Minor
        </button>
        <button
          type="button"
          onClick={() => onPick('moderate')}
          className="flex-1 rounded-xl bg-amber-50 py-3 text-sm font-semibold text-amber-700 active:scale-95"
        >
          Moderate
        </button>
        <button
          type="button"
          onClick={() => onPick('severe')}
          className="flex-1 rounded-xl bg-rose-50 py-3 text-sm font-semibold text-rose-700 active:scale-95"
        >
          Severe
        </button>
      </div>
      <button
        type="button"
        onClick={onCancel}
        className="mt-2 w-full py-2 text-xs text-gray-400"
      >
        Skip
      </button>
    </motion.div>
  )
}

/* -----------------------------------------------------------------------
   Photo Capture Overlay — opens camera, takes a snap, and returns it.
   ----------------------------------------------------------------------- */

function PhotoCapture({
  onCapture,
  onClose,
}: {
  onCapture: (photoUrl: string) => void
  onClose: () => void
}) {
  const {
    videoRef,
    state: cameraState,
    error: cameraError,
    start: startCamera,
    stop: stopCamera,
    capture: captureFrame,
  } = useCamera()

  useEffect(() => {
    void startCamera()
    return () => stopCamera()
  }, [startCamera, stopCamera])

  const takeShot = () => {
    const frame = captureFrame()
    if (frame) {
      stopCamera()
      onCapture(frame)
    }
  }

  return (
    <div className="trip-photo-capture">
      {cameraState === 'live' ? (
        <video ref={videoRef} autoPlay playsInline muted className="flex-1 object-cover" />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-white">
          {cameraState === 'starting' && <p>Opening camera…</p>}
          {cameraState === 'denied' && <p>Camera access was declined.</p>}
          {cameraState === 'unavailable' && (
            <p>{cameraError || 'No camera on this device.'}</p>
          )}
        </div>
      )}
      <div className="trip-photo-capture__controls">
        <button type="button" onClick={onClose} className="text-sm text-white/70">
          Cancel
        </button>
        {cameraState === 'live' && (
          <button
            type="button"
            onClick={takeShot}
            className="trip-shutter"
            aria-label="Take photo"
          />
        )}
        <span className="w-12" /> {/* spacer */}
      </div>
    </div>
  )
}

/* -----------------------------------------------------------------------
   Main Trip Page
   ----------------------------------------------------------------------- */

export function Trip() {
  const navigate = useNavigate()
  const {
    state,
    start,
    stop,
    simulate,
    startRecording,
    stopRecording,
    mark,
    downloadTrace,
  } = useBumpDetection()
  const wakeLock = useWakeLock()
  const [flash, setFlash] = useState(false)
  const [chips, setChips] = useState<number[]>([])
  const [finished, setFinished] = useState(false)
  const [wantRecording, setWantRecording] = useState(false)
  const [saved, setSaved] = useState<boolean | null>(null)
  const lastCount = useRef(0)
  const tripStartTime = useRef<number>(Date.now())
  const [bumpAlert, setBumpAlert] = useState<{
    magnitude: number
    position: [number, number] | null
    at: number
  } | null>(null)

  // Route tracking — accumulate [lon, lat] pairs from GPS.
  const [route, setRoute] = useState<[number, number][]>([])
  const lastRoutePosition = useRef<[number, number] | null>(null)

  // Manual markers (pothole reports with severity + optional photo).
  const [manualMarkers, setManualMarkers] = useState<ManualMarker[]>([])
  const [showSeverityPicker, setShowSeverityPicker] = useState(false)
  const [showCamera, setShowCamera] = useState(false)
  const pendingMarkerPosition = useRef<[number, number] | null>(null)
  const pendingMarkerPhoto = useRef<string | null>(null)

  // Bump flash & toast alert effect.
  useEffect(() => {
    if (state.bumps.length === lastCount.current) return
    lastCount.current = state.bumps.length

    setFlash(true)
    const id = setTimeout(() => setFlash(false), 220)
    setChips((c) => [...c, Date.now()].slice(-4))

    const latest = state.bumps[0]
    if (latest) {
      setBumpAlert({
        magnitude: latest.magnitude,
        position: latest.position,
        at: latest.at,
      })
      const alertTimer = setTimeout(() => setBumpAlert(null), 3500)
      return () => {
        clearTimeout(id)
        clearTimeout(alertTimer)
      }
    }

    return () => clearTimeout(id)
  }, [state.bumps.length, state.bumps])

  // Accumulate route points from GPS position.
  useEffect(() => {
    if (!state.position) return
    const [lon, lat] = state.position
    const last = lastRoutePosition.current
    // Only add a point if we moved at least ~5m (avoids GPS jitter at standstill).
    if (last) {
      const dx = (lon - last[0]) * 111320 * Math.cos((lat * Math.PI) / 180)
      const dy = (lat - last[1]) * 110540
      if (Math.hypot(dx, dy) < 5) return
    }
    lastRoutePosition.current = [lon, lat]
    setRoute((r) => [...r, [lon, lat]])
  }, [state.position])

  const kmh = Math.round(state.speedMs * 3.6)

  // Mark pothole manually — first capture position, then ask severity.
  const handleMarkPothole = useCallback(() => {
    mark() // also registers in the raw trace
    if (state.position) {
      pendingMarkerPosition.current = state.position
      pendingMarkerPhoto.current = null
      setShowSeverityPicker(true)
    }
  }, [mark, state.position])

  const handleSeverityPick = useCallback(
    (severity: 'minor' | 'moderate' | 'severe') => {
      if (pendingMarkerPosition.current) {
        setManualMarkers((prev) => [
          ...prev,
          {
            at: Date.now(),
            position: pendingMarkerPosition.current!,
            severity,
            photoUrl: pendingMarkerPhoto.current,
          },
        ])
      }
      setShowSeverityPicker(false)
    },
    [],
  )

  const handleSeverityCancel = useCallback(() => {
    // Still add the marker, default to moderate.
    if (pendingMarkerPosition.current) {
      setManualMarkers((prev) => [
        ...prev,
        {
          at: Date.now(),
          position: pendingMarkerPosition.current!,
          severity: 'moderate',
          photoUrl: pendingMarkerPhoto.current,
        },
      ])
    }
    setShowSeverityPicker(false)
  }, [])

  const handlePhotoCapture = useCallback(
    (photoUrl: string) => {
      pendingMarkerPhoto.current = photoUrl
      setShowCamera(false)
      // After taking photo, record the pothole mark.
      mark()
      if (state.position) {
        pendingMarkerPosition.current = state.position
        setShowSeverityPicker(true)
      }
    },
    [mark, state.position],
  )

  /* ---- Summary Screen ------------------------------------------------- */

  if (finished) {
    const roughest = state.bumps.reduce(
      (worst, bump) => (bump.magnitude > worst ? bump.magnitude : worst),
      0,
    )

    return (
      <div className="flex flex-col gap-5 p-5">
        <h1 className="text-h2">Trip summary</h1>

        {/* Route map */}
        {route.length >= 2 && (
          <TripMap
            position={null}
            speedMs={0}
            route={route}
            bumps={state.bumps}
            manualMarkers={manualMarkers}
            className="h-[240px]"
          />
        )}

        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-card border-hairline bg-surface-1 flex flex-col gap-1 border p-4">
            <span className="eyebrow">Distance</span>
            <CountUp
              value={state.distanceM / 1000}
              decimals={2}
              format={(v) => `${v.toFixed(2)} km`}
              className="text-metric-lg"
            />
          </div>
          <div className="rounded-card border-hairline bg-surface-1 flex flex-col gap-1 border p-4">
            <span className="eyebrow">Bumps detected</span>
            <CountUp
              value={state.bumps.length}
              className="text-metric-lg text-health-critical"
            />
          </div>
          <div className="rounded-card border-hairline bg-surface-1 flex flex-col gap-1 border p-4">
            <span className="eyebrow">Manual reports</span>
            <CountUp
              value={manualMarkers.length}
              className="text-metric-lg text-health-watch"
            />
          </div>
          <div className="rounded-card border-hairline bg-surface-1 flex flex-col gap-1 border p-4">
            <span className="eyebrow">Roughest hit</span>
            <CountUp
              value={roughest}
              decimals={1}
              format={(v) => `${v.toFixed(1)} m/s²`}
              className="text-metric-md"
            />
          </div>
        </div>

        {/* Photo gallery from manual reports */}
        {manualMarkers.some((m) => m.photoUrl) && (
          <div className="flex flex-col gap-2">
            <span className="eyebrow">Photos captured</span>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {manualMarkers
                .filter((m) => m.photoUrl)
                .map((m) => (
                  <img
                    key={m.at}
                    src={m.photoUrl!}
                    alt={`Pothole at ${m.position[1].toFixed(4)}, ${m.position[0].toFixed(4)}`}
                    className="h-24 w-32 shrink-0 rounded-lg border border-gray-200 object-cover"
                  />
                ))}
            </div>
          </div>
        )}

        {state.recordedSamples > 0 && (
          <div className="border-hairline rounded-card flex flex-col gap-2 border p-4">
            <span className="eyebrow">Raw trace</span>
            <p className="text-text-2 text-sm">
              {state.recordedSamples.toLocaleString('en-IN')} readings and{' '}
              {state.markers.length} marked potholes. Save this and the detector
              can be re-tuned against this drive without driving it again.
            </p>
            <Button
              variant="secondary"
              onClick={() => setSaved(downloadTrace())}
            >
              Save trace to this phone
            </Button>
            {saved === true && (
              <span className="text-health-good text-xs">
                Saved to your downloads.
              </span>
            )}
            {saved === false && (
              <span className="text-health-critical text-xs">
                Nothing to save — the trip was too short.
              </span>
            )}
          </div>
        )}

        {/* Potholes recorded list */}
        {(state.bumps.some((b) => b.position) || manualMarkers.length > 0) && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="eyebrow">
                Potholes Marked ({state.bumps.filter((b) => b.position).length + manualMarkers.length})
              </span>
              <button
                type="button"
                onClick={() => navigate('/app/map')}
                className="text-xs font-semibold text-cyan-400 hover:underline"
              >
                Open Full Map →
              </button>
            </div>
            <div className="flex flex-col gap-2 max-h-56 overflow-y-auto pr-1">
              {state.bumps
                .filter((b) => b.position)
                .map((b) => (
                  <div
                    key={`bump-${b.at}`}
                    className="flex items-center justify-between p-3 rounded-card bg-surface-1 border border-hairline text-sm"
                  >
                    <div className="flex items-center gap-2.5">
                      <span className="inline-block size-3 rounded-full bg-rose-500 shrink-0 shadow-[0_0_8px_rgba(244,63,94,0.6)]" />
                      <div className="flex flex-col">
                        <span className="font-semibold text-xs text-text-1">
                          Auto-detected · {b.magnitude.toFixed(1)} m/s²
                        </span>
                        <span className="font-mono text-[11px] text-text-2">
                          {b.position![1].toFixed(5)}°N, {b.position![0].toFixed(5)}°E
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <a
                        href={`https://www.google.com/maps?q=${b.position![1]},${b.position![0]}`}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded-lg bg-surface-2 hover:bg-surface-3 px-2 py-1 text-xs text-text-2 hover:text-text-1"
                        title="Open in Google Maps"
                      >
                        Google Maps
                      </a>
                      <button
                        type="button"
                        onClick={() => navigate(`/app/map?lat=${b.position![1]}&lon=${b.position![0]}`)}
                        className="rounded-lg bg-cyan-900/40 text-cyan-300 border border-cyan-500/30 px-2 py-1 text-xs font-medium active:scale-95"
                      >
                        Pin
                      </button>
                    </div>
                  </div>
                ))}
              {manualMarkers.map((m) => (
                <div
                  key={`manual-${m.at}`}
                  className="flex items-center justify-between p-3 rounded-card bg-surface-1 border border-hairline text-sm"
                >
                  <div className="flex items-center gap-2.5">
                    <span className="text-base shrink-0">⚠️</span>
                    <div className="flex flex-col">
                      <span className="font-semibold text-xs text-text-1 capitalize">
                        Manual · {m.severity} severity
                      </span>
                      <span className="font-mono text-[11px] text-text-2">
                        {m.position[1].toFixed(5)}°N, {m.position[0].toFixed(5)}°E
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <a
                      href={`https://www.google.com/maps?q=${m.position[1]},${m.position[0]}`}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-lg bg-surface-2 hover:bg-surface-3 px-2 py-1 text-xs text-text-2 hover:text-text-1"
                    >
                      Google Maps
                    </a>
                    <button
                      type="button"
                      onClick={() => navigate(`/app/map?lat=${m.position[1]}&lon=${m.position[0]}`)}
                      className="rounded-lg bg-cyan-900/40 text-cyan-300 border border-cyan-500/30 px-2 py-1 text-xs font-medium active:scale-95"
                    >
                      Pin
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex flex-col gap-2 pt-2">
          <Button
            size="lg"
            className="w-full"
            onClick={() => navigate('/app/map')}
          >
            🗺️ View Trip & All Potholes on Map
          </Button>
          <div className="flex gap-2">
            <Button variant="secondary" className="flex-1" onClick={() => navigate('/app')}>
              Done
            </Button>
            <Button variant="secondary" className="flex-1" onClick={() => navigate('/app/report')}>
              Report a pothole
            </Button>
          </div>
        </div>
      </div>
    )
  }

  /* ---- Active Trip Screen --------------------------------------------- */

  return (
    <div className="relative flex flex-col">
      {/* Camera overlay */}
      {showCamera && (
        <PhotoCapture
          onCapture={handlePhotoCapture}
          onClose={() => setShowCamera(false)}
        />
      )}

      {/* Severity picker overlay */}
      <AnimatePresence>
        {showSeverityPicker && (
          <SeverityPicker
            onPick={handleSeverityPick}
            onCancel={handleSeverityCancel}
          />
        )}
      </AnimatePresence>

      {/* Real-time bump detected banner */}
      <AnimatePresence>
        {bumpAlert && (
          <motion.div
            initial={{ opacity: 0, y: -20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.95 }}
            className="absolute top-4 inset-x-4 z-30 flex items-center justify-between rounded-2xl bg-rose-600/95 text-white p-3.5 shadow-2xl backdrop-blur-md border border-white/20"
          >
            <div className="flex items-center gap-2.5">
              <span className="text-2xl animate-bounce">⚠️</span>
              <div className="flex flex-col">
                <span className="text-xs font-bold uppercase tracking-wider">
                  Pothole Detected · {bumpAlert.magnitude.toFixed(1)} m/s²
                </span>
                {bumpAlert.position ? (
                  <span className="text-[11px] font-mono opacity-90">
                    📍 {bumpAlert.position[1].toFixed(5)}° N, {bumpAlert.position[0].toFixed(5)}° E
                  </span>
                ) : (
                  <span className="text-[11px] opacity-80">Location logged</span>
                )}
              </div>
            </div>
            <span className="text-[11px] font-semibold bg-white/20 px-2 py-1 rounded-full shrink-0">
              Saved
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Live map — takes the top portion of the screen */}
      {state.running && (
        <TripMap
          position={state.position}
          speedMs={state.speedMs}
          route={route}
          bumps={state.bumps}
          manualMarkers={manualMarkers}
          className="h-[45vh] w-full"
        />
      )}

      <div className="flex flex-col gap-4 p-4">
        {/* Status header */}
        <div className="flex items-start justify-between">
          <div className="flex flex-col">
            <span className="eyebrow">Trip in progress</span>
            <span className="text-h3">
              {state.running ? 'Recording' : 'Not started'}
            </span>
            {state.running && (
              <span
                className={
                  wakeLock.state === 'active'
                    ? 'text-text-2 text-xs'
                    : 'text-health-critical text-xs'
                }
              >
                {wakeLock.state === 'active'
                  ? 'Screen will stay on'
                  : wakeLock.state === 'unsupported'
                    ? 'Keep the screen on'
                    : 'Screen may sleep'}
              </span>
            )}
          </div>
          <span className="metric text-metric-sm text-text-2">
            {(state.distanceM / 1000).toFixed(2)} km
          </span>
        </div>

        {/* Instruments — only while driving */}
        {state.running && (
          <>
            <div className="flex items-center gap-3">
              <SpeedArc kmh={kmh} />

              <div className="flex flex-1 flex-col gap-2">
                <div className="flex items-baseline justify-between">
                  <span className="eyebrow">Bumps</span>
                  <CountUp
                    value={state.bumps.length}
                    className="text-metric-md text-health-critical"
                  />
                </div>
                <div className="flex items-baseline justify-between">
                  <span className="eyebrow">Marked</span>
                  <CountUp
                    value={manualMarkers.length}
                    className="text-metric-md text-health-watch"
                  />
                </div>

                {/* Attitude indicator */}
                <div className="rounded-card border-hairline bg-surface-1 h-14 overflow-hidden border">
                  <Canvas camera={{ position: [0, 1.6, 2.6], fov: 40 }}>
                    <ambientLight intensity={0.7} />
                    <directionalLight position={[2, 4, 2]} intensity={1.2} />
                    <Cube beta={state.heading.beta} gamma={state.heading.gamma} />
                  </Canvas>
                </div>
              </div>
            </div>

            {/* Seismograph */}
            <div
              className={`rounded-card bg-surface-1 relative overflow-hidden border ${
                flash ? 'border-health-critical' : 'border-hairline'
              }`}
            >
              <Seismograph history={state.history} flash={flash} />

              <AnimatePresence>
                {chips.map((chip) => (
                  <motion.span
                    key={chip}
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: -28 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.9 }}
                    className="metric bg-health-critical text-metric-sm absolute right-4 bottom-2 rounded-full px-2 py-0.5 text-white"
                  >
                    +1 bump
                  </motion.span>
                ))}
              </AnimatePresence>
            </div>
          </>
        )}

        {/* Pre-trip setup */}
        {!state.running && (
          <div className="rounded-card border-hairline bg-surface-1 flex flex-col gap-3 border p-4">
            <h2 className="text-h3">Ready to drive</h2>
            <p className="text-text-2 text-sm">
              Mount the phone first — a loose phone reports its own rattling
              rather than the road. Motion and location are requested on the tap
              below.
            </p>
            <label className="border-hairline rounded-card flex items-start gap-3 border p-3">
              <input
                type="checkbox"
                checked={wantRecording}
                onChange={(e) => setWantRecording(e.target.checked)}
                className="mt-0.5 size-6 shrink-0 accent-[var(--color-accent)]"
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-sm">Record raw sensor trace</span>
                <span className="text-text-2 text-xs">
                  Keeps every reading so the detector can be tuned later.
                </span>
              </span>
            </label>

            <div className="flex flex-col gap-2">
              <Button
                size="lg"
                className="w-full"
                onClick={() => {
                  void start()
                  void wakeLock.request()
                  if (wantRecording) startRecording()
                }}
              >
                Use phone sensors
              </Button>
              <Button
                variant="secondary"
                size="lg"
                className="w-full"
                onClick={() => {
                  simulate()
                  void wakeLock.request()
                  if (wantRecording) startRecording()
                }}
              >
                Simulate drive
              </Button>
            </div>
            {state.permission === 'denied' && (
              <p className="text-health-critical text-sm">
                Motion access was declined. Simulate a drive instead, or allow
                motion in the browser settings.
              </p>
            )}
          </div>
        )}

        {/* Action buttons — during drive */}
        {state.running && (
          <div className="flex gap-2">
            {/* Mark Pothole button — big and thumb-friendly */}
            <button
              type="button"
              onClick={handleMarkPothole}
              className="flex flex-1 flex-col items-center justify-center gap-1 rounded-2xl bg-amber-500 py-4 text-white shadow-lg active:scale-95"
            >
              <span className="text-2xl">⚠️</span>
              <span className="text-xs font-semibold uppercase tracking-wider">
                Mark Pothole
              </span>
            </button>

            {/* Camera button */}
            <button
              type="button"
              onClick={() => setShowCamera(true)}
              className="flex flex-col items-center justify-center gap-1 rounded-2xl bg-cyan-600 px-5 py-4 text-white shadow-lg active:scale-95"
            >
              <span className="text-2xl">📸</span>
              <span className="text-xs font-semibold uppercase tracking-wider">
                Photo
              </span>
            </button>
          </div>
        )}

        {/* Recording indicator */}
        {state.running && state.recording && (
          <div className="border-hairline rounded-card flex items-baseline justify-between border p-3">
            <span className="eyebrow text-accent">● Recording</span>
            <span className="metric text-metric-sm text-text-2">
              {state.recordedSamples.toLocaleString('en-IN')} samples
            </span>
          </div>
        )}

        {/* Stop trip */}
        {state.running && (
          <Button
            size="lg"
            variant="destructive"
            onClick={() => {
              stop()
              stopRecording()
              void wakeLock.release()

                // Persist potholes for the Map tab.
                const STORAGE_KEY = 'infrapulse-local-potholes'
                const TRIPS_KEY = 'infrapulse-local-trips'
                try {
                  const existing = JSON.parse(
                    localStorage.getItem(STORAGE_KEY) || '[]',
                  )
                  const autoBumps = state.bumps
                    .filter((b) => b.position)
                    .map((b) => ({
                      at: b.at,
                      position: b.position,
                      magnitude: b.magnitude,
                      source: 'auto' as const,
                    }))
                  const manuals = manualMarkers.map((m) => ({
                    at: m.at,
                    position: m.position,
                    severity: m.severity,
                    photoUrl: m.photoUrl,
                    source: 'manual' as const,
                  }))
                  localStorage.setItem(
                    STORAGE_KEY,
                    JSON.stringify([...existing, ...autoBumps, ...manuals]),
                  )

                  // Persist the trip and full route polyline.
                  const existingTrips = JSON.parse(
                    localStorage.getItem(TRIPS_KEY) || '[]',
                  )
                  const newTrip = {
                    id: `trip-${Date.now()}`,
                    startTime: tripStartTime.current,
                    endTime: Date.now(),
                    distanceM: state.distanceM,
                    route: route,
                    bumps: autoBumps,
                    manualMarkers: manuals,
                  }
                  localStorage.setItem(
                    TRIPS_KEY,
                    JSON.stringify([newTrip, ...existingTrips]),
                  )
                } catch {
                  // Storage full or disabled — not fatal.
                }

                setFinished(true)
              }}
          >
            Stop trip
          </Button>
        )}
      </div>
    </div>
  )
}

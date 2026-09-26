import { Canvas, useFrame } from '@react-three/fiber'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import * as THREE from 'three'
import { CountUp } from '@/components/data-viz/Metric'
import { Button } from '@/components/ui/Button'
import { useBumpDetection } from '@/features/driver/sensors/useBumpDetection'
import { useWakeLock } from '@/features/driver/sensors/useWakeLock'

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
      className="h-32 w-full"
      role="img"
      aria-label="Live trace of vertical acceleration"
    />
  )
}

function Cube({ beta, gamma }: { beta: number; gamma: number }) {
  const mesh = useRef<THREE.Mesh>(null)

  useFrame(() => {
    if (!mesh.current) return
    // Ease toward the phone's real attitude rather than snapping, or sensor
    // jitter makes the cube vibrate.
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

/** Speed as a 240° arc (UI_DESIGN 5.8). */
function SpeedArc({ kmh }: { kmh: number }) {
  const max = 80
  const fraction = Math.min(1, kmh / max)
  const radius = 62
  const arc = (240 / 360) * 2 * Math.PI * radius

  return (
    <div className="relative size-[160px] shrink-0">
      <svg viewBox="0 0 160 160" className="size-full -rotate-[210deg]">
        <circle
          cx="80"
          cy="80"
          r={radius}
          fill="none"
          stroke="var(--color-surface-3)"
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={`${arc} 999`}
        />
        <circle
          cx="80"
          cy="80"
          r={radius}
          fill="none"
          stroke="var(--color-accent)"
          strokeWidth="10"
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
  /* Off by default: recording is for calibration drives, not every trip. */
  const [wantRecording, setWantRecording] = useState(false)
  const [saved, setSaved] = useState<boolean | null>(null)
  const lastCount = useRef(0)

  useEffect(() => {
    if (state.bumps.length === lastCount.current) return
    lastCount.current = state.bumps.length

    setFlash(true)
    const id = setTimeout(() => setFlash(false), 220)
    setChips((c) => [...c, Date.now()].slice(-4))
    return () => clearTimeout(id)
  }, [state.bumps.length])

  const kmh = Math.round(state.speedMs * 3.6)

  if (finished) {
    const roughest = state.bumps.reduce(
      (worst, bump) => (bump.magnitude > worst ? bump.magnitude : worst),
      0,
    )

    return (
      <div className="flex flex-col gap-6 p-6">
        <h1 className="text-h2">Trip summary</h1>

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
            <span className="eyebrow">Roughest hit</span>
            <CountUp
              value={roughest}
              decimals={1}
              format={(v) => `${v.toFixed(1)} m/s²`}
              className="text-metric-md"
            />
          </div>
          <div className="rounded-card border-hairline bg-surface-1 flex flex-col gap-1 border p-4">
            <span className="eyebrow">Bumps per km</span>
            <CountUp
              value={
                state.distanceM > 50
                  ? state.bumps.length / (state.distanceM / 1000)
                  : 0
              }
              decimals={1}
              className="text-metric-md"
            />
          </div>
        </div>

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

        <div className="flex gap-2">
          <Button onClick={() => navigate('/app')}>Done</Button>
          <Button variant="secondary" onClick={() => navigate('/app/report')}>
            Report a pothole
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5 p-5">
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
                  ? 'Keep the screen on — this phone cannot hold it for you'
                  : 'Screen may sleep. Recording stops if it does.'}
            </span>
          )}
        </div>
        <span className="metric text-metric-sm text-text-2">
          {(state.distanceM / 1000).toFixed(2)} km
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <SpeedArc kmh={kmh} />

        <div className="flex flex-1 flex-col gap-2">
          <span className="eyebrow">Bumps this trip</span>
          <CountUp
            value={state.bumps.length}
            className="text-metric-lg text-health-critical"
          />

          <div className="rounded-card border-hairline bg-surface-1 h-16 overflow-hidden border">
            <Canvas camera={{ position: [0, 1.6, 2.6], fov: 40 }}>
              <ambientLight intensity={0.7} />
              <directionalLight position={[2, 4, 2]} intensity={1.2} />
              <Cube beta={state.heading.beta} gamma={state.heading.gamma} />
            </Canvas>
          </div>
        </div>
      </div>

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

      {!state.running && (
        <div className="rounded-card border-hairline bg-surface-1 flex flex-col gap-3 border p-4">
          <p className="text-text-2 text-sm">
            Motion and location permissions are requested on the tap below — iOS
            only grants them from inside the gesture.
          </p>
          <label className="border-hairline rounded-card flex items-start gap-3 border p-3">
            <input
              type="checkbox"
              checked={wantRecording}
              onChange={(e) => setWantRecording(e.target.checked)}
              className="mt-1 size-5 accent-[var(--color-accent)]"
            />
            <span className="flex flex-col gap-0.5">
              <span className="text-sm">Record raw sensor trace</span>
              <span className="text-text-2 text-xs">
                Keeps every reading so the detector can be tuned against this
                drive afterwards. Saved to this phone at the end — nothing is
                uploaded.
              </span>
            </span>
          </label>

          <div className="flex flex-wrap gap-2">
            <Button
              size="lg"
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

      {state.running && state.recording && (
        <div className="border-hairline rounded-card flex flex-col gap-3 border p-3">
          <div className="flex items-baseline justify-between">
            <span className="eyebrow text-accent">Recording</span>
            <span className="metric text-metric-sm text-text-2">
              {state.recordedSamples.toLocaleString('en-IN')} samples ·{' '}
              {state.markers.length} marked
            </span>
          </div>

          {/* Ground truth. Tapped when the driver feels a hit, so the replay
              can tell a correct detection from a lucky one. */}
          <Button
            size="lg"
            variant="secondary"
            className="text-h3 min-h-[72px]"
            onClick={mark}
          >
            I felt that one
          </Button>
        </div>
      )}

      {state.running && (
        <Button
          size="lg"
          variant="destructive"
          onClick={() => {
            stop()
            stopRecording()
            void wakeLock.release()
            setFinished(true)
          }}
        >
          Stop trip
        </Button>
      )}
    </div>
  )
}

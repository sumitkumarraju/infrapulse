import { Canvas, useFrame } from '@react-three/fiber'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import * as THREE from 'three'
import { CountUp } from '@/components/data-viz/Metric'
import { Button } from '@/components/ui/Button'
import { useBumpDetection } from '@/features/driver/sensors/useBumpDetection'

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
  const { state, start, stop, simulate } = useBumpDetection()
  const [flash, setFlash] = useState(false)
  const [chips, setChips] = useState<number[]>([])
  const [finished, setFinished] = useState(false)
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
          <div className="flex flex-col gap-1 rounded-card border border-hairline bg-surface-1 p-4">
            <span className="eyebrow">Distance</span>
            <CountUp
              value={state.distanceM / 1000}
              decimals={2}
              format={(v) => `${v.toFixed(2)} km`}
              className="text-metric-lg"
            />
          </div>
          <div className="flex flex-col gap-1 rounded-card border border-hairline bg-surface-1 p-4">
            <span className="eyebrow">Bumps detected</span>
            <CountUp
              value={state.bumps.length}
              className="text-metric-lg text-health-critical"
            />
          </div>
          <div className="flex flex-col gap-1 rounded-card border border-hairline bg-surface-1 p-4">
            <span className="eyebrow">Roughest hit</span>
            <CountUp
              value={roughest}
              decimals={1}
              format={(v) => `${v.toFixed(1)} m/s²`}
              className="text-metric-md"
            />
          </div>
          <div className="flex flex-col gap-1 rounded-card border border-hairline bg-surface-1 p-4">
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

          <div className="h-16 overflow-hidden rounded-card border border-hairline bg-surface-1">
            <Canvas camera={{ position: [0, 1.6, 2.6], fov: 40 }}>
              <ambientLight intensity={0.7} />
              <directionalLight position={[2, 4, 2]} intensity={1.2} />
              <Cube beta={state.heading.beta} gamma={state.heading.gamma} />
            </Canvas>
          </div>
        </div>
      </div>

      <div
        className={`relative overflow-hidden rounded-card border bg-surface-1 ${
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
              className="metric absolute right-4 bottom-2 rounded-full bg-health-critical px-2 py-0.5 text-metric-sm text-white"
            >
              +1 bump
            </motion.span>
          ))}
        </AnimatePresence>
      </div>

      {!state.running && (
        <div className="flex flex-col gap-3 rounded-card border border-hairline bg-surface-1 p-4">
          <p className="text-sm text-text-2">
            Motion and location permissions are requested on the tap below —
            iOS only grants them from inside the gesture.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="lg" onClick={() => void start()}>
              Use phone sensors
            </Button>
            <Button variant="secondary" size="lg" onClick={simulate}>
              Simulate drive
            </Button>
          </div>
          {state.permission === 'denied' && (
            <p className="text-sm text-health-critical">
              Motion access was declined. Simulate a drive instead, or allow
              motion in the browser settings.
            </p>
          )}
        </div>
      )}

      {state.running && (
        <Button
          size="lg"
          variant="destructive"
          onClick={() => {
            stop()
            setFinished(true)
          }}
        >
          Stop trip
        </Button>
      )}
    </div>
  )
}

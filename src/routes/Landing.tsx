import { Canvas, useFrame } from '@react-three/fiber'
import { Bloom, EffectComposer } from '@react-three/postprocessing'
import { useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import seedrandom from 'seedrandom'
import * as THREE from 'three'
import { CountUp, formatInr } from '@/components/data-viz/Metric'
import { Button } from '@/components/ui/Button'
import { useKpis } from '@/data/hooks'
import { prefersReducedMotion } from '@/design/motion'

/* A low-poly night city (UI_DESIGN 5.1). Not a render of the real road network
 * — that is what /command is for. This is the poster: blocks, glowing roads,
 * light moving along them, and a red ring breathing where a pothole is. */

const GRID = 9
const SPACING = 4.2

function Blocks() {
  const rng = useMemo(() => seedrandom('infrapulse-demo:city'), [])

  const blocks = useMemo(() => {
    const result: { position: [number, number, number]; scale: [number, number, number] }[] = []
    for (let x = 0; x < GRID; x++) {
      for (let z = 0; z < GRID; z++) {
        // Leave the middle open so the camera has somewhere to look.
        if (Math.abs(x - GRID / 2) < 1 && Math.abs(z - GRID / 2) < 1) continue
        const height = 0.6 + rng() ** 2 * 6
        result.push({
          position: [
            (x - GRID / 2) * SPACING + (rng() - 0.5),
            height / 2,
            (z - GRID / 2) * SPACING + (rng() - 0.5),
          ],
          scale: [1.6 + rng(), height, 1.6 + rng()],
        })
      }
    }
    return result
  }, [rng])

  return (
    <group>
      {blocks.map((block, i) => (
        <mesh key={i} position={block.position} scale={block.scale}>
          <boxGeometry />
          <meshStandardMaterial
            color="#0B1226"
            roughness={0.85}
            metalness={0.15}
          />
        </mesh>
      ))}
    </group>
  )
}

function Roads() {
  const extent = (GRID * SPACING) / 2

  return (
    <group position={[0, 0.02, 0]}>
      {Array.from({ length: GRID + 1 }, (_, i) => {
        const offset = (i - GRID / 2) * SPACING - SPACING / 2
        return (
          <group key={i}>
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, offset]}>
              <planeGeometry args={[extent * 2, 0.36]} />
              <meshBasicMaterial color="#22D3EE" transparent opacity={0.5} />
            </mesh>
            <mesh rotation={[-Math.PI / 2, 0, Math.PI / 2]} position={[offset, 0, 0]}>
              <planeGeometry args={[extent * 2, 0.36]} />
              <meshBasicMaterial color="#22D3EE" transparent opacity={0.5} />
            </mesh>
          </group>
        )
      })}
    </group>
  )
}

/** Traffic: points sliding along the grid lines. */
function Traffic({ count = 90 }: { count?: number }) {
  const points = useRef<THREE.Points>(null)
  const rng = useMemo(() => seedrandom('infrapulse-demo:traffic'), [])

  const { positions, speeds, axes, lanes } = useMemo(() => {
    const positions = new Float32Array(count * 3)
    const speeds = new Float32Array(count)
    const axes = new Uint8Array(count)
    const lanes = new Float32Array(count)
    const extent = (GRID * SPACING) / 2

    for (let i = 0; i < count; i++) {
      const lane =
        (Math.floor(rng() * (GRID + 1)) - GRID / 2) * SPACING - SPACING / 2
      const along = (rng() - 0.5) * extent * 2
      axes[i] = rng() > 0.5 ? 1 : 0
      lanes[i] = lane
      speeds[i] = (0.6 + rng() * 1.4) * (rng() > 0.5 ? 1 : -1)

      positions[i * 3] = axes[i] === 0 ? along : lane
      positions[i * 3 + 1] = 0.16
      positions[i * 3 + 2] = axes[i] === 0 ? lane : along
    }

    return { positions, speeds, axes, lanes }
  }, [count, rng])

  useFrame((_, delta) => {
    const geometry = points.current?.geometry
    if (!geometry) return
    const array = geometry.attributes.position.array as Float32Array
    const extent = (GRID * SPACING) / 2

    for (let i = 0; i < count; i++) {
      const index = axes[i] === 0 ? i * 3 : i * 3 + 2
      array[index] += speeds[i] * delta * 4
      if (array[index] > extent) array[index] = -extent
      if (array[index] < -extent) array[index] = extent
      // Keep each light in its lane even after wrapping.
      array[axes[i] === 0 ? i * 3 + 2 : i * 3] = lanes[i]
    }

    geometry.attributes.position.needsUpdate = true
  })

  return (
    <points ref={points}>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          args={[positions, 3]}
          count={count}
        />
      </bufferGeometry>
      <pointsMaterial size={0.22} color="#67E8F9" sizeAttenuation />
    </points>
  )
}

/** Where a pothole is: a ring that breathes. */
function PulseRing({
  position,
  delay,
}: {
  position: [number, number, number]
  delay: number
}) {
  const mesh = useRef<THREE.Mesh>(null)

  useFrame(({ clock }) => {
    if (!mesh.current) return
    const t = (clock.elapsedTime + delay) % 2.2
    const scale = 0.4 + t * 1.6
    mesh.current.scale.setScalar(scale)
    const material = mesh.current.material as THREE.MeshBasicMaterial
    material.opacity = Math.max(0, 0.8 - t / 2.2)
  })

  return (
    <mesh ref={mesh} position={position} rotation={[-Math.PI / 2, 0, 0]}>
      <ringGeometry args={[0.9, 1, 32]} />
      <meshBasicMaterial color="#F43F5E" transparent opacity={0.8} />
    </mesh>
  )
}

function DriftingCamera({ enabled }: { enabled: boolean }) {
  useFrame(({ camera, clock }) => {
    if (!enabled) return
    // A 6-degree drift over 20 seconds: enough to feel alive, not enough to
    // make anyone reach for the mouse.
    const angle = Math.sin(clock.elapsedTime * 0.31) * 0.052
    const radius = 34
    camera.position.x = Math.sin(angle) * radius
    camera.position.z = Math.cos(angle) * radius
    camera.lookAt(0, 2.5, 0)
  })
  return null
}

function Scene({ animate }: { animate: boolean }) {
  return (
    <>
      <color attach="background" args={['#060B18']} />
      <fog attach="fog" args={['#060B18', 26, 66]} />
      <ambientLight intensity={0.5} />
      <directionalLight position={[8, 14, 6]} intensity={0.7} />

      <Blocks />
      <Roads />
      {animate && <Traffic />}

      <PulseRing position={[-6.3, 0.05, 2.1]} delay={0} />
      <PulseRing position={[6.3, 0.05, -6.3]} delay={0.9} />
      <PulseRing position={[2.1, 0.05, 10.5]} delay={1.6} />

      <DriftingCamera enabled={animate} />

      {animate && (
        <EffectComposer>
          <Bloom intensity={0.6} luminanceThreshold={0.35} mipmapBlur />
        </EffectComposer>
      )}
    </>
  )
}

export function Landing() {
  const navigate = useNavigate()
  const { data: kpis } = useKpis()
  const [failed, setFailed] = useState(false)
  const reduced = prefersReducedMotion()

  return (
    <div className="relative h-screen w-full overflow-hidden bg-void">
      {!failed && (
        <Canvas
          camera={{ position: [0, 15, 34], fov: 42 }}
          className="absolute inset-0"
          onError={() => setFailed(true)}
          frameloop={reduced ? 'demand' : 'always'}
        >
          <Scene animate={!reduced} />
        </Canvas>
      )}

      <div className="pointer-events-none absolute inset-0 flex flex-col justify-end bg-gradient-to-t from-void via-void/40 to-transparent p-10">
        <div className="pointer-events-auto flex max-w-2xl flex-col items-start gap-5">
          <span className="eyebrow text-accent">
            Chandigarh University · Gharuan
          </span>

          <h1 className="text-display">Predict before it breaks.</h1>

          <p className="max-w-xl text-body text-text-2">
            Every phone that drives a road is a sensor. InfraPulse turns those
            bumps into a condition score for every 50 metres of the network,
            forecasts which stretches fail next, and ranks the repairs that
            remove the most risk per rupee.
          </p>

          <Button size="lg" onClick={() => navigate('/command')}>
            Enter Command Center
          </Button>

          <div className="mt-4 flex flex-wrap gap-8">
            <div className="flex flex-col">
              <span className="eyebrow">Segments monitored</span>
              <CountUp
                value={
                  (kpis?.criticalCount ?? 0) +
                  (kpis?.watchCount ?? 0) +
                  (kpis?.goodCount ?? 0)
                }
                className="text-metric-md"
              />
            </div>
            <div className="flex flex-col">
              <span className="eyebrow">Bumps logged today</span>
              <CountUp
                value={kpis?.bumpsToday ?? 0}
                className="text-metric-md"
              />
            </div>
            <div className="flex flex-col">
              <span className="eyebrow">At risk</span>
              <CountUp
                value={kpis?.costExposureInr ?? 0}
                format={formatInr}
                className="text-metric-md"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

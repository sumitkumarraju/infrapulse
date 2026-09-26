import { Canvas, useFrame } from '@react-three/fiber'
import { useMemo, useRef, useState } from 'react'
import seedrandom from 'seedrandom'
import * as THREE from 'three'
import { scoreColor } from '@/lib/health'

/* A 50m stretch of road as geometry: the worse the score, the more the surface
 * is chewed up. Deterministic per segment id, so the same road always shows the
 * same damage. */

function Surface({ segmentId, score }: { segmentId: number; score: number }) {
  const mesh = useRef<THREE.Mesh>(null)

  const geometry = useMemo(() => {
    const geo = new THREE.PlaneGeometry(6, 2.4, 120, 48)
    const rng = seedrandom(`infrapulse-demo:tile:${segmentId}`)
    const position = geo.attributes.position as THREE.BufferAttribute
    const damage = 1 - score / 100

    // Potholes: a handful of gaussian dents, more and deeper as score drops.
    const holes = Array.from({ length: Math.round(damage * 9) }, () => ({
      x: (rng() - 0.5) * 5.6,
      y: (rng() - 0.5) * 2.1,
      r: 0.18 + rng() * 0.42,
      d: (0.08 + rng() * 0.3) * damage,
    }))

    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i)
      const y = position.getY(i)
      // Background roughness, always present, scaled by wear.
      let z = (rng() - 0.5) * 0.02 * (0.3 + damage * 2.5)

      for (const hole of holes) {
        const dist = Math.hypot(x - hole.x, y - hole.y)
        z -= hole.d * Math.exp(-(dist * dist) / (2 * hole.r * hole.r))
      }
      position.setZ(i, z)
    }

    geo.computeVertexNormals()
    return geo
  }, [segmentId, score])

  useFrame((_, delta) => {
    if (mesh.current) mesh.current.rotation.z += delta * 0.08
  })

  return (
    <mesh
      ref={mesh}
      geometry={geometry}
      rotation={[-Math.PI / 2.35, 0, 0]}
      castShadow
      receiveShadow
    >
      <meshStandardMaterial
        color="#3C4149"
        roughness={0.95}
        metalness={0.05}
        emissive={scoreColor(score)}
        emissiveIntensity={0.06}
      />
    </mesh>
  )
}

export function RoadTile3D({
  segmentId,
  score,
}: {
  segmentId: number
  score: number
}) {
  const [failed, setFailed] = useState(false)
  const [spinning, setSpinning] = useState(true)

  if (failed) {
    // Lite fallback: never a blank rectangle where a visual should be.
    return (
      <div
        className="flex h-[200px] items-center justify-center rounded-card border border-hairline bg-surface-2 text-sm text-text-2"
        role="img"
        aria-label="3D road preview unavailable on this device"
      >
        3D preview unavailable on this device
      </div>
    )
  }

  return (
    <div
      className="h-[200px] overflow-hidden rounded-card border border-hairline bg-void"
      role="img"
      aria-label={`3D preview of the road surface, condition score ${Math.round(score)}`}
      onClick={() => setSpinning((s) => !s)}
      title={spinning ? 'Tap to stop rotating' : 'Tap to rotate'}
    >
      <Canvas
        camera={{ position: [0, 3.1, 3.4], fov: 42 }}
        onCreated={({ gl }) => gl.setClearColor('#060B18')}
        fallback={null}
        onError={() => setFailed(true)}
        frameloop={spinning ? 'always' : 'demand'}
      >
        <ambientLight intensity={0.35} />
        <directionalLight position={[4, 6, 3]} intensity={1.6} />
        <pointLight
          position={[-3, 2, -2]}
          intensity={18}
          color={scoreColor(score)}
        />
        <Surface segmentId={segmentId} score={score} />
      </Canvas>
    </div>
  )
}

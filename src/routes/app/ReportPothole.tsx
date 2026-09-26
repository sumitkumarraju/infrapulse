import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useState } from 'react'
import seedrandom from 'seedrandom'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import type { PhotoSeverity } from '@/data/types'
import { useDemoStore } from '@/store/demoStore'

type Stage = 'capture' | 'scanning' | 'detected' | 'submitted'

const SEVERITIES: { value: PhotoSeverity; label: string }[] = [
  { value: 'minor', label: 'Minor' },
  { value: 'moderate', label: 'Moderate' },
  { value: 'severe', label: 'Severe' },
]

/* The citizen report flow. The "camera" is one of the generated road images —
 * a real getUserMedia stream would ask for a permission the demo cannot grant
 * on a laptop, and the point of this screen is the review step, not the lens. */
export function ReportPothole() {
  const [stage, setStage] = useState<Stage>('capture')
  const [severity, setSeverity] = useState<PhotoSeverity>('moderate')
  const [shot, setShot] = useState(1)
  const countBump = useDemoStore((s) => s.countBump)

  const rng = seedrandom(`infrapulse-demo:report:${shot}`)
  const box = {
    x: 0.18 + rng() * 0.3,
    y: 0.24 + rng() * 0.3,
    w: 0.22 + rng() * 0.2,
    h: 0.18 + rng() * 0.16,
  }
  const confidence = Math.round((0.72 + rng() * 0.26) * 100) / 100

  useEffect(() => {
    if (stage !== 'scanning') return
    const id = setTimeout(() => setStage('detected'), 1200)
    return () => clearTimeout(id)
  }, [stage])

  if (stage === 'submitted') {
    return (
      <div className="flex min-h-[calc(100vh-5rem)] flex-col items-center justify-center gap-5 px-8 text-center">
        <span className="bg-health-good/15 text-h2 text-health-good flex size-16 items-center justify-center rounded-full">
          ✓
        </span>
        <h1 className="text-h2">Thank you</h1>
        <p className="text-text-2 max-w-sm text-sm">
          Your report is queued for review by the works engineer. Approved
          reports lower the condition score for that stretch of road
          immediately.
        </p>
        <Button
          onClick={() => {
            setShot((s) => s + 1)
            setStage('capture')
          }}
        >
          Report another
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5 p-5">
      <div className="flex flex-col gap-1">
        <span className="eyebrow text-accent">Report</span>
        <h1 className="text-h2">Photograph the damage</h1>
      </div>

      <div className="rounded-card border-hairline bg-surface-3 relative overflow-hidden border">
        <img
          src={`/mock-photos/road-${(shot % 8) + 1}.svg`}
          alt="Road surface in the camera view"
          className="aspect-[4/3] w-full object-cover"
        />

        {stage === 'scanning' && (
          <motion.div
            initial={{ y: '-10%' }}
            animate={{ y: '110%' }}
            transition={{ duration: 1.2, ease: 'linear' }}
            className="bg-accent absolute inset-x-0 h-1 shadow-[0_0_24px_var(--color-accent)]"
          />
        )}

        <AnimatePresence>
          {stage === 'detected' && (
            <motion.div
              initial={{ opacity: 0, scale: 1.15 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
              className="border-accent absolute border-2"
              style={{
                left: `${box.x * 100}%`,
                top: `${box.y * 100}%`,
                width: `${box.w * 100}%`,
                height: `${box.h * 100}%`,
              }}
            >
              <span className="metric rounded-chip bg-accent text-metric-sm absolute -top-6 left-0 px-1.5 whitespace-nowrap text-white">
                pothole {confidence.toFixed(2)}
              </span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {stage === 'capture' && (
        <Button size="lg" onClick={() => setStage('scanning')}>
          Capture
        </Button>
      )}

      {stage === 'scanning' && (
        <p className="text-text-2 text-sm">Scanning the surface…</p>
      )}

      {stage === 'detected' && (
        <>
          <div className="flex flex-col gap-2">
            <span className="eyebrow">How bad is it?</span>
            <div className="flex gap-2">
              {SEVERITIES.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setSeverity(option.value)}
                  className={`rounded-control min-h-[48px] flex-1 border text-sm ${
                    severity === option.value
                      ? 'border-accent bg-accent-wash text-accent'
                      : 'border-hairline text-text-2'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="accent">pothole</Badge>
            <Badge mono>{confidence.toFixed(2)} confidence</Badge>
          </div>

          <Button
            size="lg"
            onClick={() => {
              countBump()
              setStage('submitted')
            }}
          >
            Submit report
          </Button>
        </>
      )}
    </div>
  )
}

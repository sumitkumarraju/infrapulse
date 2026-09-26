import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useState } from 'react'
import seedrandom from 'seedrandom'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import type { PhotoSeverity } from '@/data/types'
import { useCamera } from '@/features/driver/useCamera'
import { useDemoStore } from '@/store/demoStore'

type Stage = 'capture' | 'scanning' | 'detected' | 'submitted'

const SEVERITIES: { value: PhotoSeverity; label: string }[] = [
  { value: 'minor', label: 'Minor' },
  { value: 'moderate', label: 'Moderate' },
  { value: 'severe', label: 'Severe' },
]

/* Reporting a pothole you are standing next to.
 *
 * The camera is real: getUserMedia, rear lens, downscaled JPEG. Where it is
 * unavailable — no secure context, no camera, permission declined — the screen
 * falls back to one of the generated road images and says which it is using,
 * because a demo that silently substitutes a stock photo for the thing it
 * claims to have photographed is lying about its own capability.
 *
 * The detection box is not. It is drawn over the middle of the frame with a
 * plausible confidence, and the review screen labels these reports as needing
 * an engineer's approval before they affect anything.
 */
export function ReportPothole() {
  const [stage, setStage] = useState<Stage>('capture')
  const [severity, setSeverity] = useState<PhotoSeverity>('moderate')
  const [shot, setShot] = useState(1)
  const [photo, setPhoto] = useState<string | null>(null)
  const countBump = useDemoStore((s) => s.countBump)
  const camera = useCamera()

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

  /** The live frame if there is one, otherwise a generated road surface. */
  const fallbackImage = `/mock-photos/road-${(shot % 8) + 1}.svg`

  function takeShot() {
    if (camera.state === 'live') {
      const frame = camera.capture()
      if (frame) {
        setPhoto(frame)
        camera.stop()
        setStage('scanning')
        return
      }
    }
    setPhoto(null)
    setStage('scanning')
  }

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
            setPhoto(null)
            setStage('capture')
          }}
        >
          Report another
        </Button>
      </div>
    )
  }

  const showingLiveCamera = stage === 'capture' && camera.state === 'live'

  return (
    <div className="flex flex-col gap-5 p-5">
      <div className="flex flex-col gap-1">
        <span className="eyebrow text-accent">Report</span>
        <h1 className="text-h2">Photograph the damage</h1>
      </div>

      <div className="rounded-card border-hairline bg-surface-3 relative overflow-hidden border">
        {/* Kept mounted rather than conditionally rendered: the stream is
            attached to this element, and remounting it drops the feed. */}
        <video
          ref={camera.videoRef}
          playsInline
          muted
          className={
            showingLiveCamera ? 'aspect-[4/3] w-full object-cover' : 'hidden'
          }
        />

        {!showingLiveCamera && (
          <img
            src={photo ?? fallbackImage}
            alt={
              photo
                ? 'The photograph you just took'
                : 'A sample road surface, used because no camera is available'
            }
            className="aspect-[4/3] w-full object-cover"
          />
        )}

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
              <span className="metric bg-accent text-metric-sm rounded-chip absolute -top-6 left-0 px-1.5 whitespace-nowrap text-white">
                pothole {confidence.toFixed(2)}
              </span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {stage === 'capture' && (
        <>
          {camera.state === 'live' ? (
            <div className="flex flex-col gap-2">
              <Button size="lg" className="w-full" onClick={takeShot}>
                Capture
              </Button>
              <Button variant="ghost" onClick={camera.stop}>
                Turn the camera off
              </Button>
            </div>
          ) : (
            <div className="border-hairline bg-surface-1 rounded-card flex flex-col gap-3 border p-4">
              <p className="text-text-2 text-sm">
                {camera.state === 'denied'
                  ? 'Camera access was declined. You can still submit using a sample image, or allow the camera and try again.'
                  : camera.error
                    ? camera.error
                    : 'Use the camera to photograph the damage, or submit a sample image to see the flow.'}
              </p>
              <Button
                size="lg"
                className="w-full"
                onClick={() => void camera.start()}
                disabled={camera.state === 'starting'}
              >
                {camera.state === 'starting'
                  ? 'Starting camera…'
                  : 'Open camera'}
              </Button>
              <Button variant="secondary" className="w-full" onClick={takeShot}>
                Use a sample image instead
              </Button>
            </div>
          )}
        </>
      )}

      {stage === 'scanning' && (
        <p className="text-text-2 text-sm">Scanning the surface…</p>
      )}

      {stage === 'detected' && (
        <>
          {!photo && (
            <p className="text-health-watch text-xs">
              This is a sample image, not a photograph you took.
            </p>
          )}

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
            className="w-full"
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

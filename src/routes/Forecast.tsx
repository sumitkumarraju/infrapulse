import { useEffect, useMemo, useRef, useState } from 'react'
import { CityMap } from '@/components/map/CityMap'
import { GlassPanel } from '@/components/glass/GlassPanel'
import { Button } from '@/components/ui/Button'
import { CountUp, formatInr } from '@/components/data-viz/Metric'
import { useProjectedScores, useSegmentsWithStatus } from '@/data/hooks'
import { useDemoStore } from '@/store/demoStore'
import { scoreColor } from '@/lib/health'

const MAX_DAYS = 90
/** Slider steps of 5 days keep the projection queries cheap and the motion smooth. */
const STEP = 5

function monthOf(offset: number) {
  const date = new Date(Date.now() + offset * 86_400_000)
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}

/** Jul–Sep, when decay doubles — marked on the track so the cliff is legible. */
function isMonsoonOffset(offset: number) {
  const month = new Date(Date.now() + offset * 86_400_000).getMonth()
  return month >= 6 && month <= 8
}

export function Forecast() {
  const { data: segments } = useSegmentsWithStatus()
  const [offset, setOffset] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [followPlan, setFollowPlan] = useState(false)
  const budgetPlan = useDemoStore((s) => s.budgetPlan)
  const planned = useMemo(() => new Set(budgetPlan), [budgetPlan])

  // Debounced so dragging the slider does not thrash the projection query.
  const [debounced, setDebounced] = useState(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setDebounced(offset), 150)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [offset])

  const { data: projected } = useProjectedScores(debounced)

  useEffect(() => {
    if (!playing) return
    const id = setInterval(() => {
      setOffset((current) => {
        if (current >= MAX_DAYS) {
          setPlaying(false)
          return MAX_DAYS
        }
        return Math.min(MAX_DAYS, current + 2)
      })
    }, 90)
    return () => clearInterval(id)
  }, [playing])

  /* Two futures: leave it alone, or repair everything in the budget plan. */
  const scores = useMemo(() => {
    if (!projected) return null
    if (!followPlan) return projected
    const withPlan = new Map(projected)
    for (const id of planned) withPlan.set(id, 95)
    return withPlan
  }, [projected, followPlan, planned])

  const stats = useMemo(() => {
    if (!projected || segments.length === 0) {
      return { doNothing: 0, withPlan: 0, exposure: 0, exposureWithPlan: 0 }
    }

    let doNothing = 0
    let withPlan = 0
    let exposure = 0
    let exposureWithPlan = 0

    for (const segment of segments) {
      const score = projected.get(segment.id) ?? segment.status.score
      const repaired = planned.has(segment.id)

      if (score < 40) {
        doNothing += 1
        exposure += segment.status.estimatedCostInr
        if (!repaired) {
          withPlan += 1
          exposureWithPlan += segment.status.estimatedCostInr
        }
      }
    }

    return { doNothing, withPlan, exposure, exposureWithPlan }
  }, [projected, segments, planned])

  return (
    <div className="relative h-[calc(100vh-3.5rem)] w-full overflow-hidden">
      <CityMap segments={segments} scoreOverride={scores} />

      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-center gap-4 p-4">
        <GlassPanel
          className="pointer-events-auto flex w-full max-w-4xl flex-col gap-4 p-5"
          aria-label="Time machine"
          static
        >
          <div className="flex flex-wrap items-center gap-6">
            <div className="flex flex-col">
              <span className="eyebrow">Projection</span>
              <span className="metric text-metric-lg">
                {offset === 0 ? 'Today' : `+${offset}d`}
              </span>
              <span className="metric text-metric-sm text-text-2">
                {monthOf(offset)}
              </span>
            </div>

            <Button
              size="lg"
              onClick={() => {
                if (offset >= MAX_DAYS) setOffset(0)
                setPlaying((p) => !p)
              }}
            >
              {playing ? 'Pause' : 'Play 90 days'}
            </Button>

            <Button
              variant={followPlan ? 'primary' : 'secondary'}
              onClick={() => setFollowPlan((v) => !v)}
              disabled={planned.size === 0}
              title={
                planned.size === 0
                  ? 'Add segments to the budget plan first'
                  : undefined
              }
            >
              Follow the plan ({planned.size})
            </Button>

            <div className="ml-auto flex gap-8">
              <div className="flex flex-col">
                <span className="eyebrow">Do nothing</span>
                <CountUp
                  value={stats.doNothing}
                  className="text-metric-md text-health-critical"
                />
                <span className="metric text-metric-sm text-text-2">
                  {formatInr(stats.exposure)}
                </span>
              </div>
              <div className="flex flex-col">
                <span className="eyebrow">Do the plan</span>
                <CountUp
                  value={stats.withPlan}
                  className="text-metric-md"
                  style={{ color: scoreColor(80) }}
                />
                <span className="metric text-metric-sm text-text-2">
                  {formatInr(stats.exposureWithPlan)}
                </span>
              </div>
            </div>
          </div>

          <div className="relative">
            {/* Monsoon band: the reason the curve bends (UI_DESIGN 5.4). */}
            <div className="pointer-events-none absolute inset-x-0 top-1/2 flex h-2 -translate-y-1/2 overflow-hidden rounded-full">
              {Array.from({ length: MAX_DAYS / STEP + 1 }, (_, i) => (
                <div
                  key={i}
                  className="flex-1"
                  style={{
                    background: isMonsoonOffset(i * STEP)
                      ? 'rgba(251,191,36,0.18)'
                      : 'transparent',
                  }}
                />
              ))}
            </div>

            <input
              type="range"
              min={0}
              max={MAX_DAYS}
              step={1}
              value={offset}
              onChange={(e) => {
                setPlaying(false)
                setOffset(Number(e.target.value))
              }}
              aria-label="Days from today"
              className="relative w-full accent-[var(--color-accent)]"
            />

            <div className="mt-1 flex justify-between">
              {[0, 30, 60, 90].map((tick) => (
                <span key={tick} className="metric text-metric-sm text-text-3">
                  {tick === 0 ? 'Today' : `+${tick}d`}
                </span>
              ))}
            </div>
          </div>

          <p className="text-text-2 text-sm">
            Amber stretches of the track are the monsoon months, when
            deterioration runs two and a half times faster. Roads recolour and
            towers grow as the date moves.
          </p>
        </GlassPanel>
      </div>
    </div>
  )
}

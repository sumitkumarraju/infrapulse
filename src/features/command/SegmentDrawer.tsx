import { useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'motion/react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { GlassPanel } from '@/components/glass/GlassPanel'
import { RoadTile3D } from '@/components/three/RoadTile3D'
import { ScoreRing } from '@/components/data-viz/Score'
import { formatInrExact } from '@/components/data-viz/Metric'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { qk } from '@/data/DataSource'
import { dataSource } from '@/data'
import {
  useForecast,
  useSegmentHistory,
  type SegmentWithStatus,
} from '@/data/hooks'
import { CRITICAL_LINE } from '@/data/mock/generate'
import { drawerEnter, transitions } from '@/design/motion'
import { scoreColor } from '@/lib/health'
import { useDemoStore } from '@/store/demoStore'

function Waterfall({ segment }: { segment: SegmentWithStatus }) {
  const { breakdown, score } = segment.status
  const steps = [
    { label: 'Bump penalty', value: breakdown.bumpPenalty },
    { label: 'Roughness', value: breakdown.roughnessPenalty },
    { label: 'Photo reports', value: breakdown.photoPenalty },
  ].filter((s) => s.value > 0.05)

  const total = steps.reduce((a, s) => a + s.value, 0) || 1

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <span className="text-text-2 text-sm">Perfect road</span>
        <span className="metric text-metric-sm">100</span>
      </div>

      {steps.map((step) => (
        <div key={step.label} className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between">
            <span className="text-text-2 text-sm">{step.label}</span>
            <span className="metric text-metric-sm text-health-critical">
              −{step.value.toFixed(1)}
            </span>
          </div>
          <div className="bg-surface-3 h-1.5 overflow-hidden rounded-full">
            <div
              className="bg-health-critical/70 h-full rounded-full"
              style={{ width: `${(step.value / total) * 100}%` }}
            />
          </div>
        </div>
      ))}

      <div className="border-hairline mt-1 flex items-baseline justify-between border-t pt-2">
        <span className="text-sm">Today</span>
        <span
          className="metric text-metric-md"
          style={{ color: scoreColor(score) }}
        >
          {score.toFixed(1)}
        </span>
      </div>
    </div>
  )
}

function chartTooltip() {
  return {
    contentStyle: {
      background: 'var(--color-surface-1)',
      border: '1px solid var(--color-hairline-strong)',
      borderRadius: 'var(--radius-control)',
      fontSize: 12,
    },
    labelStyle: { color: 'var(--color-text-2)' },
    itemStyle: { color: 'var(--color-text-1)' },
  }
}

export function SegmentDrawer({
  segment,
  onClose,
}: {
  segment: SegmentWithStatus | null
  onClose: () => void
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const setBudget = useDemoStore((s) => s.setBudget)
  const budgetInr = useDemoStore((s) => s.budgetInr)
  const budgetPlan = useDemoStore((s) => s.budgetPlan)

  const { data: history } = useSegmentHistory(segment?.id ?? null)
  const { data: forecast } = useForecast(segment?.id ?? null)

  const historyData = (history ?? []).map((d, i) => ({
    ...d,
    label: d.day.slice(5),
    index: i,
  }))

  const forecastData = (forecast ?? []).map((f) => ({
    ...f,
    label: `+${f.offset}d`,
    band: [f.lower, f.upper] as [number, number],
  }))

  async function createWorkOrder(id: number) {
    const created = await dataSource.createWorkOrders([id])
    await queryClient.invalidateQueries({ queryKey: qk.workOrders })
    await queryClient.invalidateQueries({ queryKey: qk.kpis })

    if (created.length === 0) {
      toast('This segment already has an open work order.')
      return
    }
    toast.success(`${created[0].id} created`, {
      description: created[0].segmentName,
      action: { label: 'Open board', onClick: () => navigate('/work-orders') },
    })
  }

  return (
    <AnimatePresence>
      {segment && (
        <motion.div
          key={segment.id}
          variants={drawerEnter}
          initial="hidden"
          animate="visible"
          exit="exit"
          transition={transitions.panelEnter()}
          className="pointer-events-auto absolute top-0 right-0 bottom-0 z-30 w-[520px] max-w-[92vw] p-4"
        >
          <GlassPanel
            as="section"
            className="bg-surface-1/92 flex h-full flex-col overflow-y-auto p-5"
            aria-label={`Segment ${segment.name}`}
            static
          >
            <div className="flex items-start justify-between gap-4">
              <div className="flex min-w-0 flex-col gap-2">
                <h2 className="text-h2 truncate">{segment.name}</h2>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge>{segment.roadClass}</Badge>
                  {segment.nearSensitive && (
                    <Badge tone="accent">near school / hospital</Badge>
                  )}
                  <Badge mono>SEG-{String(segment.id).padStart(4, '0')}</Badge>
                  <span className="metric text-metric-sm text-text-2">
                    {segment.lengthM.toFixed(0)} m
                  </span>
                </div>
              </div>

              <Button
                variant="ghost"
                size="icon"
                aria-label="Close segment details"
                onClick={onClose}
              >
                ✕
              </Button>
            </div>

            <div className="mt-4">
              <RoadTile3D segmentId={segment.id} score={segment.status.score} />
            </div>

            <div className="mt-5 flex items-center gap-6">
              <ScoreRing score={segment.status.score} />
              <div className="flex-1">
                <h3 className="eyebrow mb-3">Why this score</h3>
                <Waterfall segment={segment} />
              </div>
            </div>

            <h3 className="eyebrow mt-6 mb-2">
              180-day history
              <span className="text-text-3 ml-2 normal-case">simulated</span>
            </h3>
            <div className="h-40 shrink-0">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={historyData}>
                  <CartesianGrid
                    stroke="var(--color-hairline)"
                    vertical={false}
                  />
                  <XAxis
                    dataKey="label"
                    tick={{ fill: 'var(--color-text-3)', fontSize: 10 }}
                    interval={44}
                    stroke="var(--color-hairline)"
                  />
                  <YAxis
                    domain={[0, 100]}
                    tick={{ fill: 'var(--color-text-3)', fontSize: 10 }}
                    width={28}
                    stroke="var(--color-hairline)"
                  />
                  <Tooltip {...chartTooltip()} />
                  <ReferenceLine
                    y={CRITICAL_LINE}
                    stroke="var(--color-health-critical)"
                    strokeDasharray="4 4"
                  />
                  <Line
                    type="monotone"
                    dataKey="score"
                    stroke={scoreColor(segment.status.score)}
                    strokeWidth={2}
                    strokeDasharray="5 3"
                    dot={false}
                    isAnimationActive={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <p className="sr-only">
              Condition fell from {historyData[0]?.score ?? 0} to{' '}
              {segment.status.score} over 180 days.
            </p>

            <h3 className="eyebrow mt-6 mb-2">90-day forecast</h3>
            <div className="h-40 shrink-0">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={forecastData}>
                  <CartesianGrid
                    stroke="var(--color-hairline)"
                    vertical={false}
                  />
                  <XAxis
                    dataKey="label"
                    tick={{ fill: 'var(--color-text-3)', fontSize: 10 }}
                    interval={22}
                    stroke="var(--color-hairline)"
                  />
                  <YAxis
                    domain={[0, 100]}
                    tick={{ fill: 'var(--color-text-3)', fontSize: 10 }}
                    width={28}
                    stroke="var(--color-hairline)"
                  />
                  <Tooltip {...chartTooltip()} />
                  <ReferenceLine
                    y={CRITICAL_LINE}
                    stroke="var(--color-health-critical)"
                    strokeDasharray="4 4"
                    label={{
                      value: 'failed',
                      fill: 'var(--color-health-critical)',
                      fontSize: 10,
                      position: 'insideBottomRight',
                    }}
                  />
                  <Area
                    type="monotone"
                    dataKey="band"
                    stroke="none"
                    fill="var(--color-accent)"
                    fillOpacity={0.14}
                    isAnimationActive={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="value"
                    stroke="var(--color-accent)"
                    strokeWidth={2}
                    dot={false}
                    isAnimationActive={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            <div className="mt-5 grid grid-cols-3 gap-3">
              {(
                [
                  ['30 days', segment.status.risk30],
                  ['60 days', segment.status.risk60],
                  ['90 days', segment.status.risk90],
                ] as const
              ).map(([label, risk]) => (
                <div
                  key={label}
                  className="rounded-card border-hairline bg-surface-1/70 flex flex-col gap-1 border p-3"
                >
                  <span className="eyebrow">{label}</span>
                  <span
                    className="metric text-metric-md"
                    style={{ color: scoreColor(100 - risk * 100) }}
                  >
                    {Math.round(risk * 100)}%
                  </span>
                  <span className="text-text-3 text-xs">chance of failing</span>
                </div>
              ))}
            </div>

            <div className="rounded-card border-hairline bg-surface-1/70 mt-5 flex items-baseline justify-between border p-3">
              <span className="text-text-2 text-sm">
                Estimated {segment.status.repairType}
              </span>
              <span className="metric text-metric-md">
                {formatInrExact(segment.status.estimatedCostInr)}
              </span>
            </div>

            <div className="mt-5 flex flex-wrap gap-2 pb-2">
              <Button onClick={() => void createWorkOrder(segment.id)}>
                Create work order
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  const next = budgetPlan.includes(segment.id)
                    ? budgetPlan
                    : [...budgetPlan, segment.id]
                  setBudget(budgetInr, next)
                  toast('Added to the budget plan')
                }}
              >
                Add to budget plan
              </Button>
              <Button
                variant="ghost"
                onClick={() => toast('Marked inspected today')}
              >
                Mark inspected
              </Button>
            </div>
          </GlassPanel>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

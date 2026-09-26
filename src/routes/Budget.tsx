import { useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import {
  Area,
  AreaChart,
  ReferenceDot,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts'
import { CityMap } from '@/components/map/CityMap'
import { CountUp, formatInr } from '@/components/data-viz/Metric'
import { ScoreBadge } from '@/components/data-viz/Score'
import { Button } from '@/components/ui/Button'
import { qk } from '@/data/DataSource'
import { dataSource } from '@/data'
import { useSegmentsWithStatus } from '@/data/hooks'
import { greedyAllocate, type Candidate } from '@/lib/knapsack'
import { useDemoStore } from '@/store/demoStore'

const MAX_BUDGET = 5_00_00_000 // ₹5 crore

export function Budget() {
  const { data: segments } = useSegmentsWithStatus()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const budgetInr = useDemoStore((s) => s.budgetInr)
  const setBudget = useDemoStore((s) => s.setBudget)
  const [creating, setCreating] = useState(false)

  const candidates = useMemo<Candidate[]>(
    () =>
      segments.map((segment) => ({
        id: segment.id,
        // Value is risk actually removed, weighted by who the road serves.
        value: segment.status.priority,
        costInr: segment.status.estimatedCostInr,
      })),
    [segments],
  )

  const allocation = useMemo(
    () => greedyAllocate(candidates, budgetInr),
    [candidates, budgetInr],
  )

  const fundedIds = useMemo(
    () => new Set(allocation.chosen),
    [allocation.chosen],
  )

  const totalRisk = useMemo(
    () => candidates.reduce((a, c) => a + c.value, 0),
    [candidates],
  )

  const riskRemovedPct =
    totalRisk === 0 ? 0 : (allocation.totalValue / totalRisk) * 100

  /* The curve: how much risk each budget level buys. Twenty points is enough
     to show the knee, and it recomputes instantly as the slider moves. */
  const curve = useMemo(() => {
    const points: { spend: number; removed: number }[] = []
    for (let i = 0; i <= 20; i++) {
      const spend = (MAX_BUDGET / 20) * i
      const result = greedyAllocate(candidates, spend)
      points.push({
        spend,
        removed: totalRisk === 0 ? 0 : (result.totalValue / totalRisk) * 100,
      })
    }
    return points
  }, [candidates, totalRisk])

  const funded = segments
    .filter((s) => fundedIds.has(s.id))
    .sort((a, b) => b.status.priority - a.status.priority)

  async function createAll() {
    setCreating(true)
    try {
      const created = await dataSource.createWorkOrders(allocation.chosen)
      await queryClient.invalidateQueries({ queryKey: qk.workOrders })
      await queryClient.invalidateQueries({ queryKey: qk.kpis })
      toast.success(`${created.length} work orders created`, {
        description:
          created.length < allocation.chosen.length
            ? `${allocation.chosen.length - created.length} segments already had one open`
            : undefined,
        action: {
          label: 'Open board',
          onClick: () => navigate('/work-orders'),
        },
      })
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="flex h-[calc(100vh-3.5rem)] w-full">
      <div className="border-hairline bg-surface-1 flex w-[420px] shrink-0 flex-col gap-5 overflow-y-auto border-r p-5">
        <div className="flex flex-col gap-2">
          <h1 className="text-h2">Budget planner</h1>
          <p className="text-text-2 text-sm">
            Spend the money where it removes the most risk. Segments are ranked
            by risk removed per rupee, weighted for road class, bus routes and
            proximity to schools and hospitals.
          </p>
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between">
            <span className="eyebrow">Budget</span>
            <span className="metric text-metric-lg">
              {formatInr(budgetInr)}
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={MAX_BUDGET}
            step={5_00_000}
            value={budgetInr}
            onChange={(e) =>
              setBudget(Number(e.target.value), allocation.chosen)
            }
            aria-label="Budget in rupees"
            className="w-full accent-[var(--color-accent)]"
          />
          <div className="flex justify-between">
            <span className="metric text-metric-sm text-text-3">₹0</span>
            <span className="metric text-metric-sm text-text-3">₹5 cr</span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-card border-hairline bg-surface-2 flex flex-col gap-1 border p-3">
            <span className="eyebrow">Segments funded</span>
            <CountUp
              value={allocation.chosen.length}
              className="text-metric-lg text-accent"
            />
          </div>
          <div className="rounded-card border-hairline bg-surface-2 flex flex-col gap-1 border p-3">
            <span className="eyebrow">City risk removed</span>
            <CountUp
              value={riskRemovedPct}
              decimals={1}
              format={(v) => `${v.toFixed(1)}%`}
              className="text-metric-lg"
            />
          </div>
        </div>

        <div className="h-32 shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={curve}>
              <XAxis
                dataKey="spend"
                tickFormatter={(v: number) =>
                  `${(v / 1_00_00_000).toFixed(0)}cr`
                }
                tick={{ fill: 'var(--color-text-3)', fontSize: 10 }}
                stroke="var(--color-hairline)"
              />
              <YAxis
                tickFormatter={(v: number) => `${v.toFixed(0)}%`}
                tick={{ fill: 'var(--color-text-3)', fontSize: 10 }}
                width={32}
                stroke="var(--color-hairline)"
              />
              <Area
                type="monotone"
                dataKey="removed"
                stroke="var(--color-accent)"
                fill="var(--color-accent)"
                fillOpacity={0.15}
                strokeWidth={2}
                isAnimationActive={false}
              />
              <ReferenceDot
                x={budgetInr}
                y={riskRemovedPct}
                r={4}
                fill="var(--color-accent-bright)"
                stroke="var(--color-void)"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        <Button
          size="lg"
          disabled={allocation.chosen.length === 0 || creating}
          onClick={() => void createAll()}
        >
          Create {allocation.chosen.length} work orders
        </Button>

        <div className="flex flex-col">
          <span className="eyebrow mb-2">Funded, highest value first</span>
          <ul className="flex flex-col">
            {funded.slice(0, 60).map((segment, index) => (
              <li
                key={segment.id}
                className="border-hairline flex items-center gap-3 border-b py-2"
              >
                <span className="metric text-metric-sm text-text-3 w-6">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm">
                  {segment.name}
                </span>
                <span className="metric text-metric-sm text-text-2">
                  {formatInr(segment.status.estimatedCostInr)}
                </span>
                <ScoreBadge score={segment.status.score} />
              </li>
            ))}
            {funded.length === 0 && (
              <li className="text-text-2 py-6 text-sm">
                Nothing fits this budget yet. Drag the slider up.
              </li>
            )}
          </ul>
        </div>
      </div>

      <div className="relative flex-1">
        <CityMap segments={segments} fundedIds={fundedIds} />
      </div>
    </div>
  )
}

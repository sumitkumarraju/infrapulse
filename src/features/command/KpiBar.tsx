import { GlassPanel } from '@/components/glass/GlassPanel'
import { CountUp, Sparkline, formatInr } from '@/components/data-viz/Metric'
import { useKpis } from '@/data/hooks'
import { scoreColor } from '@/lib/health'
import { cn } from '@/lib/utils'

function Tile({
  label,
  children,
  className,
}: {
  label: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex min-w-[104px] shrink-0 flex-col justify-center gap-1 lg:min-w-0 lg:shrink',
        className,
      )}
    >
      <span className="eyebrow truncate">{label}</span>
      {children}
    </div>
  )
}

/** The five numbers an engineer checks first (UI_DESIGN 5.2). */
export function KpiBar() {
  const { data: kpis } = useKpis()

  if (!kpis) {
    return (
      <GlassPanel className="h-[72px] animate-pulse" static aria-hidden>
        <span className="sr-only">Loading city statistics</span>
      </GlassPanel>
    )
  }

  return (
    <GlassPanel
      as="header"
      /* Five tiles do not fit a phone. Rather than shrink them into
         illegibility, the bar scrolls sideways below `lg` and keeps each tile
         at a readable width. */
      className="flex h-[72px] items-center gap-6 overflow-x-auto px-6 lg:grid lg:grid-cols-[1.4fr_1fr_1fr_1.2fr_1fr_auto] lg:overflow-visible"
      aria-label="City statistics"
      static
    >
      <Tile label="City health index">
        <div className="flex items-center gap-3">
          <CountUp
            value={kpis.cityHealthIndex}
            decimals={1}
            className="text-metric-lg"
            style={{ color: scoreColor(kpis.cityHealthIndex) }}
          />
          <div className="w-20">
            <Sparkline
              values={kpis.healthTrend}
              stroke={scoreColor(kpis.cityHealthIndex)}
            />
          </div>
        </div>
      </Tile>

      <Tile label="Critical segments">
        <CountUp
          value={kpis.criticalCount}
          className="text-metric-lg text-health-critical"
        />
      </Tile>

      <Tile label="Bumps today">
        <CountUp value={kpis.bumpsToday} className="text-metric-lg" />
      </Tile>

      <Tile label="Cost exposure">
        <CountUp
          value={kpis.costExposureInr}
          className="text-metric-lg"
          format={formatInr}
        />
      </Tile>

      <Tile label="Open work orders">
        <CountUp value={kpis.openWorkOrders} className="text-metric-lg" />
      </Tile>

      <div className="flex items-center gap-2 pl-2">
        <span className="relative flex size-2">
          <span className="bg-accent absolute inline-flex size-2 animate-ping rounded-full opacity-75" />
          <span className="bg-accent relative inline-flex size-2 rounded-full" />
        </span>
        <span className="eyebrow text-accent">Live</span>
      </div>
    </GlassPanel>
  )
}

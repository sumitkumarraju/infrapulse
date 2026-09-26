import { GlassPanel } from '@/components/glass/GlassPanel'
import { RiskBar, ScoreBadge } from '@/components/data-viz/Score'
import { formatInr } from '@/components/data-viz/Metric'
import type { SegmentWithStatus } from '@/data/hooks'
import { cn } from '@/lib/utils'

/**
 * "Fix these first" — the answer to the ten-second test. Ranked by priority,
 * which already folds in risk, road class, schools and hospitals.
 *
 * It is a real focusable list, so the map is never the only way to reach a
 * segment (UI_DESIGN 7).
 */
export function PriorityQueue({
  segments,
  selectedId,
  onSelect,
  onHover,
  limit = 40,
}: {
  segments: SegmentWithStatus[]
  selectedId: number | null
  onSelect: (id: number) => void
  onHover: (id: number | null) => void
  limit?: number
}) {
  const ranked = [...segments]
    .sort((a, b) => b.status.priority - a.status.priority)
    .slice(0, limit)

  return (
    <GlassPanel
      as="aside"
      className="flex h-full w-[360px] flex-col overflow-hidden"
      aria-label="Fix these first"
      static
    >
      <div className="flex items-baseline justify-between px-4 pt-4 pb-3">
        <h2 className="eyebrow">Fix these first</h2>
        <span className="metric text-metric-sm text-text-2">
          {ranked.length} of {segments.length}
        </span>
      </div>

      <ul
        className="flex-1 overflow-y-auto pb-2"
        onMouseLeave={() => onHover(null)}
      >
        {ranked.map((segment, index) => (
          <li key={segment.id}>
            <button
              type="button"
              onClick={() => onSelect(segment.id)}
              onMouseEnter={() => onHover(segment.id)}
              onFocus={() => onHover(segment.id)}
              className={cn(
                'flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors duration-[120ms]',
                'hover:bg-surface-2/60',
                selectedId === segment.id && 'bg-accent-wash',
              )}
            >
              <span className="metric text-metric-sm text-text-3 w-6 shrink-0">
                {String(index + 1).padStart(2, '0')}
              </span>

              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex items-baseline gap-2">
                  <span className="text-text-1 truncate text-sm">
                    {segment.name}
                  </span>
                  {segment.nearSensitive && (
                    <span
                      className="eyebrow text-accent shrink-0"
                      title="Within 300m of a school or hospital"
                    >
                      School
                    </span>
                  )}
                </span>
                <RiskBar risk={segment.status.risk30} />
                <span className="metric text-metric-sm text-text-2">
                  SEG-{String(segment.id).padStart(4, '0')} ·{' '}
                  {Math.round(segment.status.risk30 * 100)}% ·{' '}
                  {formatInr(segment.status.estimatedCostInr)}
                </span>
              </span>

              <ScoreBadge score={segment.status.score} />
            </button>
          </li>
        ))}
      </ul>
    </GlassPanel>
  )
}

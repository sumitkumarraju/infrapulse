import { CountUp } from '@/components/data-viz/Metric'
import { BAND_LABEL, scoreBand, scoreColor } from '@/lib/health'
import { cn } from '@/lib/utils'

/** Score as a chip. Critical carries a `!` so colour is not the only signal. */
export function ScoreBadge({
  score,
  className,
}: {
  score: number
  className?: string
}) {
  const band = scoreBand(score)
  const color = scoreColor(score)

  return (
    <span
      className={cn(
        'metric rounded-chip text-metric-sm inline-flex items-center gap-1 border px-1.5 py-0.5',
        className,
      )}
      style={{
        color,
        borderColor: `${color}59`,
        background: `${color}1A`,
      }}
      title={`${BAND_LABEL[band]} — score ${Math.round(score)}`}
    >
      {band === 'critical' && <span aria-hidden>!</span>}
      {Math.round(score)}
    </span>
  )
}

/** The drawer's headline: score on a ring, counting up on open. */
export function ScoreRing({
  score,
  size = 132,
}: {
  score: number
  size?: number
}) {
  const radius = size / 2 - 10
  const circumference = 2 * Math.PI * radius
  const color = scoreColor(score)
  const band = scoreBand(score)

  return (
    <div
      className="relative shrink-0"
      style={{ width: size, height: size }}
      role="img"
      aria-label={`Condition score ${Math.round(score)} out of 100, ${BAND_LABEL[band]}`}
    >
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--color-surface-3)"
          strokeWidth={8}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={8}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - score / 100)}
          style={{
            transition: 'stroke-dashoffset 900ms cubic-bezier(.16,1,.3,1)',
          }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <CountUp value={score} className="text-metric-lg" style={{ color }} />
        <span className="eyebrow mt-1" style={{ color }}>
          {BAND_LABEL[band]}
        </span>
      </div>
    </div>
  )
}

/** A thin risk bar — proportion, not precision. */
export function RiskBar({
  risk,
  className,
}: {
  risk: number
  className?: string
}) {
  const pct = Math.round(risk * 100)
  return (
    <div
      className={cn(
        'bg-surface-3 h-1.5 w-full overflow-hidden rounded-full',
        className,
      )}
      role="img"
      aria-label={`${pct}% chance of failing within 30 days`}
    >
      <div
        className="h-full rounded-full"
        style={{
          width: `${Math.max(2, pct)}%`,
          background: scoreColor(100 - pct),
        }}
      />
    </div>
  )
}

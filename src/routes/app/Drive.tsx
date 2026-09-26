import { useNavigate } from 'react-router'
import { CountUp } from '@/components/data-viz/Metric'
import { useDemoStore } from '@/store/demoStore'

/** One enormous button, dead centre, and the numbers it has produced so far. */
export function Drive() {
  const navigate = useNavigate()
  const liveBumps = useDemoStore((s) => s.liveBumps)

  return (
    <div className="flex min-h-[calc(100vh-5rem)] flex-col items-center justify-center gap-10 px-6">
      <div className="flex flex-col items-center gap-2 text-center">
        <span className="eyebrow text-accent">InfraPulse driver</span>
        <h1 className="text-h2">Every drive maps a road</h1>
        <p className="max-w-sm text-sm text-text-2">
          Mount the phone, start the trip, and drive normally. Bumps are
          detected on the device — nothing but the bump is recorded.
        </p>
      </div>

      <button
        type="button"
        onClick={() => navigate('/app/trip')}
        className="flex size-[200px] flex-col items-center justify-center gap-1 rounded-full bg-accent text-surface-1 shadow-[0_18px_50px_rgba(14,116,144,0.35)] transition-transform duration-[120ms] active:scale-95"
      >
        <span className="text-h2 text-white">Start Trip</span>
        <span className="text-xs tracking-[0.06em] text-white/80 uppercase">
          Tap to begin
        </span>
      </button>

      <div className="flex gap-10">
        <div className="flex flex-col items-center">
          <span className="eyebrow">Bumps logged</span>
          <CountUp value={liveBumps} className="text-metric-lg" />
        </div>
        <div className="flex flex-col items-center">
          <span className="eyebrow">Trips</span>
          <CountUp
            value={Math.max(1, Math.round(liveBumps / 12))}
            className="text-metric-lg"
          />
        </div>
      </div>
    </div>
  )
}

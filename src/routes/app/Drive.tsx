import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { CountUp } from '@/components/data-viz/Metric'
import { useDemoStore } from '@/store/demoStore'

/** One enormous button, dead centre, and the numbers it has produced so far. */
export function Drive() {
  const navigate = useNavigate()
  const liveBumps = useDemoStore((s) => s.liveBumps)
  const [localStats, setLocalStats] = useState({ potholes: 0, trips: 0 })

  useEffect(() => {
    try {
      const potholes = JSON.parse(
        localStorage.getItem('infrapulse-local-potholes') || '[]',
      )
      const trips = JSON.parse(
        localStorage.getItem('infrapulse-local-trips') || '[]',
      )
      setLocalStats({
        potholes: potholes.length,
        trips: trips.length,
      })
    } catch {
      // ignore
    }
  }, [])

  const bumpsCount = Math.max(liveBumps, localStats.potholes)
  const tripsCount = Math.max(localStats.trips, Math.round(bumpsCount / 12) || 1)

  return (
    <div className="flex min-h-[calc(100vh-5rem)] flex-col items-center justify-center gap-8 px-6 py-4">
      <div className="flex flex-col items-center gap-2 text-center">
        <span className="eyebrow text-accent">InfraPulse driver</span>
        <h1 className="text-h2">Every drive maps a road</h1>
        <p className="text-text-2 max-w-sm text-sm">
          Mount the phone, start the trip, and drive normally. Bumps are
          detected on the device — route and potholes are marked on the map.
        </p>
      </div>

      <button
        type="button"
        onClick={() => navigate('/app/trip')}
        className="bg-accent text-surface-1 flex size-[200px] flex-col items-center justify-center gap-1 rounded-full shadow-[0_18px_50px_rgba(14,116,144,0.35)] transition-transform duration-[120ms] active:scale-95"
      >
        <span className="text-h2 text-white">Start Trip</span>
        <span className="text-xs tracking-[0.06em] text-white/80 uppercase">
          Tap to begin
        </span>
      </button>

      <div className="flex flex-col items-center gap-4">
        <div className="flex gap-10">
          <div className="flex flex-col items-center">
            <span className="eyebrow">Bumps logged</span>
            <CountUp value={bumpsCount} className="text-metric-lg" />
          </div>
          <div className="flex flex-col items-center">
            <span className="eyebrow">Trips</span>
            <CountUp value={tripsCount} className="text-metric-lg" />
          </div>
        </div>

        {localStats.potholes > 0 && (
          <button
            type="button"
            onClick={() => navigate('/app/map')}
            className="text-xs font-semibold text-accent hover:underline flex items-center gap-1 mt-1"
          >
            <span>🗺️</span> View {localStats.potholes} mapped potholes →
          </button>
        )}
      </div>
    </div>
  )
}

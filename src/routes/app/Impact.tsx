import { CountUp } from '@/components/data-viz/Metric'
import { usePhotoReports } from '@/data/hooks'
import { useDemoStore } from '@/store/demoStore'
import { cn } from '@/lib/utils'

const BADGES = [
  { label: 'First report', threshold: 1 },
  { label: 'Ten potholes', threshold: 10 },
  { label: 'Road watcher', threshold: 40 },
  { label: 'Street cartographer', threshold: 120 },
]

export function Impact() {
  const liveBumps = useDemoStore((s) => s.liveBumps)
  const { data: reports = [] } = usePhotoReports()
  const mine = reports.slice(0, 6)

  return (
    <div className="flex flex-col gap-6 p-5">
      <div className="flex flex-col gap-1">
        <span className="eyebrow text-accent">Impact</span>
        <h1 className="text-h2">What your driving found</h1>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="flex flex-col gap-1 rounded-card border border-hairline bg-surface-1 p-3">
          <span className="eyebrow">Bumps</span>
          <CountUp value={liveBumps} className="text-metric-md" />
        </div>
        <div className="flex flex-col gap-1 rounded-card border border-hairline bg-surface-1 p-3">
          <span className="eyebrow">Reports</span>
          <CountUp value={mine.length} className="text-metric-md" />
        </div>
        <div className="flex flex-col gap-1 rounded-card border border-hairline bg-surface-1 p-3">
          <span className="eyebrow">Repaired</span>
          <CountUp
            value={mine.filter((r) => r.status === 'approved').length}
            className="text-metric-md text-health-good"
          />
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <span className="eyebrow">Your reports</span>
        <ol className="flex flex-col">
          {mine.map((report) => (
            <li key={report.id} className="flex gap-3 py-2">
              <span className="flex flex-col items-center">
                <span
                  className={cn(
                    'mt-1.5 size-2 shrink-0 rounded-full',
                    report.status === 'approved' && 'bg-health-good',
                    report.status === 'pending' && 'bg-health-watch',
                    report.status === 'rejected' && 'bg-text-3',
                  )}
                />
                <span className="w-px flex-1 bg-hairline" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm">{report.segmentName}</span>
                <span className="metric text-metric-sm text-text-2">
                  {new Date(report.createdAt).toLocaleDateString('en-IN')} ·{' '}
                  {report.status}
                </span>
              </span>
            </li>
          ))}
          {mine.length === 0 && (
            <li className="py-6 text-sm text-text-2">
              No reports yet. Photograph a pothole from the Report tab.
            </li>
          )}
        </ol>
      </div>

      <div className="flex flex-col gap-3">
        <span className="eyebrow">Badges</span>
        <div className="grid grid-cols-2 gap-3">
          {BADGES.map((badge) => {
            const earned = liveBumps >= badge.threshold
            return (
              <div
                key={badge.label}
                className={cn(
                  'flex flex-col gap-1 rounded-card border p-3',
                  earned
                    ? 'border-accent/40 bg-accent-wash'
                    : 'border-hairline bg-surface-1 opacity-60 grayscale',
                )}
              >
                <span
                  className={cn(
                    'text-sm',
                    earned ? 'text-accent' : 'text-text-2',
                  )}
                >
                  {badge.label}
                </span>
                <span className="metric text-metric-sm text-text-2">
                  {earned ? 'earned' : `${badge.threshold} bumps`}
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

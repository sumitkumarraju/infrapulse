import { useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'motion/react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { qk } from '@/data/DataSource'
import { dataSource } from '@/data'
import { usePhotoReports } from '@/data/hooks'
import type { PhotoReport, PhotoSeverity, PhotoStatus } from '@/data/types'
import { transitions } from '@/design/motion'
import { cn } from '@/lib/utils'

const SEVERITIES: PhotoSeverity[] = ['minor', 'moderate', 'severe']
const STATUSES: PhotoStatus[] = ['pending', 'approved', 'rejected']

const SEVERITY_TONE = {
  minor: 'good',
  moderate: 'watch',
  severe: 'critical',
} as const

/** The AI box, drawn over the photo at its normalised coordinates. */
function DetectionBox({
  report,
  showLabel = true,
}: {
  report: PhotoReport
  showLabel?: boolean
}) {
  return (
    <div
      className="border-accent pointer-events-none absolute border-2"
      style={{
        left: `${report.box.x * 100}%`,
        top: `${report.box.y * 100}%`,
        width: `${report.box.w * 100}%`,
        height: `${report.box.h * 100}%`,
      }}
    >
      {showLabel && (
        <span className="metric rounded-chip bg-accent text-metric-sm text-void absolute -top-5 left-0 px-1 whitespace-nowrap">
          {report.label} {report.confidence.toFixed(2)}
        </span>
      )}
    </div>
  )
}

export function Reports() {
  const { data: reports = [], isLoading } = usePhotoReports()
  const queryClient = useQueryClient()
  const [severity, setSeverity] = useState<PhotoSeverity | null>(null)
  const [status, setStatus] = useState<PhotoStatus | null>(null)
  const [minConfidence, setMinConfidence] = useState(0.6)
  const [lightbox, setLightbox] = useState<PhotoReport | null>(null)

  const filtered = useMemo(
    () =>
      reports.filter(
        (report) =>
          (severity === null || report.severity === severity) &&
          (status === null || report.status === status) &&
          report.confidence >= minConfidence,
      ),
    [reports, severity, status, minConfidence],
  )

  async function decide(id: string, next: PhotoStatus) {
    await dataSource.setPhotoStatus(id, next)
    await queryClient.invalidateQueries({ queryKey: qk.photos })
    setLightbox(null)
    toast(next === 'approved' ? 'Report approved' : 'Report rejected')
  }

  return (
    <div className="flex h-[calc(100vh-3.5rem)] flex-col gap-4 overflow-y-auto p-6">
      <div className="flex flex-wrap items-baseline gap-4">
        <h1 className="text-h2">Photo reports</h1>
        <span className="metric text-metric-sm text-text-2">
          {filtered.length} of {reports.length}
        </span>
      </div>

      <div className="rounded-card border-hairline bg-surface-1 flex flex-wrap items-center gap-4 border p-3">
        <div className="flex items-center gap-1">
          <span className="eyebrow mr-1">Severity</span>
          {SEVERITIES.map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setSeverity(severity === value ? null : value)}
              className={cn(
                'border-hairline rounded-full border px-3 py-1 text-xs tracking-[0.06em] uppercase transition-colors duration-[120ms]',
                severity === value
                  ? 'border-accent/40 bg-accent-wash text-accent'
                  : 'text-text-2 hover:text-text-1',
              )}
            >
              {value}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1">
          <span className="eyebrow mr-1">Status</span>
          {STATUSES.map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setStatus(status === value ? null : value)}
              className={cn(
                'border-hairline rounded-full border px-3 py-1 text-xs tracking-[0.06em] uppercase transition-colors duration-[120ms]',
                status === value
                  ? 'border-accent/40 bg-accent-wash text-accent'
                  : 'text-text-2 hover:text-text-1',
              )}
            >
              {value}
            </button>
          ))}
        </div>

        <label className="text-text-2 ml-auto flex items-center gap-3 text-sm">
          <span className="eyebrow">Min confidence</span>
          <input
            type="range"
            min={0.6}
            max={0.99}
            step={0.01}
            value={minConfidence}
            onChange={(e) => setMinConfidence(Number(e.target.value))}
            className="w-40 accent-[var(--color-accent)]"
          />
          <span className="metric text-metric-sm text-text-1">
            {minConfidence.toFixed(2)}
          </span>
        </label>
      </div>

      {filtered.length === 0 && !isLoading && (
        <div className="rounded-card border-hairline flex flex-col items-start gap-2 border border-dashed p-10">
          <h2 className="text-h3">Nothing matches these filters</h2>
          <p className="text-text-2 text-sm">
            Lower the confidence threshold or clear a filter to see more
            reports.
          </p>
          <Button
            variant="secondary"
            onClick={() => {
              setSeverity(null)
              setStatus(null)
              setMinConfidence(0.6)
            }}
          >
            Clear filters
          </Button>
        </div>
      )}

      <ul className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">
        {filtered.map((report) => (
          <li key={report.id}>
            <button
              type="button"
              onClick={() => setLightbox(report)}
              className="group rounded-card border-hairline bg-surface-1 flex w-full flex-col overflow-hidden border text-left"
            >
              <span className="relative block aspect-[4/3] overflow-hidden">
                <img
                  src={report.imageUrl}
                  alt={`${report.label} reported on ${report.segmentName}`}
                  className="size-full object-cover"
                  loading="lazy"
                />
                <DetectionBox report={report} />
              </span>

              <span className="flex flex-col gap-2 p-3">
                <span className="truncate text-sm">{report.segmentName}</span>
                <span className="flex flex-wrap items-center gap-2">
                  <Badge tone={SEVERITY_TONE[report.severity]}>
                    {report.severity}
                  </Badge>
                  <Badge
                    tone={report.status === 'pending' ? 'neutral' : 'accent'}
                  >
                    {report.status}
                  </Badge>
                  <span className="metric text-metric-sm text-text-2 ml-auto">
                    {report.confidence.toFixed(2)}
                  </span>
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>

      <AnimatePresence>
        {lightbox && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={transitions.panelEnter()}
            className="bg-void/85 fixed inset-0 z-50 flex items-center justify-center p-6"
            onClick={() => setLightbox(null)}
            role="dialog"
            aria-modal
            aria-label={`Report ${lightbox.id}`}
          >
            <div
              className="rounded-glass border-hairline-strong bg-surface-1 flex max-h-full w-full max-w-4xl flex-col gap-4 overflow-y-auto border p-5"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex flex-wrap items-baseline gap-3">
                <h2 className="text-h3">{lightbox.segmentName}</h2>
                <Badge mono>{lightbox.id}</Badge>
                <Badge tone={SEVERITY_TONE[lightbox.severity]}>
                  {lightbox.severity}
                </Badge>
                <span className="metric text-metric-sm text-text-2 ml-auto">
                  {new Date(lightbox.createdAt).toLocaleString('en-IN')}
                </span>
              </div>

              <div className="rounded-card relative overflow-hidden">
                <img
                  src={lightbox.imageUrl}
                  alt={`${lightbox.label} on ${lightbox.segmentName}`}
                  className="w-full"
                />
                <DetectionBox report={lightbox} />
              </div>

              <div className="flex flex-wrap items-center gap-4">
                <span className="text-text-2 text-sm">
                  Reported by{' '}
                  <span className="text-text-1">{lightbox.reporter}</span>
                </span>
                <span className="metric text-metric-sm text-text-2">
                  {lightbox.label} · {lightbox.confidence.toFixed(2)} confidence
                </span>

                <div className="ml-auto flex gap-2">
                  <Button
                    variant="destructive"
                    onClick={() => void decide(lightbox.id, 'rejected')}
                  >
                    Reject
                  </Button>
                  <Button onClick={() => void decide(lightbox.id, 'approved')}>
                    Approve
                  </Button>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

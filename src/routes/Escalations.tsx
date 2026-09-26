import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { formatInr } from '@/components/data-viz/Metric'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { qk } from '@/data/DataSource'
import { dataSource } from '@/data'
import { useEscalations } from '@/data/hooks'
import { mailtoLink, type Escalation } from '@shared/escalation'
import { cn } from '@/lib/utils'

/* Reviewing what goes out to a public authority.
 *
 * The drafting is automatic; the sending is not. A detector cannot tell a
 * pothole from a speed bump or a manhole cover, and a few spurious complaints
 * to a works department do lasting damage: they waste an official's time and
 * teach them to ignore the next report, including the true ones. Ten seconds
 * of an engineer's attention prevents both, and is the only manual step in the
 * whole chain.
 */

const STATUS_TONE = {
  draft: 'neutral',
  approved: 'accent',
  sent: 'good',
  dismissed: 'neutral',
} as const

function StatusBadge({ status }: { status: Escalation['status'] }) {
  return <Badge tone={STATUS_TONE[status]}>{status}</Badge>
}

export function Escalations() {
  const { data: escalations = [], isLoading } = useEscalations()
  const queryClient = useQueryClient()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const selected =
    escalations.find((e) => e.id === selectedId) ?? escalations[0] ?? null

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: qk.escalations })
  }

  async function generate() {
    setBusy(true)
    try {
      const { created, skipped } = await dataSource.generateEscalations()
      await refresh()

      if (created.length === 0) {
        toast('No new reports', {
          description:
            skipped[0]?.reason ??
            'Every failing road has either been reported recently or lacks corroborating evidence.',
        })
        return
      }
      toast.success(
        `${created.length} draft${created.length > 1 ? 's' : ''} prepared`,
        {
          description: 'Review each one before it goes anywhere.',
        },
      )
    } finally {
      setBusy(false)
    }
  }

  async function review(
    escalation: Escalation,
    action: 'approve' | 'send' | 'dismiss',
  ) {
    setBusy(true)
    try {
      await dataSource.reviewEscalation(escalation.id, action)
      await refresh()
      toast.success(
        action === 'approve'
          ? `${escalation.id} approved`
          : action === 'send'
            ? `${escalation.id} marked sent`
            : `${escalation.id} dismissed`,
      )
    } catch (error) {
      toast.error(String((error as Error).message ?? error))
    } finally {
      setBusy(false)
    }
  }

  const drafts = escalations.filter((e) => e.status === 'draft')

  return (
    <div className="flex h-[calc(100vh-3.5rem)] w-full">
      <div className="border-hairline bg-surface-1 flex w-[380px] shrink-0 flex-col border-r">
        <div className="border-hairline flex flex-col gap-3 border-b p-5">
          <div className="flex items-baseline justify-between">
            <h1 className="text-h2">Escalations</h1>
            <span className="metric text-metric-sm text-text-2">
              {drafts.length} awaiting review
            </span>
          </div>
          <p className="text-text-2 text-sm">
            Roads bad enough to report, with the evidence to back it up. Drafted
            automatically; sent only when you say so.
          </p>
          <Button onClick={() => void generate()} disabled={busy}>
            Check for new reports
          </Button>
        </div>

        <ul className="flex-1 overflow-y-auto">
          {escalations.map((escalation) => (
            <li key={escalation.id}>
              <button
                type="button"
                onClick={() => setSelectedId(escalation.id)}
                className={cn(
                  'border-hairline flex w-full flex-col gap-2 border-b p-4 text-left',
                  'hover:bg-surface-2/60 transition-colors duration-[120ms]',
                  selected?.id === escalation.id && 'bg-accent-wash',
                )}
              >
                <span className="flex items-center gap-2">
                  <StatusBadge status={escalation.status} />
                  {escalation.severity === 'critical' && (
                    <Badge tone="critical">critical</Badge>
                  )}
                  <span className="metric text-metric-sm text-text-3 ml-auto">
                    {escalation.id}
                  </span>
                </span>
                <span className="truncate text-sm">
                  {escalation.segmentName}
                </span>
                <span className="text-text-2 truncate text-xs">
                  {escalation.authority.name}
                </span>
              </button>
            </li>
          ))}

          {escalations.length === 0 && !isLoading && (
            <li className="flex flex-col items-start gap-3 p-6">
              <h2 className="text-h3">Nothing to report</h2>
              <p className="text-text-2 text-sm">
                A road is reported when it is bad enough <em>and</em>{' '}
                corroborated — several independent impacts on the same stretch,
                or a photograph an engineer has approved. One phone hitting
                something once is not evidence.
              </p>
            </li>
          )}
        </ul>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {!selected && (
          <p className="text-text-2 text-sm">Select a report to review it.</p>
        )}

        {selected && (
          <div className="mx-auto flex max-w-3xl flex-col gap-5">
            <div className="flex flex-wrap items-baseline gap-3">
              <h2 className="text-h2">{selected.segmentName}</h2>
              <StatusBadge status={selected.status} />
              <Badge mono>{selected.id}</Badge>
              <span className="metric text-metric-sm text-text-2 ml-auto">
                {formatInr(selected.estimatedCostInr)}
              </span>
            </div>

            <div className="border-hairline bg-surface-1 rounded-card grid grid-cols-2 gap-4 border p-4">
              <div className="flex flex-col gap-1">
                <span className="eyebrow">Addressed to</span>
                <span className="text-sm">{selected.authority.name}</span>
                <span className="metric text-metric-sm text-text-2">
                  {selected.authority.email || 'no address configured'}
                </span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="eyebrow">Location</span>
                <a
                  href={selected.location.mapsUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent text-sm underline underline-offset-2"
                >
                  {selected.location.lat.toFixed(5)},{' '}
                  {selected.location.lon.toFixed(5)}
                </a>
                <span className="metric text-metric-sm text-text-2">
                  {selected.photoReportIds.length} photo report
                  {selected.photoReportIds.length === 1 ? '' : 's'} attached
                </span>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <span className="eyebrow">Subject</span>
              <p className="text-body">{selected.subject}</p>
            </div>

            <div className="flex flex-col gap-2">
              <span className="eyebrow">Message</span>
              {/* The exact text that will be sent, not a summary of it. */}
              <pre className="border-hairline bg-surface-1 rounded-card overflow-x-auto border p-4 font-sans text-sm whitespace-pre-wrap">
                {selected.body}
              </pre>
            </div>

            {!selected.authority.email && (
              <p className="border-health-watch/40 bg-health-watch/10 text-text-1 rounded-card border p-3 text-sm">
                No address is configured for this office, so nothing can be
                transmitted from here. Open the draft in your own mail client —
                which is where it should be sent from anyway, since that is
                where the reply will go.
              </p>
            )}

            <div className="flex flex-wrap gap-2 pb-6">
              {selected.status === 'draft' && (
                <Button
                  disabled={busy}
                  onClick={() => void review(selected, 'approve')}
                >
                  Approve
                </Button>
              )}

              <Button
                variant="secondary"
                onClick={() => {
                  window.location.href = mailtoLink(selected)
                }}
              >
                Open in mail client
              </Button>

              {selected.status === 'approved' && (
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void review(selected, 'send')}
                >
                  Mark as sent
                </Button>
              )}

              {selected.status !== 'sent' && (
                <Button
                  variant="destructive"
                  disabled={busy}
                  onClick={() => void review(selected, 'dismiss')}
                >
                  Dismiss
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

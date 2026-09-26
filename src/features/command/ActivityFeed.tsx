import { AnimatePresence, motion } from 'motion/react'
import { GlassPanel } from '@/components/glass/GlassPanel'
import type { LiveEvent } from '@/data/types'
import { transitions } from '@/design/motion'

function timeOf(at: string) {
  return new Date(at).toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

/** Newest at the top, sliding the rest down (UI_DESIGN 5.2). */
export function ActivityFeed({
  events,
  onSelect,
}: {
  events: LiveEvent[]
  onSelect: (id: number) => void
}) {
  return (
    <GlassPanel
      as="section"
      className="flex h-[300px] w-[360px] shrink-0 flex-col overflow-hidden"
      aria-label="Live activity"
      static
    >
      <h2 className="eyebrow px-4 pt-4 pb-2">Live activity</h2>

      <ul className="flex-1 overflow-y-auto px-2 pb-2" aria-live="off">
        <AnimatePresence initial={false}>
          {events.slice(0, 20).map((event) => (
            <motion.li
              key={`${event.type}-${event.at}-${event.segmentId}`}
              layout
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={transitions.panelEnter()}
            >
              <button
                type="button"
                onClick={() => onSelect(event.segmentId)}
                className="rounded-control hover:bg-surface-2/60 flex w-full items-center gap-2 px-2 py-1.5 text-left"
              >
                <span className="metric text-metric-sm text-text-3 shrink-0">
                  {timeOf(event.at)}
                </span>

                {event.type === 'bump' && (
                  <>
                    <span className="text-text-2 text-sm">
                      bump{' '}
                      <span className="metric text-text-1">
                        {event.magnitude.toFixed(1)}
                      </span>{' '}
                      m/s²
                    </span>
                    <span className="metric text-metric-sm text-text-3 ml-auto shrink-0">
                      SEG-{String(event.segmentId).padStart(4, '0')}
                    </span>
                    {event.real && (
                      <span className="eyebrow text-accent shrink-0">
                        Phone
                      </span>
                    )}
                  </>
                )}

                {event.type === 'photo' && (
                  <>
                    <img
                      src={event.report.imageUrl}
                      alt=""
                      className="rounded-chip size-8 shrink-0 object-cover"
                    />
                    <span className="text-text-2 truncate text-sm">
                      photo · {event.report.label}
                    </span>
                    <span className="metric text-metric-sm text-text-3 ml-auto shrink-0">
                      {Math.round(event.report.confidence * 100)}%
                    </span>
                  </>
                )}

                {event.type === 'alert' && (
                  <span className="text-health-critical truncate text-sm">
                    {event.message}
                  </span>
                )}
              </button>
            </motion.li>
          ))}
        </AnimatePresence>

        {events.length === 0 && (
          <li className="text-text-2 px-2 py-6 text-sm">
            Waiting for the first bump. Events arrive every few seconds.
          </li>
        )}
      </ul>
    </GlassPanel>
  )
}

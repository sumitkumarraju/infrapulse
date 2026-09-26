import { useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'motion/react'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { formatInr } from '@/components/data-viz/Metric'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { qk } from '@/data/DataSource'
import { dataSource } from '@/data'
import { useWorkOrders } from '@/data/hooks'
import type { WorkOrder, WorkOrderStatus } from '@/data/types'
import { transitions } from '@/design/motion'
import { cn } from '@/lib/utils'

const COLUMNS: { status: WorkOrderStatus; label: string }[] = [
  { status: 'open', label: 'Open' },
  { status: 'in-progress', label: 'In progress' },
  { status: 'repaired', label: 'Repaired' },
  { status: 'verified', label: 'Verified' },
  { status: 'reopened', label: 'Reopened' },
]

function ageInDays(iso: string) {
  return Math.max(
    0,
    Math.round((Date.now() - new Date(iso).getTime()) / 86_400_000),
  )
}

function initials(name: string) {
  return name
    .split(/[\s.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('')
}

function Card({
  order,
  onMove,
  celebrating,
}: {
  order: WorkOrder
  onMove: (id: string, status: WorkOrderStatus) => void
  celebrating: boolean
}) {
  const index = COLUMNS.findIndex((c) => c.status === order.status)
  const improvement =
    order.bumpRateAfter !== undefined && order.bumpRateBefore > 0
      ? Math.round(
          ((order.bumpRateBefore - order.bumpRateAfter) /
            order.bumpRateBefore) *
            100,
        )
      : null

  return (
    <motion.li
      layout
      layoutId={order.id}
      drag
      dragSnapToOrigin
      dragElastic={0.12}
      whileDrag={{ scale: 1.03, zIndex: 40, cursor: 'grabbing' }}
      transition={transitions.drag()}
      onDragEnd={(event) => {
        // Motion gives us the pointer, the DOM tells us which column it is
        // over. Simpler and more forgiving than hit-testing rectangles.
        const point =
          'clientX' in event
            ? { x: event.clientX, y: event.clientY }
            : { x: 0, y: 0 }
        const element = document
          .elementsFromPoint(point.x, point.y)
          .find((el) => el instanceof HTMLElement && el.dataset.column)
        const status = (element as HTMLElement | undefined)?.dataset.column as
          WorkOrderStatus | undefined
        if (status && status !== order.status) onMove(order.id, status)
      }}
      className={cn(
        'rounded-card border-hairline bg-surface-2 relative cursor-grab list-none border p-3',
        celebrating && 'ring-health-good ring-2',
      )}
    >
      {celebrating && (
        <motion.span
          aria-hidden
          initial={{ x: '-110%' }}
          animate={{ x: '110%' }}
          transition={{ duration: 0.7, ease: [0.34, 1.56, 0.64, 1] }}
          className="via-health-good/25 pointer-events-none absolute inset-y-0 w-1/2 bg-gradient-to-r from-transparent to-transparent"
        />
      )}

      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 flex-1 truncate text-sm">
          {order.segmentName}
        </span>
        <Badge mono>{order.id}</Badge>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Badge>{order.repairType}</Badge>
        <span className="metric text-metric-sm text-text-2">
          {formatInr(order.costInr)}
        </span>
        <span className="metric text-metric-sm text-text-3 ml-auto">
          {ageInDays(order.createdAt)}d
        </span>
        <span
          className="bg-surface-3 text-text-2 flex size-6 items-center justify-center rounded-full text-xs"
          title={order.assignee}
        >
          {initials(order.assignee)}
        </span>
      </div>

      {improvement !== null && (
        <p className="text-health-good mt-2 text-xs">
          Bumps {order.bumpRateBefore} → {order.bumpRateAfter} per 100 passes,{' '}
          {improvement}% better
        </p>
      )}

      {/* Keyboard equivalent of the drag — the board is not mouse-only. */}
      <div className="mt-2 flex gap-1">
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Move ${order.id} left`}
          disabled={index <= 0}
          onClick={() => onMove(order.id, COLUMNS[index - 1].status)}
        >
          ←
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Move ${order.id} right`}
          disabled={index >= COLUMNS.length - 1}
          onClick={() => onMove(order.id, COLUMNS[index + 1].status)}
        >
          →
        </Button>
      </div>
    </motion.li>
  )
}

export function WorkOrders() {
  const { data: orders = [], isLoading } = useWorkOrders()
  const queryClient = useQueryClient()
  const [celebrating, setCelebrating] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  async function move(id: string, status: WorkOrderStatus) {
    const updated = await dataSource.updateWorkOrder(id, { status })
    await queryClient.invalidateQueries({ queryKey: qk.workOrders })
    await queryClient.invalidateQueries({ queryKey: qk.kpis })

    if (status === 'verified') {
      setCelebrating(id)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCelebrating(null), 1400)

      const before = updated.bumpRateBefore
      const after = updated.bumpRateAfter ?? 0
      toast.success('Repair verified', {
        description: `${updated.segmentName}: bumps fell from ${before} to ${after} per 100 passes`,
      })
    }
  }

  return (
    <div className="flex h-[calc(100vh-3.5rem)] flex-col gap-4 p-6">
      <div className="flex items-baseline gap-4">
        <h1 className="text-h2">Work orders</h1>
        <span className="metric text-metric-sm text-text-2">
          {orders.length} total
        </span>
        <p className="text-text-2 ml-auto text-sm">
          Drag a card between columns, or use the arrows.
        </p>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-5 gap-4">
        {COLUMNS.map((column) => {
          const items = orders.filter((o) => o.status === column.status)
          return (
            <section
              key={column.status}
              data-column={column.status}
              className="rounded-card border-hairline bg-surface-1 flex min-h-0 flex-col border"
              aria-label={column.label}
            >
              <header
                data-column={column.status}
                className="border-hairline flex items-baseline justify-between border-b px-3 py-2"
              >
                <h2 className="eyebrow">{column.label}</h2>
                <span className="metric text-metric-sm text-text-2">
                  {items.length}
                </span>
              </header>

              <ul
                data-column={column.status}
                className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2"
              >
                <AnimatePresence initial={false}>
                  {items.map((order) => (
                    <Card
                      key={order.id}
                      order={order}
                      onMove={(id, status) => void move(id, status)}
                      celebrating={celebrating === order.id}
                    />
                  ))}
                </AnimatePresence>

                {items.length === 0 && !isLoading && (
                  <li
                    data-column={column.status}
                    className="rounded-card border-hairline text-text-3 border border-dashed p-4 text-center text-xs"
                  >
                    Drop here
                  </li>
                )}
              </ul>
            </section>
          )
        })}
      </div>
    </div>
  )
}

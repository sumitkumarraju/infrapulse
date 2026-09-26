import { useQueryClient } from '@tanstack/react-query'
import { motion } from 'motion/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/Button'
import { qk } from '@/data/DataSource'
import { dataSource } from '@/data'
import { mockOnly, useDemoMode } from '@/demo/demoState'
import { panelEnter, transitions } from '@/design/motion'
import { useDemoStore } from '@/store/demoStore'

const TOUR_MS = 4200

/**
 * The presenter's remote, shown only with `?demo=1` so it can never appear in
 * a screenshot by accident. Every button drives the real app — none of them
 * fake a result or bypass the DataSource.
 */
export function DemoControls() {
  const [searchParams] = useSearchParams()
  const enabled = useDemoMode((s) => s.enabled)
  const setEnabled = useDemoMode((s) => s.setEnabled)

  const navigate = useNavigate()
  const location = useLocation()
  const queryClient = useQueryClient()
  const fastForwardDays = useDemoMode((s) => s.fastForwardDays)
  const setFastForward = useDemoMode((s) => s.setFastForward)
  const tourStep = useDemoMode((s) => s.tourStep)
  const setTourStep = useDemoMode((s) => s.setTourStep)
  const resetStore = useDemoStore((s) => s.reset)

  const [tourIds, setTourIds] = useState<number[]>([])
  /* Starts collapsed: every corner of the app already holds a panel — the KPI
     bar, the map rails, the forecast timeline — so an expanded remote would
     cover something on whichever screen the presenter happens to be on. */
  const [collapsed, setCollapsed] = useState(true)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const flag = searchParams.get('demo')
    if (flag === '1') setEnabled(true)
    if (flag === '0') setEnabled(false)
  }, [searchParams, setEnabled])

  const stopTour = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    setTourStep(null)
  }, [setTourStep])

  /* The tour is just the app being driven: each step deep-links to a segment,
     which is the same thing clicking the queue does, camera fly and all. */
  useEffect(() => {
    if (tourStep === null || tourIds.length === 0) return

    if (tourStep >= tourIds.length) {
      stopTour()
      toast('Tour complete')
      return
    }

    navigate(`/command?demo=1&segment=${tourIds[tourStep]}`)
    timer.current = setTimeout(() => setTourStep(tourStep + 1), TOUR_MS)

    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [tourStep, tourIds, navigate, setTourStep, stopTour])

  useEffect(() => stopTour, [stopTour])

  if (!enabled) return null

  async function simulateDrive() {
    const mock = mockOnly()
    if (!mock) {
      toast('Live simulation is only available on the mock data source.')
      return
    }
    await mock.simulateDrive(14)
    if (location.pathname !== '/command') navigate('/command?demo=1')
    toast('Simulating a drive — 14 bumps incoming')
  }

  function fastForward() {
    const next = fastForwardDays === 0 ? 30 : fastForwardDays === 30 ? 60 : 0
    setFastForward(next)
    toast(next === 0 ? 'Back to today' : `Projected ${next} days forward`)
  }

  async function verifyRepair() {
    const orders = await dataSource.getWorkOrders()
    const target =
      orders.find((o) => o.status === 'repaired') ??
      orders.find((o) => o.status === 'in-progress') ??
      orders.find((o) => o.status === 'open')

    if (!target) {
      toast('No open work order to verify.')
      return
    }

    const updated = await dataSource.updateWorkOrder(target.id, {
      status: 'verified',
    })
    await queryClient.invalidateQueries({ queryKey: qk.workOrders })
    await queryClient.invalidateQueries({ queryKey: qk.kpis })
    navigate('/work-orders?demo=1')
    toast.success(`${updated.id} verified`, {
      description: `${updated.segmentName}: bumps ${updated.bumpRateBefore} → ${updated.bumpRateAfter} per 100 passes`,
    })
  }

  async function startTour() {
    if (tourStep !== null) {
      stopTour()
      return
    }
    const mock = mockOnly()
    const ids = mock ? await mock.worstSegmentIds(3) : []
    if (ids.length === 0) {
      toast('Nothing to tour yet — the road network is still loading.')
      return
    }
    setTourIds(ids)
    setTourStep(0)
  }

  async function reset() {
    await dataSource.resetDemo()
    resetStore()
    setFastForward(0)
    stopTour()
    await queryClient.invalidateQueries()
    toast('Demo reset')
  }

  return (
    <motion.aside
      variants={panelEnter}
      initial="hidden"
      animate="visible"
      transition={transitions.panelEnter()}
      className="glass fixed bottom-4 left-1/2 z-50 max-w-[calc(100vw-2rem)] -translate-x-1/2 p-3"
      aria-label="Demo controls"
    >
      <div className="flex flex-wrap items-center justify-center gap-2">
        <span className="eyebrow px-1 text-accent">Demo</span>

        {!collapsed && (
          <>
            <Button size="sm" variant="secondary" onClick={() => void simulateDrive()}>
              Simulate drive
            </Button>
            <Button size="sm" variant="secondary" onClick={fastForward}>
              {fastForwardDays === 0
                ? 'Fast-forward 30 days'
                : `+${fastForwardDays}d — back to today`}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => void verifyRepair()}>
              Verify a repair
            </Button>
            <Button
              size="sm"
              variant={tourStep === null ? 'secondary' : 'primary'}
              onClick={() => void startTour()}
            >
              {tourStep === null
                ? 'Presenter tour'
                : `Stop tour (${tourStep + 1}/3)`}
            </Button>
            <Button size="sm" variant="destructive" onClick={() => void reset()}>
              Reset demo
            </Button>
          </>
        )}

        <Button
          size="sm"
          variant="ghost"
          aria-label={collapsed ? 'Show demo controls' : 'Hide demo controls'}
          onClick={() => setCollapsed((c) => !c)}
        >
          {collapsed ? '▸' : '▾'}
        </Button>
      </div>
    </motion.aside>
  )
}

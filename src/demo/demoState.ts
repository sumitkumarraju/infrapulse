import { create } from 'zustand'
import { dataSource } from '@/data'
import type { MockDataSource } from '@/data/mock/MockDataSource'

/* Presenter state for `?demo=1`. Deliberately NOT persisted: a reload should
 * put the demo back to its ordinary state rather than resuming a half-finished
 * tour. Durable demo state (work orders, budget plans) lives in demoStore. */

interface DemoModeState {
  /**
   * Sticky for the session: `?demo=1` turns the controls on and they stay on
   * as the presenter navigates, since the nav links do not carry query
   * parameters. `?demo=0` turns them off again.
   */
  enabled: boolean
  /** Days the whole city is projected forward on /command, 0 = today. */
  fastForwardDays: number
  /** Index into the tour, or null when no tour is running. */
  tourStep: number | null
  setEnabled: (enabled: boolean) => void
  setFastForward: (days: number) => void
  setTourStep: (step: number | null) => void
}

export const useDemoMode = create<DemoModeState>((set) => ({
  enabled: false,
  fastForwardDays: 0,
  tourStep: null,
  setEnabled: (enabled) => set({ enabled }),
  setFastForward: (days) => set({ fastForwardDays: days }),
  setTourStep: (step) => set({ tourStep: step }),
}))

/**
 * Demo controls need two things the DataSource contract does not promise — a
 * way to inject events into this tab's own stream, and the current worst
 * segments. Rather than widen the interface every real backend would have to
 * implement, demo mode asks whether the active source happens to offer them.
 */
export function mockOnly(): MockDataSource | null {
  const candidate = dataSource as Partial<MockDataSource>
  return typeof candidate.simulateDrive === 'function'
    ? (dataSource as MockDataSource)
    : null
}

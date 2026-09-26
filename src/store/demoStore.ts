/* Local persistence (CLAUDE.md 4.5).
 *
 * Work-order edits, budget plans and report decisions survive a refresh, so a
 * demo can be interrupted and picked up. "Reset demo" clears the lot. The
 * generated dataset itself is never stored — it is deterministic, so persisting
 * it would only create a way for the two to disagree.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { PhotoStatus, WorkOrder, WorkOrderStatus } from '@/data/types'
import type { Escalation } from '@shared/escalation'

interface DemoState {
  /** Patches applied on top of generated work orders, by id. */
  workOrderPatches: Record<string, Partial<WorkOrder>>
  /** Work orders the user created in this session. */
  createdWorkOrders: WorkOrder[]
  photoStatuses: Record<string, PhotoStatus>
  /** Segment ids in the current budget plan. */
  budgetPlan: number[]
  budgetInr: number
  /** Bumps counted since the demo started, added to the seeded base. */
  liveBumps: number
  /** Drafted complaints, in the mock. The server owns these when it is in play. */
  escalations: Escalation[]

  patchWorkOrder: (id: string, patch: Partial<WorkOrder>) => void
  addWorkOrders: (orders: WorkOrder[]) => void
  moveWorkOrder: (id: string, status: WorkOrderStatus) => void
  setPhotoStatus: (id: string, status: PhotoStatus) => void
  setBudget: (budgetInr: number, plan: number[]) => void
  countBump: () => void
  setEscalations: (escalations: Escalation[]) => void
  reset: () => void
}

const EMPTY = {
  workOrderPatches: {},
  createdWorkOrders: [],
  photoStatuses: {},
  budgetPlan: [],
  budgetInr: 1_00_00_000, // ₹1 crore
  liveBumps: 0,
  escalations: [],
}

export const useDemoStore = create<DemoState>()(
  persist(
    (set) => ({
      ...EMPTY,

      patchWorkOrder: (id, patch) =>
        set((state) => ({
          workOrderPatches: {
            ...state.workOrderPatches,
            [id]: {
              ...state.workOrderPatches[id],
              ...patch,
              updatedAt: new Date().toISOString(),
            },
          },
        })),

      addWorkOrders: (orders) =>
        set((state) => ({
          createdWorkOrders: [...state.createdWorkOrders, ...orders],
        })),

      moveWorkOrder: (id, status) =>
        set((state) => {
          const created = state.createdWorkOrders.find((w) => w.id === id)
          const now = new Date().toISOString()
          if (created) {
            return {
              createdWorkOrders: state.createdWorkOrders.map((w) =>
                w.id === id ? { ...w, status, updatedAt: now } : w,
              ),
            }
          }
          return {
            workOrderPatches: {
              ...state.workOrderPatches,
              [id]: { ...state.workOrderPatches[id], status, updatedAt: now },
            },
          }
        }),

      setPhotoStatus: (id, status) =>
        set((state) => ({
          photoStatuses: { ...state.photoStatuses, [id]: status },
        })),

      setBudget: (budgetInr, plan) => set({ budgetInr, budgetPlan: plan }),

      countBump: () => set((state) => ({ liveBumps: state.liveBumps + 1 })),

      setEscalations: (escalations) => set({ escalations }),

      reset: () => set({ ...EMPTY }),
    }),
    { name: 'infrapulse-demo' },
  ),
)

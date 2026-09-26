/* Motion presets — UI_DESIGN.md section 6.
   Motion explains state change; it never decorates.

   Every preset here is a plain object handed to `motion/react`, so components
   never invent their own durations. `prefers-reduced-motion` is honoured in two
   places: CSS transitions collapse in index.css, and JS-driven animation reads
   `prefersReducedMotion()` below. */

import type { Transition, Variants } from 'motion/react'

export const EASE = {
  micro: [0.4, 0, 0.2, 1],
  panel: [0.22, 1, 0.36, 1],
  outExpo: [0.16, 1, 0.3, 1],
  inOutCubic: [0.65, 0, 0.35, 1],
  outBack: [0.34, 1.56, 0.64, 1],
} as const

export const DURATION = {
  micro: 0.12,
  panelEnter: 0.26,
  countUp: 0.9,
  pulseRing: 0.9,
  pageTransition: 0.32,
  cameraFly: 1.2,
  celebrate: 0.7,
} as const

/** True when the viewer has asked for less motion. Safe during SSR and tests. */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Strips movement from a transition, keeping a short fade. */
function respectReducedMotion(t: Transition): Transition {
  return prefersReducedMotion() ? { duration: DURATION.micro } : t
}

export const transitions = {
  micro: (): Transition =>
    respectReducedMotion({ duration: DURATION.micro, ease: EASE.micro }),
  panelEnter: (): Transition =>
    respectReducedMotion({ duration: DURATION.panelEnter, ease: EASE.panel }),
  countUp: (): Transition =>
    respectReducedMotion({ duration: DURATION.countUp, ease: EASE.outExpo }),
  pageTransition: (): Transition =>
    respectReducedMotion({
      duration: DURATION.pageTransition,
      ease: EASE.panel,
    }),
  celebrate: (): Transition =>
    respectReducedMotion({ duration: DURATION.celebrate, ease: EASE.outBack }),
  /** Kanban drag — a spring, so an interrupted drag still feels physical. */
  drag: (): Transition => ({ type: 'spring', stiffness: 400, damping: 30 }),
} as const

/* --- Variants ---------------------------------------------------------- */

/** Glass panels and the segment drawer: fade plus a small rise. */
export const panelEnter: Variants = {
  hidden: { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0 },
}

/** Drawer sliding in from the right edge. */
export const drawerEnter: Variants = {
  hidden: { opacity: 0, x: 32 },
  visible: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: 32 },
}

/** Route change: fade plus an 8px rise (UI_DESIGN 6). */
export const pageTransition: Variants = {
  hidden: { opacity: 0, y: 8 },
  visible: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
}

/**
 * Staggered list, capped at six children — beyond that the delay reads as lag
 * rather than rhythm, so later items appear together.
 */
export const staggerList = (count: number): Variants => ({
  hidden: {},
  visible: {
    transition: {
      staggerChildren: prefersReducedMotion() ? 0 : 0.04,
      staggerDirection: 1,
      delayChildren: 0,
      // Motion has no "cap" option; we simply stop staggering past six.
      when: 'beforeChildren',
      ...(count > 6 ? { staggerChildren: 0 } : {}),
    },
  },
})

/** The live pulse ring and the LIVE pip: one continuous 900ms breath. */
export const pulseRing: Variants = {
  idle: { scale: 1, opacity: 0.9 },
  pulse: {
    scale: [1, 1.9],
    opacity: [0.9, 0],
    transition: {
      duration: DURATION.pulseRing,
      ease: 'linear',
      repeat: Infinity,
    },
  },
}

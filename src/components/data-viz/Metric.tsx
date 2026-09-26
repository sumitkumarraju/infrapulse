import { animate, useMotionValue } from 'motion/react'
import { useEffect, useState } from 'react'
import { DURATION, EASE, prefersReducedMotion } from '@/design/motion'
import { cn } from '@/lib/utils'

/** Numbers count up rather than snapping (UI_DESIGN 6). */
export function CountUp({
  value,
  decimals = 0,
  className,
  style,
  format,
}: {
  value: number
  decimals?: number
  className?: string
  style?: React.CSSProperties
  format?: (v: number) => string
}) {
  const motionValue = useMotionValue(0)
  const [display, setDisplay] = useState(0)

  useEffect(() => {
    if (prefersReducedMotion()) {
      setDisplay(value)
      return
    }
    const controls = animate(motionValue, value, {
      duration: DURATION.countUp,
      ease: EASE.outExpo,
      onUpdate: setDisplay,
    })
    return () => controls.stop()
  }, [value, motionValue])

  const text = format
    ? format(display)
    : display.toFixed(decimals)

  return (
    <span className={cn('metric', className)} style={style}>
      {text}
    </span>
  )
}

/** Indian digit grouping — 1,42,80,000 rather than 14,280,000. */
export function formatInr(value: number): string {
  const rounded = Math.round(value)
  if (rounded >= 1_00_00_000) return `₹${(rounded / 1_00_00_000).toFixed(2)} cr`
  if (rounded >= 1_00_000) return `₹${(rounded / 1_00_000).toFixed(1)} L`
  return `₹${rounded.toLocaleString('en-IN')}`
}

export function formatInrExact(value: number): string {
  return `₹${Math.round(value).toLocaleString('en-IN')}`
}

/** A 30-point trend line, no axes — context, not a chart. */
export function Sparkline({
  values,
  className,
  stroke = 'var(--color-accent)',
}: {
  values: number[]
  className?: string
  stroke?: string
}) {
  if (values.length < 2) return null

  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const points = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * 100
      const y = 24 - ((v - min) / span) * 22 - 1
      return `${x.toFixed(2)},${y.toFixed(2)}`
    })
    .join(' ')

  return (
    <svg
      viewBox="0 0 100 24"
      preserveAspectRatio="none"
      className={cn('h-6 w-full', className)}
      aria-hidden
    >
      <polyline
        points={points}
        fill="none"
        stroke={stroke}
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
      />
    </svg>
  )
}

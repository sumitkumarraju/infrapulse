import { cva, type VariantProps } from 'class-variance-authority'
import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

const badge = cva(
  'inline-flex items-center gap-1.5 rounded-chip border px-2 py-0.5 ' +
    'text-xs uppercase tracking-[0.06em] font-[550]',
  {
    variants: {
      tone: {
        neutral: 'border-hairline bg-surface-2 text-text-2',
        accent: 'border-accent/35 bg-accent-wash text-accent',
        // Health tones exist only for road condition (UI_DESIGN 1.4).
        good: 'border-health-good/35 bg-health-good/10 text-health-good',
        watch: 'border-health-watch/35 bg-health-watch/10 text-health-watch',
        critical:
          'border-health-critical/40 bg-health-critical/10 text-health-critical',
      },
      mono: { true: 'font-mono normal-case tracking-normal', false: '' },
    },
    defaultVariants: { tone: 'neutral', mono: false },
  },
)

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badge> {}

export function Badge({ className, tone, mono, ...props }: BadgeProps) {
  return <span className={cn(badge({ tone, mono }), className)} {...props} />
}

import { cva, type VariantProps } from 'class-variance-authority'
import type { ButtonHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

/* Cyan is the interface's colour (UI_DESIGN 1.3) — the health ramp is never
   used for buttons, so there is no "success" or "danger" fill here. A
   destructive action is a plain button with a red hairline. */
const button = cva(
  'inline-flex items-center justify-center gap-2 rounded-control font-sans ' +
    'whitespace-nowrap transition-[background-color,border-color,color,transform] ' +
    'duration-[120ms] ease-micro select-none ' +
    'disabled:pointer-events-none disabled:opacity-40 active:translate-y-px',
  {
    variants: {
      variant: {
        primary:
          'bg-accent text-void font-[550] hover:bg-accent-bright active:bg-accent-deep active:text-text-1',
        secondary:
          'bg-surface-2 text-text-1 border border-hairline-strong hover:bg-surface-3',
        ghost:
          'bg-transparent text-text-2 hover:bg-surface-2 hover:text-text-1',
        outline:
          'bg-transparent text-accent border border-accent/40 hover:border-accent hover:bg-accent-wash',
        destructive:
          'bg-transparent text-text-1 border border-health-critical/50 hover:bg-health-critical/10 hover:border-health-critical',
      },
      size: {
        // 44px minimum touch target on desktop overlays (UI_DESIGN 7).
        sm: 'h-9 px-3 text-sm',
        md: 'h-11 px-4 text-sm',
        lg: 'h-12 px-6 text-body',
        icon: 'size-11 p-0',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
)

export interface ButtonProps
  extends
    ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof button> {}

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return (
    <button className={cn(button({ variant, size }), className)} {...props} />
  )
}

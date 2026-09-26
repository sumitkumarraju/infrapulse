import { motion } from 'motion/react'
import type { ReactNode } from 'react'
import { panelEnter, transitions } from '@/design/motion'
import { cn } from '@/lib/utils'

interface GlassPanelProps {
  children: ReactNode
  className?: string
  /** Adds the scrim behind content. On for anything holding body text. */
  scrim?: boolean
  /** Skip the entrance animation for panels that are always present. */
  static?: boolean
  as?: 'div' | 'section' | 'aside' | 'header'
  'aria-label'?: string
}

/**
 * The only glass surface in the app (UI_DESIGN 3.1). Four ingredients live in
 * the `.glass` class: frost, translucency, a lit rim, layered depth. Glass never
 * sits on glass, so nesting one of these inside another is a bug.
 */
export function GlassPanel({
  children,
  className,
  scrim = true,
  static: isStatic = false,
  as = 'div',
  ...rest
}: GlassPanelProps) {
  const Component = motion[as]

  return (
    <Component
      className={cn('glass', scrim && 'glass-scrim', className)}
      variants={isStatic ? undefined : panelEnter}
      initial={isStatic ? undefined : 'hidden'}
      animate={isStatic ? undefined : 'visible'}
      transition={transitions.panelEnter()}
      {...rest}
    >
      {children}
    </Component>
  )
}

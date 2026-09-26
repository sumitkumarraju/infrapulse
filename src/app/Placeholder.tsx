import { Badge } from '@/components/ui/Badge'

/** Stand-in for a route whose phase has not been built yet. */
export function Placeholder({
  title,
  phase,
}: {
  title: string
  phase: string
}) {
  return (
    <div className="mx-auto flex max-w-2xl flex-col items-start gap-4 px-6 py-24">
      <Badge tone="accent">{phase}</Badge>
      <h1 className="text-h1">{title}</h1>
      <p className="text-body text-text-2">
        Not built yet. The foundation, design tokens and mock data layer come
        first; see <code className="text-text-1">CLAUDE.md</code> section 7 for
        the phase order.
      </p>
    </div>
  )
}

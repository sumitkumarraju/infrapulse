import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/Button'
import { checkSession, signIn } from '@/data/auth'
import { isLive } from '@/data'

/**
 * The gate in front of the engineer dashboard.
 *
 * Only real when the app is pointed at a server: the mock has no backend to
 * authenticate against, so a login screen there would be theatre guarding data
 * that is already in the page. `checkSession` returns true in that mode and
 * this renders nothing of its own.
 */
export function RequireOperator({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const { data: signedIn, isLoading } = useQuery({
    queryKey: ['session'],
    queryFn: checkSession,
    staleTime: 60_000,
  })

  if (!isLive || signedIn) return <>{children}</>

  if (isLoading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <span className="eyebrow text-accent animate-pulse">
          Checking session
        </span>
      </div>
    )
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)

    const result = await signIn(password)
    setBusy(false)

    if (!result.ok) {
      setError(result.message ?? 'Could not sign in.')
      return
    }

    setPassword('')
    // Everything on the dashboard was refused while signed out, so the caches
    // hold errors rather than data.
    await queryClient.invalidateQueries()
  }

  return (
    <div className="flex min-h-[70vh] items-center justify-center px-6">
      <form
        onSubmit={submit}
        className="border-hairline bg-surface-1 rounded-card flex w-full max-w-sm flex-col gap-4 border p-6"
      >
        <div className="flex flex-col gap-1">
          <span className="eyebrow text-accent">Engineer access</span>
          <h1 className="text-h2">Sign in</h1>
          <p className="text-text-2 text-sm">
            Road condition, work orders and complaints to the authority are
            behind this. Reporting a pothole is not — the driver app needs no
            account.
          </p>
        </div>

        <label className="flex flex-col gap-2">
          <span className="eyebrow">Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            autoFocus
            className="border-hairline bg-surface-2 text-text-1 rounded-control h-11 border px-3"
          />
        </label>

        {error && (
          <p className="text-health-critical text-sm" role="alert">
            {error}
          </p>
        )}

        <Button
          type="submit"
          size="lg"
          disabled={busy || password.length === 0}
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </div>
  )
}

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { BrowserRouter } from 'react-router'
import { Toaster } from 'sonner'

/* All data reaches components through TanStack Query, which in turn reads the
   active DataSource (CLAUDE.md 4.1). No component fetches anything itself, so
   swapping the mock for a real backend touches one file. */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
})

export function Providers({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        {children}
        <Toaster
          theme="dark"
          position="top-right"
          toastOptions={{
            style: {
              background: 'var(--color-surface-1)',
              border: '1px solid var(--color-hairline-strong)',
              color: 'var(--color-text-1)',
              borderRadius: 'var(--radius-card)',
            },
          }}
        />
      </BrowserRouter>
    </QueryClientProvider>
  )
}

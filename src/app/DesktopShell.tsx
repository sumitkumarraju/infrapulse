import { useState } from 'react'
import { NavLink, Outlet } from 'react-router'
import { RequireOperator } from '@/app/RequireOperator'
import { cn } from '@/lib/utils'

const NAV = [
  { to: '/command', label: 'Command' },
  { to: '/forecast', label: 'Forecast' },
  { to: '/budget', label: 'Budget' },
  { to: '/work-orders', label: 'Work orders' },
  { to: '/reports', label: 'Reports' },
  { to: '/escalations', label: 'Escalations' },
]

/**
 * Chrome for the engineer routes. Supports both desktop header
 * and responsive mobile hamburger menu.
 */
export function DesktopShell() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  return (
    <div className="bg-base flex min-h-screen flex-col">
      <header className="border-hairline bg-surface-1 relative z-40 flex h-14 shrink-0 items-center justify-between border-b px-4 md:px-6">
        <NavLink to="/" className="flex items-center gap-2">
          <span
            aria-hidden
            className="bg-accent size-2 rounded-full shadow-[0_0_12px_var(--color-accent)]"
          />
          <span className="text-h3 tracking-[-0.01em]">InfraPulse</span>
        </NavLink>

        {/* Desktop Nav */}
        <nav className="hidden md:flex items-center gap-1" aria-label="Main">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                cn(
                  'rounded-control text-text-2 px-3 py-2 text-sm transition-colors duration-[120ms]',
                  'hover:bg-surface-2 hover:text-text-1',
                  isActive && 'bg-accent-wash text-accent',
                )
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        {/* Desktop right items */}
        <div className="hidden md:flex items-center gap-3">
          <NavLink to="/app" className="eyebrow hover:text-text-1 flex items-center gap-1">
            <span>🚗</span> Driver app
          </NavLink>
          <NavLink to="/styleguide" className="eyebrow hover:text-text-1">
            Styleguide
          </NavLink>
        </div>

        {/* Mobile quick actions & hamburger */}
        <div className="flex md:hidden items-center gap-2">
          <NavLink
            to="/app"
            className="rounded-full bg-cyan-900/40 border border-cyan-500/30 px-3 py-1 text-xs font-semibold text-cyan-300 flex items-center gap-1"
          >
            <span>🚗</span> App
          </NavLink>
          <button
            type="button"
            onClick={() => setMobileMenuOpen((o) => !o)}
            className="flex size-9 items-center justify-center rounded-lg border border-hairline bg-surface-2 text-text-1 active:scale-95"
            aria-label="Toggle navigation menu"
          >
            {mobileMenuOpen ? '✕' : '☰'}
          </button>
        </div>
      </header>

      {/* Mobile navigation dropdown */}
      {mobileMenuOpen && (
        <div className="md:hidden border-b border-hairline bg-surface-1/95 px-4 py-3 backdrop-blur-md">
          <nav className="flex flex-col gap-1">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                onClick={() => setMobileMenuOpen(false)}
                className={({ isActive }) =>
                  cn(
                    'rounded-control text-text-2 px-3 py-2.5 text-sm font-medium transition-colors',
                    'hover:bg-surface-2 hover:text-text-1',
                    isActive && 'bg-accent-wash text-accent font-semibold',
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}
            <div className="my-2 border-t border-hairline" />
            <NavLink
              to="/app"
              onClick={() => setMobileMenuOpen(false)}
              className="rounded-control text-cyan-400 px-3 py-2.5 text-sm font-medium hover:bg-surface-2 flex items-center gap-2"
            >
              <span>🚗</span> Open Driver App
            </NavLink>
            <NavLink
              to="/styleguide"
              onClick={() => setMobileMenuOpen(false)}
              className="rounded-control text-text-2 px-3 py-2 text-xs hover:bg-surface-2"
            >
              Styleguide
            </NavLink>
          </nav>
        </div>
      )}

      <main className="flex-1">
        <RequireOperator>
          <Outlet />
        </RequireOperator>
      </main>
    </div>
  )
}

import { NavLink, Outlet } from 'react-router'
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
 * Chrome for the engineer routes. Deliberately thin: on `/command` the map owns
 * the viewport and this bar is the only opaque element on screen.
 */
export function DesktopShell() {
  return (
    <div className="bg-base flex min-h-screen flex-col">
      <header className="border-hairline bg-surface-1 flex h-14 shrink-0 items-center gap-6 border-b px-6">
        <NavLink to="/" className="flex items-center gap-2">
          <span
            aria-hidden
            className="bg-accent size-2 rounded-full shadow-[0_0_12px_var(--color-accent)]"
          />
          <span className="text-h3 tracking-[-0.01em]">InfraPulse</span>
        </NavLink>

        <nav className="flex items-center gap-1" aria-label="Main">
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

        <div className="ml-auto flex items-center gap-3">
          <NavLink to="/app" className="eyebrow hover:text-text-1">
            Driver app
          </NavLink>
          <NavLink to="/styleguide" className="eyebrow hover:text-text-1">
            Styleguide
          </NavLink>
        </div>
      </header>

      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  )
}

import { NavLink, Outlet } from 'react-router'
import { cn } from '@/lib/utils'

const TABS = [
  { to: '/app', label: 'Drive', end: true },
  { to: '/app/report', label: 'Report', end: false },
  { to: '/app/impact', label: 'Impact', end: false },
]

/**
 * The driver and citizen app. Light theme for sunlight, 48px touch targets,
 * and the primary action always inside thumb reach (UI_DESIGN 5.8).
 */
export function MobileShell() {
  return (
    <div className="theme-mobile bg-base flex min-h-screen flex-col">
      <main className="flex-1 pb-20">
        <Outlet />
      </main>

      <nav
        className="border-hairline bg-surface-1 fixed inset-x-0 bottom-0 z-40 flex border-t"
        aria-label="Driver app"
      >
        {TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.end}
            className={({ isActive }) =>
              cn(
                'flex min-h-[56px] flex-1 flex-col items-center justify-center gap-0.5 text-xs tracking-[0.06em] uppercase',
                isActive ? 'text-accent' : 'text-text-2',
              )
            }
          >
            {({ isActive }) => (
              <>
                <span
                  aria-hidden
                  className={cn(
                    'size-1.5 rounded-full',
                    isActive ? 'bg-accent' : 'bg-transparent',
                  )}
                />
                {tab.label}
              </>
            )}
          </NavLink>
        ))}
      </nav>
    </div>
  )
}

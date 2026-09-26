import { useCallback, useEffect, useRef, useState } from 'react'

/* Keeping the screen awake for the length of a trip.
 *
 * This is not a nicety. A PWA stops receiving `DeviceMotion` the moment it is
 * backgrounded or the screen locks — the browser suspends the page — so a phone
 * that dims after thirty seconds records thirty seconds of road and then
 * silently records nothing. There is no event for it and no error: the trip
 * just goes quiet, and the driver finds out at the end.
 *
 * Background collection is the one thing a native app can do here that a web
 * app cannot. A wake lock is what makes the web version workable instead: the
 * phone is mounted on the windscreen anyway, and the driver has deliberately
 * tapped "Start Trip".
 */

export type WakeLockState =
  | 'idle'
  | 'active'
  /** The API exists but the request was refused — low battery, usually. */
  | 'denied'
  /** No Screen Wake Lock API at all (older iOS, some desktop browsers). */
  | 'unsupported'

export function useWakeLock() {
  const [state, setState] = useState<WakeLockState>(() =>
    typeof navigator !== 'undefined' && 'wakeLock' in navigator
      ? 'idle'
      : 'unsupported',
  )

  const sentinel = useRef<WakeLockSentinel | null>(null)
  /** Whether the caller currently wants the screen held on. */
  const wanted = useRef(false)

  const acquire = useCallback(async () => {
    if (!('wakeLock' in navigator)) {
      setState('unsupported')
      return
    }

    try {
      sentinel.current = await navigator.wakeLock.request('screen')
      setState('active')

      // The browser drops the lock on its own when the page is hidden, and does
      // not restore it. Track that so the UI never claims the screen is being
      // held when it is not.
      sentinel.current.addEventListener('release', () => {
        sentinel.current = null
        setState((current) => (current === 'active' ? 'idle' : current))
      })
    } catch {
      // Refused, typically because the battery is low. Not worth an error
      // state that interrupts a drive.
      setState('denied')
    }
  }, [])

  const request = useCallback(async () => {
    wanted.current = true
    await acquire()
  }, [acquire])

  const release = useCallback(async () => {
    wanted.current = false
    try {
      await sentinel.current?.release()
    } catch {
      // Already gone.
    }
    sentinel.current = null
    setState((current) => (current === 'active' ? 'idle' : current))
  }, [])

  /* Coming back to the tab is the moment to take the lock again — the browser
     released it on the way out and will not do it for us. */
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && wanted.current) {
        void acquire()
      }
    }

    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [acquire])

  useEffect(() => {
    return () => {
      wanted.current = false
      void sentinel.current?.release().catch(() => undefined)
    }
  }, [])

  return { state, request, release }
}

/* Real bump detection, running in the browser on the phone's own sensors.
 *
 * The algorithm is the one in CLAUDE.md section 5:
 *   1. Low-pass the accelerometer to estimate gravity.
 *   2. Project acceleration onto gravity to get the vertical component, so the
 *      phone can sit at any angle in the cradle.
 *   3. Call a spike when it exceeds max(6 m/s², running mean + 4 standard
 *      deviations) — an absolute floor so a smooth road cannot make the
 *      detector hypersensitive, and an adaptive term so a rough one does not
 *      fire continuously.
 *   4. Ignore everything below 3 m/s, because a stationary phone being picked
 *      up looks exactly like a pothole.
 *   5. Hold off 1.5s after a hit, so one pothole is one bump.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { MockLiveStream } from '@/data/mock/live'
import { BumpUploader } from '@/features/driver/sensors/BumpUploader'

const GRAVITY_ALPHA = 0.85
const WINDOW = 120
const ABSOLUTE_FLOOR = 6
const SIGMA_MULTIPLIER = 4
const MIN_SPEED_MS = 3
const COOLDOWN_MS = 1500

export interface DetectedBump {
  at: number
  magnitude: number
  position: [number, number] | null
  /** Speed at the moment of impact — the server stores it with the reading. */
  speedMs?: number
}

export interface SensorState {
  supported: boolean
  permission: 'unknown' | 'granted' | 'denied'
  running: boolean
  /** Vertical acceleration, m/s², for the seismograph. */
  vertical: number
  history: number[]
  speedMs: number
  position: [number, number] | null
  heading: { alpha: number; beta: number; gamma: number }
  bumps: DetectedBump[]
  distanceM: number
}

const EMPTY: SensorState = {
  supported: typeof window !== 'undefined' && 'DeviceMotionEvent' in window,
  permission: 'unknown',
  running: false,
  vertical: 0,
  history: [],
  speedMs: 0,
  position: null,
  heading: { alpha: 0, beta: 0, gamma: 0 },
  bumps: [],
  distanceM: 0,
}

export function useBumpDetection(segmentIdForDemo: number | null = null) {
  const [state, setState] = useState<SensorState>(EMPTY)

  const gravity = useRef({ x: 0, y: 0, z: 9.81 })
  const samples = useRef<number[]>([])
  const lastBump = useRef(0)
  const lastPosition = useRef<GeolocationCoordinates | null>(null)
  const watchId = useRef<number | null>(null)
  const simulating = useRef<ReturnType<typeof setInterval> | null>(null)
  const uploader = useRef(new BumpUploader())

  const recordBump = useCallback(
    (magnitude: number, position: [number, number] | null, speedMs = 0) => {
      const bump: DetectedBump = {
        at: Date.now(),
        magnitude,
        position,
        speedMs,
      }
      setState((s) => ({ ...s, bumps: [bump, ...s.bumps].slice(0, 200) }))

      // Batched to the API when one is configured; a no-op otherwise.
      uploader.current.add(bump)

      if (navigator.vibrate) navigator.vibrate(40)

      // Push it to any dashboard open in another tab of this browser.
      MockLiveStream.broadcast({
        type: 'bump',
        segmentId: segmentIdForDemo ?? -1,
        at: new Date(bump.at).toISOString(),
        magnitude: Math.round(magnitude * 10) / 10,
        position: position ?? [76.575, 30.768],
        real: true,
      })
    },
    [segmentIdForDemo],
  )

  const onMotion = useCallback(
    (event: DeviceMotionEvent) => {
      const acceleration = event.accelerationIncludingGravity
      if (!acceleration) return

      const x = acceleration.x ?? 0
      const y = acceleration.y ?? 0
      const z = acceleration.z ?? 0

      // Low-pass: whatever is left after the shaking is gravity.
      gravity.current = {
        x: GRAVITY_ALPHA * gravity.current.x + (1 - GRAVITY_ALPHA) * x,
        y: GRAVITY_ALPHA * gravity.current.y + (1 - GRAVITY_ALPHA) * y,
        z: GRAVITY_ALPHA * gravity.current.z + (1 - GRAVITY_ALPHA) * z,
      }

      const g = gravity.current
      const gMagnitude = Math.hypot(g.x, g.y, g.z) || 9.81
      // Project onto gravity, then subtract it: what is left is the road.
      const vertical = (x * g.x + y * g.y + z * g.z) / gMagnitude - gMagnitude

      const window_ = samples.current
      window_.push(vertical)
      if (window_.length > WINDOW) window_.shift()

      const mean = window_.reduce((a, b) => a + b, 0) / window_.length
      const variance =
        window_.reduce((a, b) => a + (b - mean) ** 2, 0) /
        Math.max(1, window_.length - 1)
      const threshold = Math.max(
        ABSOLUTE_FLOOR,
        mean + SIGMA_MULTIPLIER * Math.sqrt(variance),
      )

      setState((s) => ({
        ...s,
        vertical,
        history: [...s.history.slice(-179), vertical],
      }))

      const now = Date.now()
      const coords = lastPosition.current
      const fastEnough = (coords?.speed ?? 0) >= MIN_SPEED_MS

      if (
        Math.abs(vertical) > threshold &&
        now - lastBump.current > COOLDOWN_MS &&
        fastEnough
      ) {
        lastBump.current = now
        recordBump(
          Math.abs(vertical),
          coords ? [coords.longitude, coords.latitude] : null,
          coords?.speed ?? 0,
        )
      }
    },
    [recordBump],
  )

  const onOrientation = useCallback((event: DeviceOrientationEvent) => {
    setState((s) => ({
      ...s,
      heading: {
        alpha: event.alpha ?? 0,
        beta: event.beta ?? 0,
        gamma: event.gamma ?? 0,
      },
    }))
  }, [])

  const start = useCallback(async () => {
    // iOS requires the permission request to happen inside the tap itself.
    const motionEvent = DeviceMotionEvent as typeof DeviceMotionEvent & {
      requestPermission?: () => Promise<PermissionState>
    }

    if (typeof motionEvent?.requestPermission === 'function') {
      try {
        const result = await motionEvent.requestPermission()
        if (result !== 'granted') {
          setState((s) => ({ ...s, permission: 'denied' }))
          return false
        }
      } catch {
        setState((s) => ({ ...s, permission: 'denied' }))
        return false
      }
    }

    window.addEventListener('devicemotion', onMotion)
    window.addEventListener('deviceorientation', onOrientation)

    if ('geolocation' in navigator) {
      watchId.current = navigator.geolocation.watchPosition(
        (position) => {
          const previous = lastPosition.current
          lastPosition.current = position.coords

          setState((s) => {
            let distanceM = s.distanceM
            if (previous) {
              // Equirectangular is plenty over a few metres and far cheaper
              // than haversine at 1Hz.
              const dx =
                (position.coords.longitude - previous.longitude) *
                111_320 *
                Math.cos((position.coords.latitude * Math.PI) / 180)
              const dy =
                (position.coords.latitude - previous.latitude) * 110_540
              distanceM += Math.hypot(dx, dy)
            }
            return {
              ...s,
              speedMs: position.coords.speed ?? 0,
              position: [position.coords.longitude, position.coords.latitude],
              distanceM,
            }
          })
        },
        () => undefined,
        { enableHighAccuracy: true, maximumAge: 1000, timeout: 10_000 },
      )
    }

    setState((s) => ({ ...s, running: true, permission: 'granted' }))
    return true
  }, [onMotion, onOrientation])

  const stop = useCallback(() => {
    // Whatever is still buffered goes now, while the page is certainly alive.
    void uploader.current.flush()
    window.removeEventListener('devicemotion', onMotion)
    window.removeEventListener('deviceorientation', onOrientation)
    if (watchId.current !== null) {
      navigator.geolocation.clearWatch(watchId.current)
      watchId.current = null
    }
    if (simulating.current) {
      clearInterval(simulating.current)
      simulating.current = null
    }
    setState((s) => ({ ...s, running: false }))
  }, [onMotion, onOrientation])

  /** Laptops have no accelerometer, so the demo drives itself instead. */
  const simulate = useCallback(() => {
    if (simulating.current) return
    setState((s) => ({ ...s, running: true, speedMs: 11 }))

    simulating.current = setInterval(() => {
      const base = (Math.random() - 0.5) * 2.4
      const hit = Math.random() < 0.06
      const vertical = hit ? base + 9 + Math.random() * 7 : base

      setState((s) => ({
        ...s,
        vertical,
        history: [...s.history.slice(-179), vertical],
        distanceM: s.distanceM + 11 / 20,
      }))

      if (hit && Date.now() - lastBump.current > COOLDOWN_MS) {
        lastBump.current = Date.now()
        recordBump(Math.abs(vertical), null)
      }
    }, 50)
  }, [recordBump])

  const reset = useCallback(() => {
    samples.current = []
    lastBump.current = 0
    setState((s) => ({ ...EMPTY, supported: s.supported }))
  }, [])

  useEffect(() => stop, [stop])

  return { state, start, stop, simulate, reset }
}

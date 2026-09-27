/* Reading the phone's sensors, and recording what they said.
 *
 * The detection itself lives in shared/bumpDetector.ts as a pure state machine.
 * This hook is the plumbing around it: permissions, event listeners, GPS, and
 * an optional recorder that keeps every raw sample so a drive can be replayed
 * through different settings afterwards instead of being re-driven.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { MockLiveStream } from '@/data/mock/live'
import { BumpUploader } from '@/features/driver/sensors/BumpUploader'
import {
  BumpDetector,
  DEFAULT_DETECTOR_CONFIG,
  TRACE_VERSION,
  type RawSample,
  type Trace,
} from '@shared/bumpDetector'

/** A ten-minute drive at 60Hz is ~36,000 samples, about 2MB of JSON. */
const MAX_RECORDED_SAMPLES = 120_000

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
  /** True while raw samples are being kept for offline tuning. */
  recording: boolean
  recordedSamples: number
  /** Points the driver marked by hand — ground truth for the replay. */
  markers: number[]
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
  recording: false,
  recordedSamples: 0,
  markers: [],
}

export function useBumpDetection(segmentIdForDemo: number | null = null) {
  const [state, setState] = useState<SensorState>(EMPTY)

  const detector = useRef(new BumpDetector(DEFAULT_DETECTOR_CONFIG))
  const lastPosition = useRef<GeolocationCoordinates | null>(null)
  /** Raw samples, kept only while recording. Never uploaded automatically. */
  const recorded = useRef<RawSample[]>([])
  const recordingRef = useRef(false)
  const markersRef = useRef<number[]>([])
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

      const coords = lastPosition.current
      const sample: RawSample = {
        t: Date.now(),
        x: acceleration.x ?? 0,
        y: acceleration.y ?? 0,
        z: acceleration.z ?? 0,
        speedMs: coords?.speed ?? null,
        lat: coords?.latitude ?? null,
        lon: coords?.longitude ?? null,
      }

      // Recorded before detection, and independently of it: the whole point is
      // to keep what the sensor said, not what this build made of it.
      if (
        recordingRef.current &&
        recorded.current.length < MAX_RECORDED_SAMPLES
      ) {
        recorded.current.push(sample)
      }

      const step = detector.current.push(sample)

      setState((s) => ({
        ...s,
        vertical: step.vertical,
        history: [...s.history.slice(-179), step.vertical],
        recordedSamples: recorded.current.length,
      }))

      if (step.impact) {
        const coords = lastPosition.current
        const position: [number, number] | null =
          step.impact.lon !== null && step.impact.lat !== null
            ? [step.impact.lon, step.impact.lat]
            : coords
              ? [coords.longitude, coords.latitude]
              : null
        recordBump(
          step.impact.magnitude,
          position,
          step.impact.speedMs,
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

const SIMULATED_WAYPOINTS: [number, number][] = [
  [76.575, 30.768],
  [76.5772, 30.7695],
  [76.5805, 30.7715],
  [76.5845, 30.7732],
  [76.5885, 30.7745],
  [76.592, 30.7725],
  [76.59, 30.769],
  [76.5855, 30.7665],
  [76.5805, 30.7655],
  [76.576, 30.7665],
  [76.575, 30.768],
]

  /**
   * Laptops have no accelerometer, so the demo drives itself — but through the
   * same detector, not around it. Synthetic samples go in as if they had come
   * from a phone lying flat, so the simulated path exercises the real code.
   */
  const simProgress = useRef(0)
  const simSegment = useRef(0)

  const simulate = useCallback(() => {
    if (simulating.current) return
    simProgress.current = 0
    simSegment.current = 0
    const startPos = SIMULATED_WAYPOINTS[0]
    setState((s) => ({ ...s, running: true, speedMs: 11, position: startPos }))

    simulating.current = setInterval(() => {
      // Advance position along simulated waypoints
      const p1 = SIMULATED_WAYPOINTS[simSegment.current]
      const nextIdx = (simSegment.current + 1) % SIMULATED_WAYPOINTS.length
      const p2 = SIMULATED_WAYPOINTS[nextIdx]

      // Segment distance in meters
      const dx = (p2[0] - p1[0]) * 111320 * Math.cos((p1[1] * Math.PI) / 180)
      const dy = (p2[1] - p1[1]) * 110540
      const segDist = Math.hypot(dx, dy) || 100

      // In 50ms at 11m/s, we travel 0.55m
      simProgress.current += (11 * 0.05) / segDist
      if (simProgress.current >= 1) {
        simProgress.current = 0
        simSegment.current = nextIdx
      }

      const curLon = p1[0] + (p2[0] - p1[0]) * simProgress.current
      const curLat = p1[1] + (p2[1] - p1[1]) * simProgress.current
      const simPos: [number, number] = [curLon, curLat]

      const hit = Math.random() < 0.012
      const jolt = hit ? 11 + Math.random() * 8 : 0
      const sample: RawSample = {
        t: Date.now(),
        x: (Math.random() - 0.5) * 0.6,
        y: (Math.random() - 0.5) * 0.6,
        // Flat on a dash: gravity on z, road noise on top.
        z: 9.81 + (Math.random() - 0.5) * 2.0 + jolt,
        speedMs: 11,
        lat: curLat,
        lon: curLon,
      }

      if (
        recordingRef.current &&
        recorded.current.length < MAX_RECORDED_SAMPLES
      ) {
        recorded.current.push(sample)
      }

      const step = detector.current.push(sample)

      setState((s) => ({
        ...s,
        position: simPos,
        vertical: step.vertical,
        history: [...s.history.slice(-179), step.vertical],
        distanceM: s.distanceM + 11 / 20,
        recordedSamples: recorded.current.length,
      }))

      if (step.impact) {
        recordBump(step.impact.magnitude, simPos, step.impact.speedMs)
      }
    }, 50)
  }, [recordBump])

  /* --- Raw capture, for calibrating against a real road ----------------- */

  const startRecording = useCallback(() => {
    recorded.current = []
    markersRef.current = []
    recordingRef.current = true
    setState((s) => ({
      ...s,
      recording: true,
      recordedSamples: 0,
      markers: [],
    }))
  }, [])

  const stopRecording = useCallback(() => {
    recordingRef.current = false
    setState((s) => ({ ...s, recording: false }))
  }, [])

  /**
   * "That was a pothole." Ground truth, tapped by the driver.
   *
   * Without these a replay can only count how many impacts a setting reported,
   * never whether they were the right ones.
   */
  const mark = useCallback(() => {
    const at = Date.now()
    markersRef.current = [...markersRef.current, at]
    setState((s) => ({ ...s, markers: [...s.markers, at] }))
    if (navigator.vibrate) navigator.vibrate([20, 40, 20])
  }, [])

  /** The recorded drive, in the shape scripts/replay-trace.ts expects. */
  const buildTrace = useCallback((notes?: string): Trace | null => {
    const samples = recorded.current
    if (samples.length < 2) return null

    const seconds = (samples[samples.length - 1].t - samples[0].t) / 1000
    return {
      version: TRACE_VERSION,
      recordedAt: new Date(samples[0].t).toISOString(),
      config: detector.current.config,
      device: {
        userAgent: navigator.userAgent,
        // Measured rather than assumed: phones vary, and throttle.
        sampleRateHz:
          seconds > 0 ? Math.round((samples.length / seconds) * 10) / 10 : 0,
      },
      samples,
      markers: markersRef.current.map((at) => ({ at })),
      notes,
    }
  }, [])

  /** Saves the trace to the phone. Nothing is uploaded. */
  const downloadTrace = useCallback(
    (notes?: string) => {
      const trace = buildTrace(notes)
      if (!trace) return false

      const blob = new Blob([JSON.stringify(trace)], {
        type: 'application/json',
      })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `infrapulse-trace-${trace.recordedAt.replace(/[:.]/g, '-')}.json`
      link.click()
      URL.revokeObjectURL(url)
      return true
    },
    [buildTrace],
  )

  const reset = useCallback(() => {
    detector.current.reset()
    recorded.current = []
    markersRef.current = []
    recordingRef.current = false
    setState((s) => ({ ...EMPTY, supported: s.supported }))
  }, [])

  useEffect(() => stop, [stop])

  return {
    state,
    start,
    stop,
    simulate,
    reset,
    startRecording,
    stopRecording,
    mark,
    downloadTrace,
  }
}

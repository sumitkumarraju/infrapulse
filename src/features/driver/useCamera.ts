import { useCallback, useEffect, useRef, useState } from 'react'

/* The phone's camera, for reporting a pothole you are standing next to.
 *
 * getUserMedia needs a secure context, exactly like the motion sensors, so
 * this works on https or localhost and nowhere else. On a laptop it will find
 * a webcam; on a phone it asks for the rear camera, because nobody photographs
 * a road with the selfie lens.
 */

export type CameraState =
  | 'idle'
  | 'starting'
  | 'live'
  /** No camera, or the browser will not expose one here. */
  | 'unavailable'
  /** The person said no. */
  | 'denied'

/** Long edge of the captured image. Enough to see a pothole, small to upload. */
const MAX_EDGE = 1280
const JPEG_QUALITY = 0.82

export function useCamera() {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [state, setState] = useState<CameraState>('idle')
  const [error, setError] = useState<string | null>(null)

  const stop = useCallback(() => {
    // Tracks have to be stopped explicitly or the camera light stays on after
    // the screen is gone, which people rightly find alarming.
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
    setState('idle')
  }, [])

  const start = useCallback(async () => {
    setError(null)

    if (!navigator.mediaDevices?.getUserMedia) {
      setState('unavailable')
      setError(
        window.isSecureContext
          ? 'This browser will not give the page a camera.'
          : 'A camera needs a secure connection. Open this over HTTPS.',
      )
      return
    }

    setState('starting')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          // Rear camera where there is one; falls back on a laptop.
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      })

      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play().catch(() => undefined)
      }
      setState('live')
    } catch (cause) {
      const name = (cause as DOMException).name
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        setState('denied')
        setError('Camera access was declined.')
      } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        setState('unavailable')
        setError('No camera on this device.')
      } else {
        setState('unavailable')
        setError((cause as Error).message)
      }
    }
  }, [])

  /**
   * Grabs the current frame as a JPEG data URL.
   *
   * Downscaled before encoding: a modern phone shoots 12 megapixels, which is
   * several megabytes of pothole nobody needs and a slow upload on a patchy
   * connection at the roadside.
   */
  const capture = useCallback((): string | null => {
    const video = videoRef.current
    if (!video || !video.videoWidth) return null

    const scale = Math.min(
      1,
      MAX_EDGE / Math.max(video.videoWidth, video.videoHeight),
    )
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(video.videoWidth * scale)
    canvas.height = Math.round(video.videoHeight * scale)

    const context = canvas.getContext('2d')
    if (!context) return null
    context.drawImage(video, 0, 0, canvas.width, canvas.height)

    return canvas.toDataURL('image/jpeg', JPEG_QUALITY)
  }, [])

  // A camera left running when the screen unmounts is a privacy problem, not
  // a leak to tidy up later.
  useEffect(() => stop, [stop])

  return { videoRef, state, error, start, stop, capture }
}

// Live, MyFitnessPal-style barcode scanner (issue #702). Opens the rear
// camera and continuously decodes video frames; on the first UPC/EAN hit
// it vibrates, tears the camera down, and hands the digits to the parent.
//
// Two decode engines (see lib/live-scan.ts for the pure logic):
//   native — BarcodeDetector.detect(video) where the browser supports our
//            formats (Chrome/Android). Cheap → ~10 fps.
//   wasm   — zxing-wasm on a downscaled canvas frame (iOS Safari, which has
//            no BarcodeDetector). Heavier → throttled to ~3 fps.
//
// The image never leaves the device — only the decoded number is sent.
// When getUserMedia is unavailable or denied we call onFallbackToPhoto so
// the sheet can drop back to the snap-a-photo path.

import { useEffect, useRef, useState } from 'react'
import {
  FORMATS,
  createNativeDetector,
  decodeWasmFrom,
  ensureWasmPrepared,
  nativeDetectorCtor,
  type BarcodeDetectorLike,
} from '../lib/barcode.js'
import {
  acceptDetection,
  chooseEngine,
  newAcceptState,
  pickUpc,
  roiRect,
  shouldAttempt,
  type ScanEngine,
} from '../lib/live-scan.js'

export interface LiveBarcodeScannerProps {
  onDetected: (upc: string) => void
  // Called when the camera can't be used (no getUserMedia, permission
  // denied) or the user opts out — the parent shows the photo path.
  onFallbackToPhoto: (reason?: string) => void
}

// Cap the wasm decode canvas width; full sensor resolution is wasted work
// for a barcode and tanks the frame rate.
const MAX_FRAME_WIDTH = 720

export function LiveBarcodeScanner({ onDetected, onFallbackToPhoto }: LiveBarcodeScannerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [ready, setReady] = useState(false)

  // Latest callbacks via refs so the camera effect can run exactly once
  // (empty deps) without going stale.
  const onDetectedRef = useRef(onDetected)
  const onFallbackRef = useRef(onFallbackToPhoto)
  onDetectedRef.current = onDetected
  onFallbackRef.current = onFallbackToPhoto

  useEffect(() => {
    let stream: MediaStream | null = null
    let rafId = 0
    let cancelled = false
    const accept = newAcceptState()
    let lastAttemptMs = 0
    let engine: ScanEngine = 'wasm'
    let detector: BarcodeDetectorLike | null = null

    function teardown() {
      cancelled = true
      if (rafId) cancelAnimationFrame(rafId)
      rafId = 0
      stream?.getTracks().forEach((t) => t.stop())
      stream = null
    }

    async function chooseEngineForDevice(): Promise<ScanEngine> {
      const ctor = nativeDetectorCtor()
      if (!ctor) return 'wasm'
      try {
        const supported = (await ctor.getSupportedFormats?.()) ?? []
        return chooseEngine(FORMATS.some((f) => supported.includes(f)))
      } catch {
        // Detector exists but the capability probe threw — assume usable.
        return chooseEngine(true)
      }
    }

    async function decodeFrame(video: HTMLVideoElement): Promise<string | null> {
      if (engine === 'native' && detector) {
        try {
          const results = await detector.detect(video)
          return pickUpc(results.map((r) => r.rawValue))
        } catch {
          return null
        }
      }
      const canvas = canvasRef.current
      const roi = roiRect(video.videoWidth, video.videoHeight)
      if (!canvas || !roi) return null
      // Decode only the reticle's center band — fewer pixels for the slow
      // wasm path, more resolution per barcode after the downscale.
      const scale = Math.min(1, MAX_FRAME_WIDTH / roi.sw)
      canvas.width = Math.round(roi.sw * scale)
      canvas.height = Math.round(roi.sh * scale)
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) return null
      ctx.drawImage(video, roi.sx, roi.sy, roi.sw, roi.sh, 0, 0, canvas.width, canvas.height)
      try {
        return await decodeWasmFrom(ctx.getImageData(0, 0, canvas.width, canvas.height))
      } catch {
        return null
      }
    }

    function loop() {
      rafId = requestAnimationFrame(loop)
      const video = videoRef.current
      if (!video || accept.accepted) return
      const now = performance.now()
      if (!shouldAttempt({ nowMs: now, lastAttemptMs, engine })) return
      lastAttemptMs = now
      void decodeFrame(video).then((upc) => {
        if (cancelled) return
        if (acceptDetection(accept, upc, performance.now())) {
          navigator.vibrate?.(50)
          teardown()
          onDetectedRef.current(upc)
        }
      })
    }

    async function start() {
      const md = navigator.mediaDevices
      if (!md?.getUserMedia) {
        onFallbackRef.current('Live camera is not available on this device.')
        return
      }
      try {
        stream = await md.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            // Ask for a sharp feed — barcodes need resolution. `ideal`
            // degrades gracefully on cameras that can't deliver it.
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        })
      } catch {
        onFallbackRef.current('Camera access was blocked — snap a photo instead.')
        return
      }
      // Best-effort continuous autofocus where the camera exposes it —
      // a barcode 10 cm from the lens is useless without it.
      const track = stream.getVideoTracks()[0]
      if (track) {
        const caps = (track.getCapabilities?.() ?? {}) as { focusMode?: string[] }
        if (caps.focusMode?.includes('continuous')) {
          void track
            .applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] })
            .catch(() => {})
        }
      }
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop())
        stream = null
        return
      }
      engine = await chooseEngineForDevice()
      if (engine === 'native') detector = createNativeDetector()
      else void ensureWasmPrepared()

      const video = videoRef.current
      if (!video) {
        teardown()
        return
      }
      video.srcObject = stream
      try {
        await video.play()
      } catch {
        // Muted autoplay is allowed; a rejection here is non-fatal — the
        // loop still reads frames once the stream produces them.
      }
      if (cancelled) return
      setReady(true)
      rafId = requestAnimationFrame(loop)
    }

    void start()
    return teardown
  }, [])

  return (
    <div className="live-scan">
      <div className="live-scan-view">
        <video ref={videoRef} className="live-scan-video" muted playsInline autoPlay />
        <canvas ref={canvasRef} hidden />
        <div className="live-scan-reticle" aria-hidden>
          <span className="live-scan-line" />
        </div>
      </div>
      <span className="scan-t" style={{ textAlign: 'center' }}>
        {ready
          ? 'Point at a barcode — it scans and closes automatically. Only the number is sent.'
          : 'Starting camera…'}
      </span>
      <button type="button" className="fit-startbtn ghost" onClick={() => onFallbackToPhoto()}>
        Use a photo instead
      </button>
    </div>
  )
}

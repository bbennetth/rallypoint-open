// Pure decision logic for the live barcode scanner (issue #702). The
// DOM/camera plumbing lives in ui/LiveBarcodeScanner.tsx; everything that
// can be reasoned about without a camera is extracted here so it's unit
// testable (repo policy: extract the decision, test the decision).

import { asUpc } from './barcode.js'

export type ScanEngine = 'native' | 'wasm'

// Per-engine minimum gap between decode attempts, in ms. The native
// BarcodeDetector is cheap enough to run ~10 fps; the wasm decode is much
// heavier, so we throttle it to ~3 fps to keep the video smooth.
export const ATTEMPT_INTERVAL_MS: Record<ScanEngine, number> = {
  native: 100,
  wasm: 350,
}

/** Native BarcodeDetector when present, else the zxing-wasm fallback. */
export function chooseEngine(hasBarcodeDetector: boolean): ScanEngine {
  return hasBarcodeDetector ? 'native' : 'wasm'
}

export interface ScanTick {
  nowMs: number
  lastAttemptMs: number
  engine: ScanEngine
}

/** Throttle the rAF loop: only decode when enough time has passed since
 *  the last attempt for the active engine. lastAttemptMs = 0 means "never
 *  attempted" and always fires, independent of the clock's origin. */
export function shouldAttempt({ nowMs, lastAttemptMs, engine }: ScanTick): boolean {
  if (lastAttemptMs === 0) return true
  return nowMs - lastAttemptMs >= ATTEMPT_INTERVAL_MS[engine]
}

/** First UPC/EAN-looking value from a detector's raw results, or null. */
export function pickUpc(rawValues: readonly string[]): string | null {
  for (const raw of rawValues) {
    const upc = asUpc(raw)
    if (upc) return upc
  }
  return null
}

// How many decode attempts must agree on the same code, and how close
// together, before we trust it. A single frame can misread (motion blur,
// a second barcode edging into frame) even past the checksum; two
// independent reads of the same code within the window kill that failure
// mode for ~100 ms of added latency on the native engine.
export const CONFIRM_READS = 2
export const CONFIRM_WINDOW_MS = 1500

// The wasm engine decodes a cropped center band instead of the whole
// frame: the reticle guides the barcode to the middle, and halving the
// pixels roughly doubles decode throughput on the slow (iOS) path while
// keeping more resolution per barcode module after the downscale.
export const ROI_HEIGHT_FRACTION = 0.5

export interface RoiRect {
  sx: number
  sy: number
  sw: number
  sh: number
}

/** Source rect for the wasm decode: full width, vertically-centered band
 *  of ROI_HEIGHT_FRACTION of the frame. Degenerate frames (zero either
 *  way) return null — skip the attempt. */
export function roiRect(videoWidth: number, videoHeight: number): RoiRect | null {
  if (!(videoWidth > 0) || !(videoHeight > 0)) return null
  const sh = Math.max(1, Math.round(videoHeight * ROI_HEIGHT_FRACTION))
  return { sx: 0, sy: Math.round((videoHeight - sh) / 2), sw: videoWidth, sh }
}

export interface AcceptState {
  accepted: boolean
  candidate: string | null
  candidateReads: number
  candidateAtMs: number
}

export function newAcceptState(): AcceptState {
  return { accepted: false, candidate: null, candidateReads: 0, candidateAtMs: 0 }
}

/** Consistency gate: a non-null UPC is accepted only once CONFIRM_READS
 *  attempts agree on it within CONFIRM_WINDOW_MS of the previous read. A
 *  different code, or a stale candidate outside the window, restarts the
 *  count. Once accepted the state latches — later frames (e.g. one that
 *  decodes a second barcode mid-teardown) can never fire again. */
export function acceptDetection(
  state: AcceptState,
  upc: string | null,
  nowMs: number,
): upc is string {
  if (state.accepted || upc === null) return false
  const continues =
    state.candidate === upc && nowMs - state.candidateAtMs <= CONFIRM_WINDOW_MS
  state.candidate = upc
  state.candidateReads = continues ? state.candidateReads + 1 : 1
  state.candidateAtMs = nowMs
  if (state.candidateReads < CONFIRM_READS) return false
  state.accepted = true
  return true
}

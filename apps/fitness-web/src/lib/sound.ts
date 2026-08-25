// Tiny WebAudio beeper for the rest-timer countdown. No <audio> assets:
// an OscillatorNode + GainNode envelope fires synchronously and dodges
// autoplay-policy friction — as long as the AudioContext was created/
// resumed inside a user gesture. Call unlockAudio() from a tap handler
// (completing a set counts) before the first beep is needed.

let ctx: AudioContext | null = null

/** Create/resume the shared AudioContext. MUST be called from a user
 *  gesture at least once (iOS suspends contexts created outside one).
 *  Safe to call repeatedly. */
export function unlockAudio(): void {
  try {
    ctx ??= new AudioContext()
    if (ctx.state === 'suspended') void ctx.resume()
  } catch {
    // No WebAudio (very old browser) — beeps silently no-op.
    ctx = null
  }
}

/** Best-effort resume of an ALREADY-unlocked context — iOS re-suspends
 *  contexts on screen lock / backgrounding, so call this when the tab
 *  regains visibility. Unlike unlockAudio(), never creates a context
 *  (that only sticks inside a user gesture). */
export function resumeAudio(): void {
  try {
    if (ctx && ctx.state === 'suspended') void ctx.resume()
  } catch {
    /* ignore — beeps just stay silent */
  }
}

function beep(freqHz: number, durationMs: number, peakGain: number): void {
  if (!ctx || ctx.state !== 'running') return
  try {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    const t0 = ctx.currentTime
    const t1 = t0 + durationMs / 1000
    osc.type = 'square'
    osc.frequency.value = freqHz
    // Short attack/decay envelope so the square wave doesn't click.
    gain.gain.setValueAtTime(0, t0)
    gain.gain.linearRampToValueAtTime(peakGain, t0 + 0.01)
    gain.gain.setValueAtTime(peakGain, t1 - 0.03)
    gain.gain.linearRampToValueAtTime(0, t1)
    osc.connect(gain).connect(ctx.destination)
    osc.start(t0)
    osc.stop(t1)
  } catch {
    /* never let a sound failure break the session UI */
  }
}

/** One tick of the 5-4-3-2-1 countdown. */
export function countdownBeep(): void {
  beep(880, 110, 0.07)
}

/** The "go" tone when rest naturally hits zero. */
export function goTone(): void {
  beep(1320, 320, 0.09)
}

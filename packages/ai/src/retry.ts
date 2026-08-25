// Bounded retry for transient Workers AI capacity/rate errors. The AI
// binding surfaces provider capacity pressure as AiError 3040 / httpCode
// 429 ("Capacity temporarily exceeded, please try again") — a transient
// condition that usually clears within a second. Retrying the inference
// (no image re-upload — the bytes are already server-side) turns most of
// these into a transparent success the user never sees.
//
// The budget is deliberately tight: retries add latency to an already
// slow model call, and the browser client drops a too-slow connection
// as a bare "Load failed". Two quick retries cover a brief capacity blip
// without pushing the request into the drop zone.
//
// Lifted verbatim from apps/fitness-api/src/lib/ai-retry.ts (which now
// re-exports from here) so every AI-consuming app shares one copy.

export interface AiRetryConfig {
  /** Retries AFTER the first attempt. Total attempts = maxRetries + 1. */
  maxRetries: number
  baseDelayMs: number
  maxDelayMs: number
}

export const DEFAULT_AI_RETRY: AiRetryConfig = {
  maxRetries: 2,
  baseDelayMs: 300,
  maxDelayMs: 1200,
}

// Read whatever numeric error code the binding exposes. The exact thrown
// shape varies across binding versions (some carry `code`, some
// `httpCode`/`internalCode`, some only a prefixed message), so probe them
// all and fall back to a leading numeric code in the message
// ("3040: Capacity temporarily exceeded" → "3040").
export function aiErrorCode(err: unknown): string | undefined {
  if (err === null || typeof err !== 'object') return undefined
  const e = err as Record<string, unknown>
  for (const key of ['code', 'internalCode', 'httpCode', 'status', 'statusCode'] as const) {
    const v = e[key]
    if (typeof v === 'number') return String(v)
    if (typeof v === 'string' && v.trim() !== '') return v
  }
  const msg = typeof e['message'] === 'string' ? (e['message'] as string) : ''
  const m = msg.match(/\b(\d{3,4})\b/)
  return m ? m[1] : undefined
}

// Detect the transient capacity/rate class broadly: match any numeric
// 3040/429 code field AND the message text. Deterministic parse failures
// (no JSON, schema mismatch) must NOT match — retrying those just
// re-burns the model with the same bad result.
export function isCapacityError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false
  const e = err as Record<string, unknown>
  for (const key of ['code', 'internalCode', 'httpCode', 'status', 'statusCode'] as const) {
    const v = e[key]
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
    if (n === 3040 || n === 429) return true
  }
  // Message fallback: the canonical 3040 text is "Capacity temporarily
  // exceeded". Anchor on the numeric code or the word "capacity" — a bare
  // "temporarily" (or any other single generic word) is too broad and
  // could false-positive on a future non-capacity error.
  const msg = typeof e['message'] === 'string' ? (e['message'] as string) : ''
  return /\b3040\b/.test(msg) || /\b429\b/.test(msg) || /capacity/i.test(msg)
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

export interface RetryHooks {
  config?: AiRetryConfig
  /** Injected for tests; defaults to a real setTimeout sleep. */
  sleep?: (ms: number) => Promise<void>
  /** Injected for tests; defaults to Math.random for jitter. */
  random?: () => number
  onRetry?: (info: { attempt: number; delayMs: number; err: unknown }) => void
}

/** Run `fn`, retrying only on {@link isCapacityError} up to the config's
 *  budget with exponential backoff + full jitter. Any non-capacity error
 *  (or the final capacity error once the budget is spent) is rethrown
 *  unchanged. */
export async function withCapacityRetry<T>(
  fn: () => Promise<T>,
  hooks: RetryHooks = {},
): Promise<T> {
  const cfg = hooks.config ?? DEFAULT_AI_RETRY
  const sleep = hooks.sleep ?? defaultSleep
  const random = hooks.random ?? Math.random
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (attempt >= cfg.maxRetries || !isCapacityError(err)) throw err
      const ceiling = Math.min(cfg.maxDelayMs, cfg.baseDelayMs * 2 ** attempt)
      // Full jitter over [ceiling/2, ceiling] — spread retries so a fleet
      // of clients doesn't resynchronise its retry storm on the provider.
      const delayMs = Math.round(ceiling / 2 + random() * (ceiling / 2))
      hooks.onRetry?.({ attempt: attempt + 1, delayMs, err })
      await sleep(delayMs)
    }
  }
}

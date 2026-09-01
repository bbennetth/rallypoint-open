// Pure helpers for the "Analyze older entries" bulk backfill (Brain Dump
// Part 2): selecting which un-analyzed stream rows are eligible, pacing the
// per-entry enrich calls under the enrich route's rate limit, running the
// loop itself (runBackfill), and shaping the note→braindump conversion
// input. No DOM/React — driven by BrainDumpPage.tsx, which supplies the
// per-entry analyze/sleep/cancel primitives. Unit-tested in
// braindump-backfill.test.ts.

import { ApiError } from '@rallypoint/web-kit'
import type { StreamEntry } from './braindump-helpers.js'

// The text an entry would be analyzed on: body when it carries real
// content, else the title. Null only when there's no text at all — the
// server's EnrichRequestSchema requires just a non-empty trimmed string
// (min 1), and the per-entry Analyze button has no floor of its own.
export function analyzableText(entry: StreamEntry): string | null {
  const body = (entry.body ?? '').trim()
  if (body !== '') return body
  const title = entry.title.trim()
  if (title !== '') return title
  return null
}

// Bulk backfill skips bare headings (title-only, no body, under this
// length) to save rate-limit budget — the per-entry button has no floor,
// matching the server's min(1).
const MIN_BULK_ANALYZABLE_CHARS = 10

// Default/max entries processed by one backfill run — also the run cap the
// bulk button's label compares the true (uncapped) eligible count against.
export const DEFAULT_BACKFILL_LIMIT = 25

// Un-analyzed rows worth offering to the bulk backfill, newest-first order
// preserved from the input stream, capped at `limit`. Diary and braindump
// rows need a listId to save back to (guards a stream built before the
// owning list resolved); notes are converted so they don't need one.
export function selectUnanalyzed(
  entries: readonly StreamEntry[],
  limit = DEFAULT_BACKFILL_LIMIT,
): StreamEntry[] {
  const out: StreamEntry[] = []
  for (const entry of entries) {
    if (entry.analysis) continue
    const text = analyzableText(entry)
    if (text === null || text.length < MIN_BULK_ANALYZABLE_CHARS) continue
    if (entry.source !== 'note' && entry.listId === null) continue
    out.push(entry)
    if (out.length >= limit) break
  }
  return out
}

// Pacing between backfill iterations: the enrich route is rate-limited
// 15/min per user; 5s between calls keeps the loop at 12/min. A 429 backs
// off a full minute before retrying the next entry.
export const BACKFILL_DELAY_MS = 5000
export const RATE_LIMIT_BACKOFF_MS = 60000

export function backfillDelayMs(err: unknown): number {
  if (err instanceof ApiError && err.status === 429) return RATE_LIMIT_BACKOFF_MS
  return BACKFILL_DELAY_MS
}

// Classifies one enrich failure for the bulk backfill loop: 'rate-limited'
// (429) retries the SAME entry after the minute backoff rather than
// advancing past it; 'fatal' (401/403) aborts the whole run — auth/
// permission failures won't clear up by burning through the remaining
// entries one-by-one; anything else just counts as a failed entry and moves
// on.
export type BackfillErrorClass = 'rate-limited' | 'fatal' | 'skip'

export function classifyBackfillError(err: unknown): BackfillErrorClass {
  if (err instanceof ApiError) {
    if (err.status === 429) return 'rate-limited'
    if (err.status === 401 || err.status === 403) return 'fatal'
  }
  return 'skip'
}

// Auth/permission failures abort the whole run rather than burning through
// the remaining entries one-by-one.
export function isFatalBackfillError(err: unknown): boolean {
  return classifyBackfillError(err) === 'fatal'
}

export function backfillProgressLabel(s: {
  done: number
  failed: number
  total: number
  running: boolean
  /** True when the run ended early via the Stop button rather than
   *  finishing all `total` entries (a fatal-error abort keeps surfacing its
   *  own error instead). */
  stopped?: boolean
  /** True when the run ended early because of a fatal (401/403) error — the
   *  error message is already surfaced separately, so this renders a
   *  distinct "stopped due to an error" line instead of a success-shaped
   *  one. */
  aborted?: boolean
}): string {
  if (s.running) return `Analyzing ${s.done + s.failed + 1} of ${s.total}…`
  if (s.aborted) return `Stopped due to an error — analyzed ${s.done} of ${s.total}.`
  if (s.stopped) return `Stopped — analyzed ${s.done} of ${s.total}.`
  if (s.failed > 0) {
    return `Analyzed ${s.done} of ${s.total} — ${s.failed} couldn't be analyzed, try again later.`
  }
  return `Analyzed ${s.done} ${s.done === 1 ? 'entry' : 'entries'}.`
}

export interface RunBackfillResult {
  done: number
  failed: number
  cancelled: boolean
  /** Non-null when the run aborted on a fatal (401/403) error rather than
   *  finishing or being cancelled. */
  fatal: unknown | null
}

// Drive the bulk backfill loop: sequential, one entry at a time via
// `analyzeOne`. On a per-entry failure: 'rate-limited' sleeps
// RATE_LIMIT_BACKOFF_MS then retries the SAME entry once (a second failure
// of any kind — including a second rate-limit — counts as failed and moves
// on, except a second 'fatal' which still aborts the whole run); 'fatal'
// aborts immediately, returning the error; 'skip' counts as failed and
// moves on. `isCancelled` is checked before each entry, before each retry
// attempt, and after each sleep so Stop interrupts mid-wait rather than
// only between entries. `onProgress` fires after each entry settles (done
// or failed, not cancelled/fatal); `onRateLimited` fires just before the
// backoff sleep starts, letting the caller surface a "retrying" message —
// the caller is expected to clear it on the next `onProgress`.
export async function runBackfill(opts: {
  targets: readonly StreamEntry[]
  analyzeOne: (entry: StreamEntry) => Promise<void>
  sleep: (ms: number) => Promise<void>
  isCancelled: () => boolean
  onProgress?: (s: { done: number; failed: number }) => void
  onRateLimited?: () => void
}): Promise<RunBackfillResult> {
  const { targets, analyzeOne, sleep, isCancelled, onProgress, onRateLimited } = opts
  let done = 0
  let failed = 0

  for (let i = 0; i < targets.length; i++) {
    if (isCancelled()) return { done, failed, cancelled: true, fatal: null }
    const entry = targets[i]!

    let settled: 'done' | 'failed' | 'fatal' | 'cancelled' = 'failed'
    let fatalErr: unknown = null
    let sawRateLimit = false
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await analyzeOne(entry)
        settled = 'done'
        break
      } catch (err) {
        const cls = classifyBackfillError(err)
        if (cls === 'fatal') {
          settled = 'fatal'
          fatalErr = err
          break
        }
        if (cls === 'rate-limited') sawRateLimit = true
        if (cls === 'rate-limited' && attempt === 0) {
          onRateLimited?.()
          await sleep(backfillDelayMs(err))
          if (isCancelled()) {
            settled = 'cancelled'
            break
          }
          continue
        }
        settled = 'failed'
        break
      }
    }

    if (settled === 'cancelled') return { done, failed, cancelled: true, fatal: null }
    if (settled === 'fatal') return { done, failed, cancelled: false, fatal: fatalErr }
    if (settled === 'done') done++
    else failed++
    onProgress?.({ done, failed })

    if (i < targets.length - 1 && !isCancelled()) {
      // An entry that ended in a rate-limit failure means the window is
      // still exhausted — pace the next entry by the full backoff, not the
      // short delay, or the loop burns the rest of the run as failures.
      await sleep(settled === 'failed' && sawRateLimit ? RATE_LIMIT_BACKOFF_MS : BACKFILL_DELAY_MS)
    }
  }

  return { done, failed, cancelled: false, fatal: null }
}

// Shape a converted note into a braindump-create input. Kept dumb-pure: the
// caller supplies the already-resolved custom-field payload (category +
// analysis) via `fields`.
export function noteConversionInput(
  entry: StreamEntry,
  enrichment: { title: string },
  fields: Record<string, unknown>,
): { title: string; notes: string | null; dueDate?: string; customFields: Record<string, unknown> } {
  const trimmedTitle = entry.title.trim()
  return {
    title: trimmedTitle !== '' ? trimmedTitle : enrichment.title,
    notes: entry.body,
    ...(entry.day !== '' ? { dueDate: entry.day } : {}),
    customFields: fields,
  }
}

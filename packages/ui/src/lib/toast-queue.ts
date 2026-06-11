// Pure decision helpers for the toast queue. The component subscribes
// to a small store; this file holds the dequeue + expire math so it
// can be unit-tested without React.

export type ToastTone = 'info' | 'success' | 'error'

export interface ToastInput {
  id?: string
  tone?: ToastTone
  body: string
  /** Auto-dismiss timeout (ms). Pass 0 to require manual dismiss. */
  durationMs?: number
}

export interface Toast {
  id: string
  tone: ToastTone
  body: string
  durationMs: number
  createdAt: number
}

export const DEFAULT_DURATION_MS = 4000
export const MAX_QUEUE_SIZE = 5

// Normalise an input toast into a queue entry. If the input lacks an
// id, derive one from createdAt + a small random suffix so two
// rapid-fire calls in the same millisecond don't collide.
export function makeToast(input: ToastInput, now: number, randomSuffix: string): Toast {
  return {
    id: input.id ?? `t_${now}_${randomSuffix}`,
    tone: input.tone ?? 'info',
    body: input.body,
    durationMs: input.durationMs ?? DEFAULT_DURATION_MS,
    createdAt: now,
  }
}

// Apply queue size cap: if pushing would exceed MAX_QUEUE_SIZE, drop
// the oldest entries. Keeps the toaster from flooding the screen when
// a script accidentally fires hundreds of toasts.
//
// Dedup by id: if a toast with the same id is already enqueued, drop
// the prior copy and use the fresh one in its place. This matters for
// status-y toasts the UI fires repeatedly (e.g. "Copied!", "Saved!") —
// without dedup, mashing the copy button piles up duplicate banners
// instead of refreshing one. Auto-derived ids include a random suffix,
// so callers without an explicit id never collide here.
export function enqueue(queue: ReadonlyArray<Toast>, t: Toast): Toast[] {
  const without = queue.filter((q) => q.id !== t.id)
  const out = [...without, t]
  if (out.length <= MAX_QUEUE_SIZE) return out
  return out.slice(out.length - MAX_QUEUE_SIZE)
}

// Expire any toast whose durationMs window has elapsed. Returns the
// surviving queue (input untouched if nothing expired).
export function expireQueue(queue: ReadonlyArray<Toast>, now: number): Toast[] {
  const survivors = queue.filter(
    (t) => t.durationMs <= 0 || now - t.createdAt < t.durationMs,
  )
  return survivors.length === queue.length ? [...queue] : survivors
}

// Find the soonest auto-expire deadline so the React effect can
// schedule a timeout. Returns null when nothing in the queue
// auto-expires.
export function nextExpireDeadline(
  queue: ReadonlyArray<Toast>,
  now: number,
): number | null {
  let next: number | null = null
  for (const t of queue) {
    if (t.durationMs <= 0) continue
    const deadline = t.createdAt + t.durationMs
    if (deadline <= now) continue
    if (next === null || deadline < next) next = deadline
  }
  return next
}

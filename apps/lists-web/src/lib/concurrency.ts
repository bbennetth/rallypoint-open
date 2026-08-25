// Small concurrency limiter for fan-out network calls (#675). Kanban
// reorders can reindex an entire column in one drop — firing every PATCH
// via an unbounded Promise.all can spike the request count well past
// what's reasonable for a single user action. Runs `tasks` through
// `fn` with at most `limit` in flight at once, preserving each task's
// result at its original index (like Promise.all).
//
// On the first failure it stops dispatching NEW tasks but still awaits the
// ones already in flight before rejecting (with that first error). A naive
// Promise.all rejects the instant one task throws, while sibling PATCHes
// are still in flight; the caller (handleReorder) then reloads to
// reconcile, and those late PATCHes land AFTER the reload — re-mutating
// positions the UI just showed as recovered. Draining first guarantees
// every dispatched PATCH has settled by the time the caller sees the
// rejection. (True fetch cancellation isn't available — ListsApi has no
// AbortSignal — so we drain rather than abort; see lib/offline/outbox.ts.)
export async function runWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  let failed = false
  let firstError: unknown
  async function worker(): Promise<void> {
    // Once any task has failed, stop pulling new items — but the in-flight
    // fn() calls in the other workers run to completion, since JS can't
    // preempt an in-progress await.
    while (next < items.length && !failed) {
      const i = next++
      try {
        results[i] = await fn(items[i] as T, i)
      } catch (err) {
        if (!failed) {
          failed = true
          firstError = err
        }
      }
    }
  }
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker())
  await Promise.all(workers)
  if (failed) throw firstError
  return results
}

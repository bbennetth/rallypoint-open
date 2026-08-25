// Cancellable-fetch lifecycle for SPA pages (epic #675 R5).
//
// The recurring client bug class: a fetch kicked off in an effect (or a
// pull-to-refresh / user action) resolves AFTER a newer fetch for the
// same slot, and its stale payload overwrites the fresh one — or keeps
// running after the component unmounted. Every page hand-rolling
// `cancelled` booleans is how the class recurs, so this module owns the
// pattern once:
//
//   - `createGenerationGate()` — the pure core. Each `begin()` returns
//     a token whose `stale()` flips true as soon as a newer begin()
//     happens (or the gate is closed). Unit-testable without React.
//   - `useAsyncTask()` — the low-level hook for pages with bespoke
//     state shapes: gives the task an AbortSignal + `stale()` and
//     guarantees at-most-one live generation.
//   - `useAsync()` — the data-shaped convenience for "load T on mount /
//     deps change" pages: { data, error, loading, reload }.
//
// Rules the hooks enforce:
//   - superseded runs are aborted (their fetches get the signal) AND
//     their commits dropped (callers check `stale()`; useAsync does it
//     internally);
//   - unmount closes the gate, so nothing commits after teardown;
//   - `reload`/`run` are stable identities — safe for effect deps and
//     the refresh bus.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

export interface GenerationToken {
  /** True once a newer generation began (or the gate closed). */
  stale: () => boolean
  signal: AbortSignal
}

export interface GenerationGate {
  /** Start a new generation, superseding (and aborting) the previous one. */
  begin: () => GenerationToken
  /** Supersede everything without starting a new generation (unmount). */
  close: () => void
}

export function createGenerationGate(): GenerationGate {
  let gen = 0
  let controller: AbortController | null = null
  return {
    begin() {
      controller?.abort()
      controller = new AbortController()
      const g = ++gen
      const signal = controller.signal
      return { stale: () => g !== gen, signal }
    },
    close() {
      gen++
      controller?.abort()
      controller = null
    },
  }
}

export type AsyncTask = (ctx: GenerationToken) => Promise<void>

/**
 * Low-level: run async work with supersede/abort semantics but keep
 * your own state shape. The task MUST check `ctx.stale()` before every
 * state commit and should pass `ctx.signal` to its fetches.
 *
 * const run = useAsyncTask()
 * const load = useCallback(() => run(async (ctx) => {
 *   const day = await getGroupDay(id, date, { signal: ctx.signal })
 *   if (ctx.stale()) return
 *   setDay(day)
 * }), [run, id, date])
 */
export function useAsyncTask(): (task: AsyncTask) => Promise<void> {
  const gate = useMemo(createGenerationGate, [])
  useEffect(() => () => gate.close(), [gate])
  return useCallback(
    async (task: AsyncTask) => {
      const token = gate.begin()
      try {
        await task(token)
      } catch (err) {
        // Aborted/superseded runs may reject on their way out — that's
        // the mechanism working, not an error the caller can act on.
        if (!token.stale()) throw err
      }
    },
    [gate],
  )
}

export interface AsyncState<T> {
  data: T | null
  error: unknown
  /** True from first run until the first settle; reloads keep old data. */
  loading: boolean
  /** Re-run the loader (stable identity; wire to the refresh bus). */
  reload: () => Promise<void>
}

/**
 * Data-shaped convenience: load `T` on mount and whenever `deps`
 * change; stale resolutions never commit. `fn` receives an AbortSignal
 * to pass through to fetches.
 */
export function useAsync<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
): AsyncState<T> {
  const run = useAsyncTask()
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState(true)

  // Latest-fn ref so `reload` can stay identity-stable while always
  // invoking the current closure (deps changes re-fire via the effect).
  const fnRef = useRef(fn)
  fnRef.current = fn

  const reload = useCallback(
    () =>
      run(async (ctx) => {
        try {
          const result = await fnRef.current(ctx.signal)
          if (ctx.stale()) return
          setData(result)
          setError(null)
          setLoading(false)
        } catch (err) {
          if (ctx.stale()) return
          setError(err)
          setLoading(false)
        }
      }),
    [run],
  )

  useEffect(() => {
    void reload()
    // `deps` is the caller's dependency list, spread by design.
  }, [reload, ...deps])

  return { data, error, loading, reload }
}

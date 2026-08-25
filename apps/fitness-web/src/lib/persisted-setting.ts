// Factory for RPID-backed user preferences: a zustand-persist store
// hydrated from the session probe's app_settings, written through a
// registered persister on change, with the hydration-echo guard (a
// server-applied value must NOT echo a write back through the
// persister) in ONE place. rest-settings.ts and alert-settings.ts are
// thin wrappers over this; units.ts predates it and keeps its own copy
// of the same shape (fold it in when next touched).

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface PersistedSettingStore<T> {
  /** Subscribe a component to the current value. */
  useValue: () => T
  /** Imperative accessors (hydration, tests). */
  get: () => T
  set: (value: T) => void
  /** Register the write-through sink (a PATCH into a settings
   *  namespace, wired in main.tsx). Passing null clears it. */
  registerPersister: (fn: ((value: T) => void) | null) => void
  /** Apply the server-stored value without echoing a write back. */
  hydrateFromServer: (value: unknown) => void
}

export function createPersistedSetting<T>({
  name,
  sanitize,
}: {
  /** localStorage cache key (zustand persist). */
  name: string
  /** Clamp unknown input to a valid value; also supplies the default
   *  (sanitize(undefined)). */
  sanitize: (value: unknown) => T
}): PersistedSettingStore<T> {
  let persister: ((value: T) => void) | null = null
  let hydrating = false

  interface State {
    value: T
    setValue: (value: T) => void
  }

  const useStore = create<State>()(
    persist(
      (set) => ({
        value: sanitize(undefined),
        setValue: (value) => {
          const next = sanitize(value)
          set({ value: next })
          if (!hydrating) {
            try {
              persister?.(next)
            } catch {
              // fire-and-forget: a failed write must never break the UI
            }
          }
        },
      }),
      {
        name,
        partialize: (s) => ({ value: s.value }),
        onRehydrateStorage: () => (state) => {
          if (state) state.value = sanitize(state.value)
        },
      },
    ),
  )

  return {
    useValue: () => useStore((s) => s.value),
    get: () => useStore.getState().value,
    set: (value) => useStore.getState().setValue(value),
    registerPersister: (fn) => {
      persister = fn
    },
    hydrateFromServer: (value) => {
      if (value === undefined) return
      hydrating = true
      try {
        useStore.getState().setValue(sanitize(value))
      } finally {
        hydrating = false
      }
    },
  }
}

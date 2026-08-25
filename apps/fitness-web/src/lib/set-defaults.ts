// Default sets × reps preference for exercises added to a strength
// workout (the mid-session Add-exercise sheet's starting prescription).
// Same shape as rest-settings.ts: thin wrappers over the shared
// createPersistedSetting factory — RPID 'fitness' namespace keys
// `defaultSets` / `defaultReps`, hydrated at session boot, written
// through the persisters registered in main.tsx.

import { createPersistedSetting } from './persisted-setting.js'
import { DEFAULT_SETS } from './composer-state.js'

/** Product default reps for a freshly added exercise (classic 3 × 5). */
export const DEFAULT_REPS = 5

/** The stored reps preference: a whole rep count, or 'max' for
 *  max-effort sets (each added exercise starts with amrapTarget on). */
export type DefaultReps = number | 'max'

/** Clamp unknown input to a whole 1–20 set count; anything unusable
 *  falls back to the classic 3. Mirrors the sheet's sets field range. */
export function sanitizeDefaultSets(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n < 1) return DEFAULT_SETS
  return Math.min(20, Math.round(n))
}

/** Clamp unknown input to a whole 1–999 rep count or the literal
 *  'max' (max-effort sets); anything unusable falls back to the
 *  5-rep product default. */
export function sanitizeDefaultReps(value: unknown): DefaultReps {
  if (value === 'max') return 'max'
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n < 1) return DEFAULT_REPS
  return Math.min(999, Math.round(n))
}

/** The row prescription a stored reps preference implies: 'max' means
 *  a max-effort row (amrapTarget on, achieved count entered live) with
 *  the product-default rep count behind the MAX toggle so switching it
 *  off lands somewhere sane. */
export function repsPrescriptionFromDefault(d: DefaultReps): { reps: number; max: boolean } {
  return d === 'max' ? { reps: DEFAULT_REPS, max: true } : { reps: d, max: false }
}

const setsStore = createPersistedSetting<number>({
  name: 'rp-fitness-default-sets',
  sanitize: sanitizeDefaultSets,
})

const repsStore = createPersistedSetting<DefaultReps>({
  name: 'rp-fitness-default-reps',
  sanitize: sanitizeDefaultReps,
})

export const registerDefaultSetsPersister = setsStore.registerPersister
export const hydrateDefaultSetsFromServer = setsStore.hydrateFromServer
/** The active default set count — subscribes the component to changes. */
export const useDefaultSets = setsStore.useValue
export const setDefaultSets = setsStore.set
export const getDefaultSets = setsStore.get

export const registerDefaultRepsPersister = repsStore.registerPersister
export const hydrateDefaultRepsFromServer = repsStore.hydrateFromServer
/** The active default rep count — subscribes the component to changes. */
export const useDefaultReps = repsStore.useValue
export const setDefaultReps = repsStore.set
export const getDefaultReps = repsStore.get

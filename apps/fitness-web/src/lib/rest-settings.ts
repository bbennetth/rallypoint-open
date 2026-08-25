// Default rest-time preference (seconds between strength sets when a
// block prescribes none). Thin wrapper over the shared
// createPersistedSetting factory — RPID 'fitness' namespace key
// `defaultRestS`, hydrated at session boot, written through the
// persister registered in main.tsx, zustand-persist cache bridging
// first paint → session fold-in.

import { createPersistedSetting } from './persisted-setting.js'

/** Engine default — mirrors strength-session.ts's DEFAULT_REST_S. */
export const DEFAULT_REST_S = 90

/** Clamp unknown input to a whole 0–600 s value; anything unusable
 *  falls back to the 90 s product default. 0 is legitimate ("no auto
 *  rest"). */
export function sanitizeDefaultRestS(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_REST_S
  return Math.min(600, Math.round(n))
}

const store = createPersistedSetting<number>({
  name: 'rp-fitness-default-rest',
  sanitize: sanitizeDefaultRestS,
})

export const registerDefaultRestPersister = store.registerPersister
export const hydrateDefaultRestFromServer = store.hydrateFromServer
/** The active default rest — subscribes the component to changes. */
export const useDefaultRestS = store.useValue
export const setDefaultRestS = store.set
export const getDefaultRestS = store.get

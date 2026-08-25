// Weekly-rhythm preference (which workout type, if any, each weekday is
// assigned). Thin wrapper over the shared createPersistedSetting factory
// — RPID 'fitness' namespace key `dayTypes`, hydrated at session boot,
// written through the persister registered in main.tsx. Mirrors
// rest-settings.ts / alert-settings.ts.

import { normalizeDayTypesMap, type DayKey, type DayTypeValue, type DayTypesMap } from '@rallypoint/fitness-shared'
import { createPersistedSetting } from './persisted-setting.js'

const store = createPersistedSetting<DayTypesMap>({
  name: 'rp-fitness-day-types',
  sanitize: normalizeDayTypesMap,
})

export const registerDayTypesPersister = store.registerPersister
export const hydrateDayTypesFromServer = store.hydrateFromServer
/** The full weekly-rhythm map — subscribes the component to changes. */
export const useDayTypes = store.useValue
export const setDayTypes = store.set
export const getDayTypes = store.get

/** Set (or clear, when `value` is null) a single weekday's assigned workout
 *  type — a preset or a free-text label — without clobbering the other
 *  days. The store's `sanitize` (normalizeDayTypesMap) trims/bounds the
 *  value and drops it if empty, so callers can pass raw user input. */
export function setDayType(day: DayKey, value: DayTypeValue | null): void {
  const next: DayTypesMap = { ...store.get() }
  if (value == null) {
    delete next[day]
  } else {
    next[day] = value
  }
  store.set(next)
}

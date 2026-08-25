// Daily calorie-goal preference (kcal). Thin wrapper over the shared
// createPersistedSetting factory — RPID 'fitness' namespace key
// `calorieGoalKcal`, hydrated at session boot, written through the
// persister registered in main.tsx. `null` = no goal set (the dashboard
// and diary header hide the goal comparison entirely).

import { createPersistedSetting } from './persisted-setting.js'

export const CALORIE_GOAL_MIN = 500
export const CALORIE_GOAL_MAX = 10000

/** Clamp unknown input to a whole 500–10000 kcal goal, or null for
 *  "no goal". Anything unusable (NaN, 0, negative) clears the goal
 *  rather than inventing one. */
export function sanitizeCalorieGoal(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.min(CALORIE_GOAL_MAX, Math.max(CALORIE_GOAL_MIN, Math.round(n)))
}

const store = createPersistedSetting<number | null>({
  name: 'rp-fitness-calorie-goal',
  sanitize: sanitizeCalorieGoal,
})

export const registerCalorieGoalPersister = store.registerPersister
export const hydrateCalorieGoalFromServer = store.hydrateFromServer
/** The active goal (kcal, or null when unset) — subscribes to changes. */
export const useCalorieGoal = store.useValue
export const setCalorieGoal = store.set
export const getCalorieGoal = store.get

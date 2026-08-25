// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { CALORIE_GOAL_MAX, CALORIE_GOAL_MIN, sanitizeCalorieGoal } from './calorie-goal.js'

describe('sanitizeCalorieGoal', () => {
  it('passes whole in-range values through, coercing strings', () => {
    expect(sanitizeCalorieGoal(2200)).toBe(2200)
    expect(sanitizeCalorieGoal('1850')).toBe(1850)
    expect(sanitizeCalorieGoal(2199.6)).toBe(2200)
  })
  it('clamps to the 500–10000 kcal bounds', () => {
    expect(sanitizeCalorieGoal(50)).toBe(CALORIE_GOAL_MIN)
    expect(sanitizeCalorieGoal(99999)).toBe(CALORIE_GOAL_MAX)
  })
  it('treats empty/garbage/non-positive as "no goal"', () => {
    expect(sanitizeCalorieGoal(null)).toBeNull()
    expect(sanitizeCalorieGoal(undefined)).toBeNull()
    expect(sanitizeCalorieGoal('')).toBeNull()
    expect(sanitizeCalorieGoal('abc')).toBeNull()
    expect(sanitizeCalorieGoal(0)).toBeNull()
    expect(sanitizeCalorieGoal(-500)).toBeNull()
    expect(sanitizeCalorieGoal(Number.NaN)).toBeNull()
  })
})

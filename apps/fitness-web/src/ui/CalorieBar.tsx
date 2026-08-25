// The actual-vs-goal calorie bar, shared by the Food tab's day header and
// the /log dashboard's food line. Both render identical markup and ARIA;
// only the surrounding layout differs (see the scoped `.fit-food-line
// .cal-progress` override in fitness.css), so the two can't drift on how
// an over-goal day reads.
//
// Callers guard `goal !== null` — there is no progress without a goal.

import { calorieProgress } from '../lib/food-view.js'

export function CalorieBar({ kcal, goal }: { kcal: number; goal: number }) {
  const { pct, over, label } = calorieProgress(kcal, goal)
  return (
    <div
      className={`cal-progress${over ? ' over' : ''}`}
      role="progressbar"
      aria-label="Calories vs daily goal"
      aria-valuemin={0}
      aria-valuemax={goal}
      aria-valuenow={Math.min(kcal, goal)}
    >
      <div className="track">
        <i style={{ width: `${pct * 100}%` }} />
      </div>
      <div className="lbl">{label}</div>
    </div>
  )
}

// The /log dashboard's split hero: the two things this app is opened to
// do, side by side and one tap each — LOG FOOD and START WORKOUT — with
// today's food detail summarised on the line beneath.
//
// Pure presentation. Both tiles are always tappable, including while the
// day's totals are still loading: the action doesn't depend on the
// number, so gating the tap on a fetch would be gating it on nothing.

import { Icon } from '@rallypoint/ui'
import { CalorieBar } from './CalorieBar.js'

export interface TileVm {
  value: string
  sub: string
}

export function TodayActions({
  food,
  training,
  kcal,
  goal,
  macroLine,
  onLogFood,
  onStartWorkout,
  onOpenDiary,
}: {
  food: TileVm
  training: TileVm
  /** Today's calories, for the progress bar under the tiles. `null` while
   *  the day is still loading — the bar is withheld rather than drawn at
   *  zero, which would read as a confident "nothing eaten" exactly when
   *  we don't know yet (the tile shows a `—` for the same state). */
  kcal: number | null
  /** null = no daily goal set, so there is no progress to draw. */
  goal: number | null
  macroLine: string | null
  onLogFood: () => void
  onStartWorkout: () => void
  onOpenDiary: () => void
}) {
  return (
    <section className="fit-hero-wrap" aria-label="Today's actions">
      <div className="fit-hero">
        <button type="button" className="fit-hero-tile" onClick={onLogFood}>
          <span className="puck" aria-hidden>
            <Icon name="flame" size={18} />
          </span>
          <span className="eyebrow">Log food</span>
          <span className="v">{food.value}</span>
          <span className="u">{food.sub}</span>
        </button>
        <button type="button" className="fit-hero-tile" onClick={onStartWorkout}>
          <span className="puck" aria-hidden>
            <Icon name="barbell" size={18} />
          </span>
          <span className="eyebrow">Start workout</span>
          <span className="v">{training.value}</span>
          <span className="u">{training.sub}</span>
        </button>
      </div>

      <div className="fit-food-line">
        {goal !== null && kcal !== null && <CalorieBar kcal={kcal} goal={goal} />}
        <div className="foot">
          {macroLine && <span className="macros">{macroLine}</span>}
          <button type="button" className="diary" onClick={onOpenDiary}>
            Diary
            <Icon name="chevron" size={12} stroke={2} />
          </button>
        </div>
      </div>
    </section>
  )
}

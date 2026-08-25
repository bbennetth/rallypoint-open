// Seven-day Mon→Sun strip showing which days the user trained this
// week. Hit days get the accent border + filled dot; today gets a
// faint accent wash. Inputs are all computed by today-view.ts so this
// component stays a pure presentation layer.

import { WEEK_DAYS_MON_SUN } from '../lib/today-view.js'

export interface WeekStripProps {
  hits: readonly boolean[]
  /** 0..6 Mon→Sun index of today's day-of-week (undefined → no
   *  highlight, e.g. when the user is looking at a different week). */
  todayIdx?: number
}

export function WeekStrip({ hits, todayIdx }: WeekStripProps) {
  return (
    <div className="week-strip" role="group" aria-label="This week">
      {WEEK_DAYS_MON_SUN.map((letter, i) => {
        const hit = hits[i]
        const today = i === todayIdx
        const cls = ['week-day']
        if (hit) cls.push('hit')
        if (today) cls.push('today')
        return (
          <div
            key={i}
            className={cls.join(' ')}
            aria-label={hit ? `${letter} — trained` : `${letter} — rest`}
            aria-current={today ? 'date' : undefined}
          >
            <span className="dl">{letter}</span>
            <span className="dot" />
          </div>
        )
      })}
    </div>
  )
}

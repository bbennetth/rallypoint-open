// /stats Food sub-view — the calorie dashboard. Same 7-day / 28-day /
// Year segmented control as Training, three stat tiles (avg intake /
// goal / days on target), an editable daily calorie goal, and an
// actual-vs-goal chart: per-day bars for 7d/28d, a sparkline with a
// goal line for the year. Data comes from the /food/summary per-day
// aggregate; the goal is the RPID-backed `calorieGoalKcal` preference.

import { useEffect, useMemo, useState } from 'react'
import { Banner } from '@rallypoint/ui'
import type { FoodDaySummaryDto } from '@rallypoint/fitness-shared'
import { ApiError, listFoodDaySummary } from '../lib/api.js'
import { dayWindowIso } from '../lib/food-view.js'
import {
  buildCalorieDaySeries,
  calorieRangeDates,
  calorieStats,
  goalLineY,
  goalSparkDomain,
  sparklinePathWithDomain,
  statsRangeDays,
} from '../lib/food-stats-view.js'
import { STATS_RANGES } from '../lib/stats-view.js'
import type { StatsRange } from '../lib/stats-view.js'
import {
  CALORIE_GOAL_MAX,
  CALORIE_GOAL_MIN,
  sanitizeCalorieGoal,
  setCalorieGoal,
  useCalorieGoal,
} from '../lib/calorie-goal.js'

function errMessage(err: unknown): string {
  return err instanceof ApiError
    ? err.message
    : err instanceof Error
      ? err.message
      : 'Failed to load calorie stats.'
}

function rangeLabel(r: StatsRange): string {
  return r === '7d' ? 'LAST 7 DAYS' : r === '28d' ? 'LAST 28 DAYS' : 'LAST YEAR'
}

// Bar label: 'Mon 13' for 7d, day-of-month for 28d.
function barLabel(dateStr: string, range: StatsRange): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const date = new Date(y!, m! - 1, d!)
  if (range === '7d')
    return date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

export function FoodStatsView() {
  const goal = useCalorieGoal()
  const [range, setRange] = useState<StatsRange>('7d')
  const [days, setDays] = useState<FoodDaySummaryDto[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [goalDraft, setGoalDraft] = useState<string>(goal === null ? '' : String(goal))

  // Keep the draft following external goal changes (hydration, another
  // tab) unless the user is mid-edit — simple approach: refresh whenever
  // the stored goal changes.
  useEffect(() => {
    setGoalDraft(goal === null ? '' : String(goal))
  }, [goal])

  const { start, end } = useMemo(() => calorieRangeDates(range, new Date()), [range])

  useEffect(() => {
    let cancelled = false
    setDays(null)
    setError(null)
    const { fromIso } = dayWindowIso(start)
    const { toIso } = dayWindowIso(end)
    listFoodDaySummary(fromIso, toIso)
      .then((res) => {
        if (!cancelled) setDays(res)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errMessage(err))
      })
    return () => {
      cancelled = true
    }
  }, [start, end])

  const series = useMemo(
    () => buildCalorieDaySeries(days ?? [], end, statsRangeDays(range)),
    [days, end, range],
  )
  const stats = useMemo(() => calorieStats(series, goal), [series, goal])

  // Bars scale against the busiest day OR the goal, so the goal marker
  // always sits inside the track.
  const barMax = Math.max(1, goal ?? 0, ...series.map((d) => d.kcal))

  const sparkValues = series.map((d) => d.kcal)
  const sparkDomain = goalSparkDomain(sparkValues, goal)
  const spark = sparklinePathWithDomain(sparkValues, sparkDomain, 320, 64)

  function saveGoal() {
    setCalorieGoal(sanitizeCalorieGoal(goalDraft))
  }

  return (
    <div className="page-pad">
      <header className="fit-head">
        <div className="top">
          <div>
            <div className="eyebrow">{rangeLabel(range)}</div>
            <h1>Calories</h1>
          </div>
        </div>
        <div className="fit-seg" style={{ marginTop: 12 }} role="tablist">
          {STATS_RANGES.map((r) => (
            <button
              key={r.value}
              type="button"
              role="tab"
              aria-selected={range === r.value}
              className={range === r.value ? 'on' : ''}
              onClick={() => setRange(r.value)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </header>

      {error && <Banner tone="error">{error}</Banner>}

      <div className="fit-stats">
        <div className="fit-stat">
          <div className="v">
            {stats.avgKcal}
            <small> kcal</small>
          </div>
          <div className="k">Avg / day</div>
        </div>
        <div className="fit-stat">
          <div className="v">
            {goal === null ? '—' : goal}
            {goal !== null && <small> kcal</small>}
          </div>
          <div className="k">Daily goal</div>
        </div>
        <div className="fit-stat">
          <div className="v">
            {stats.onTargetDays === null ? '—' : `${stats.onTargetDays}/${stats.loggedDays}`}
          </div>
          <div className="k">Days on goal</div>
        </div>
      </div>

      <section style={{ display: 'grid', gap: 8 }}>
        <div className="sec-rule">
          <div className="eyebrow">CALORIE GOAL</div>
          <div className="line" />
          <span className="ct">KCAL / DAY</span>
        </div>
        <div className="cal-goal-edit">
          <input
            type="number"
            inputMode="numeric"
            min={CALORIE_GOAL_MIN}
            max={CALORIE_GOAL_MAX}
            step={50}
            placeholder="e.g. 2200"
            aria-label="Daily calorie goal (kcal)"
            value={goalDraft}
            onChange={(e) => setGoalDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveGoal()
            }}
          />
          <button type="button" onClick={saveGoal}>
            Set goal
          </button>
          {goal !== null && (
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setGoalDraft('')
                setCalorieGoal(null)
              }}
            >
              Clear
            </button>
          )}
        </div>
        {goal === null && (
          <div style={{ color: 'var(--ink-dim)', fontSize: 13 }}>
            Set a daily goal to see actual vs goal below and on the Food tab.
          </div>
        )}
      </section>

      <section style={{ display: 'grid', gap: 4 }}>
        <div className="sec-rule">
          <div className="eyebrow">ACTUAL VS GOAL</div>
          <div className="line" />
          <span className="ct">KCAL</span>
        </div>

        {days === null && !error ? (
          <div style={{ color: 'var(--ink-dim)' }}>Loading…</div>
        ) : stats.loggedDays === 0 ? (
          <div className="fit-empty">
            <div className="t">Nothing logged in this window</div>
            <div className="b">Log meals on the Food tab and they'll chart here.</div>
          </div>
        ) : range === 'year' ? (
          <>
            <svg
              viewBox="0 0 320 64"
              width="100%"
              height="72"
              preserveAspectRatio="none"
              role="img"
              aria-label="Daily calories over the last year"
            >
              {spark.area && <path d={spark.area} fill="var(--accent-soft)" />}
              {spark.line && (
                <path d={spark.line} fill="none" stroke="var(--acid)" strokeWidth="1.5" />
              )}
              {goal !== null && (
                <line
                  x1="0"
                  x2="320"
                  y1={goalLineY(sparkDomain, goal, 64)}
                  y2={goalLineY(sparkDomain, goal, 64)}
                  stroke="var(--hot)"
                  strokeWidth="1"
                  strokeDasharray="4 3"
                />
              )}
            </svg>
            {goal !== null && (
              <div className="cal-legend">
                <span className="sw goal" /> Goal {goal} kcal
              </div>
            )}
          </>
        ) : (
          <div>
            {series.map((d) => {
              const over = goal !== null && d.logged && d.kcal > goal
              return (
                <div key={d.date} className="vol-row">
                  <div className="lab">
                    <span className="g">{barLabel(d.date, range)}</span>
                    <span className="n" style={over ? { color: 'var(--hot)' } : undefined}>
                      {d.logged ? `${d.kcal} kcal` : '—'}
                    </span>
                  </div>
                  <div className="vol-bar cal-bar">
                    <i
                      style={{
                        width: `${(d.kcal / barMax) * 100}%`,
                        ...(over ? { background: 'var(--hot)' } : {}),
                      }}
                    />
                    {goal !== null && (
                      <span
                        className="goal-tick"
                        style={{ left: `${(goal / barMax) * 100}%` }}
                        aria-hidden="true"
                      />
                    )}
                  </div>
                </div>
              )
            })}
            {goal !== null && (
              <div className="cal-legend">
                <span className="sw goal" /> Goal {goal} kcal
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  )
}

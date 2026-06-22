// The My Day surface exposes one timeline in three lenses: the scrolling
// agenda (default) plus the month and week calendar grids (the standalone
// Calendar page was folded in here). The chosen lens is persisted per-user in
// the 'planner' settings namespace under MY_DAY_VIEW_KEY.

export type MyDayView = 'agenda' | 'month' | 'week'

export const MY_DAY_VIEW_KEY = 'myDayView'

// Pure: coerce a persisted/unknown value to a valid MyDayView. Anything that
// isn't an explicit 'month' / 'week' falls back to the 'agenda' default, so a
// missing setting, a stale value, or a malformed blob all land on the agenda.
export function parseMyDayView(v: unknown): MyDayView {
  return v === 'month' || v === 'week' ? v : 'agenda'
}

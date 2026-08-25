import { ApiError, type MyDay, type MyDayTask, type WorkoutSummaryDto } from './api.js'
import { splitChoresFromTasks } from './chores-helpers.js'
import { pickNext, splitMyDay, type ScheduleEntry } from './planner-helpers.js'

// Pure helpers backing the My Day agenda (`MyDayPage`). Split out of the
// component so the view-building logic can be unit-tested without a DOM.

export function errMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message
  return 'Something went wrong. Please try again.'
}

// Capitalise the first letter of a workout modality label for display.
// e.g. 'strength' → 'Strength', 'conditioning' → 'Conditioning'.
export function fmtModality(modality: string): string {
  return modality.charAt(0).toUpperCase() + modality.slice(1)
}

// Format the title-and-summary half of a training-card row: "Push Day · 12 sets"
// or just "12 sets" when no title is set. The modality is rendered as a
// separate `pl-chip` badge alongside this string, so it's deliberately
// omitted here — including it would duplicate the chip text.
export function fmtWorkout(w: WorkoutSummaryDto): string {
  const parts: string[] = []
  if (w.title) parts.push(w.title)
  parts.push(`${w.setCount} ${w.setCount === 1 ? 'set' : 'sets'}`)
  return parts.join(' · ')
}

export function headingLabel(date: string): string {
  const parsed = new Date(`${date}T00:00:00`)
  if (Number.isNaN(parsed.getTime())) return date
  return parsed.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
}

export interface MyDayViewResult {
  allDay: MyDayTask[]
  allDayEvents: MyDay['eventDays']
  allDayPersonalEvents: MyDay['events']
  timeline: ScheduleEntry[]
  chores: MyDayTask[]
  total: number
  done: number
  left: number
  eventsCount: number
  next: ScheduleEntry | null
}

// Chores are rendered in their own always-visible section between Schedule
// and No date / Coming up (morning check-in handoff). Lift them OUT of
// data.tasks AND data.undatedTasks before splitMyDay so they don't
// double-render in All-day / Schedule / No date.
export function splitChoreTasks(data: MyDay, choresListId: string | null) {
  const split = splitChoresFromTasks(data.tasks, choresListId)
  const undatedSplit = splitChoresFromTasks(data.undatedTasks, choresListId)
  return { split, undatedSplit }
}

// The summary counts (`total`/`done`/`left`) come from the chore-stripped
// buckets, so the toolbar's "tasks left" label counts only actual tasks —
// chores have their own section + check-off and are not "tasks" by user
// mental model.
export function buildTaskSummary(allNonChoreTasks: MyDayTask[]) {
  const total = allNonChoreTasks.length
  const done = allNonChoreTasks.filter((t) => t.completed).length
  return { total, done, left: total - done }
}

export function buildMyDayView(
  data: MyDay,
  today: string,
  choresListId: string | null,
): MyDayViewResult {
  const { split, undatedSplit } = splitChoreTasks(data, choresListId)
  const { allDay, allDayEvents, allDayPersonalEvents, timeline } = splitMyDay(
    split.tasks,
    data.events,
    data.eventDays,
    today,
  )
  const allNonChoreTasks = [...split.tasks, ...undatedSplit.tasks]
  const { total, done, left } = buildTaskSummary(allNonChoreTasks)
  const next = pickNext(timeline, Date.now())
  return {
    allDay,
    allDayEvents,
    allDayPersonalEvents,
    timeline,
    chores: split.chores,
    total,
    done,
    left,
    eventsCount: data.events.length + data.eventDays.length,
    next,
  }
}

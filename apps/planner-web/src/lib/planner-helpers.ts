// Pure view-model helpers for the Planner surfaces. Kept out of the page
// components so the interesting decisions (all-day vs timed split, the "Next"
// pick, Upcoming day-grouping + relative labels) are unit-testable without a
// DOM. No React, no globals — everything in here is a pure function.

import type { MyDayTask, MyDayEvent, EventDayDto, UpcomingItem } from './api.js'

// ── local date / timezone ──────────────────────────────────────────

// The browser's local calendar date (YYYY-MM-DD) + IANA timezone. Sent to the
// My Day / Upcoming BFF endpoints, which resolve "today" relative to it.
export function localToday(): { date: string; tz: string } {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  return { date: `${y}-${m}-${d}`, tz }
}

// A datetime-local value ("YYYY-MM-DDTHH:mm", zone-less) → a UTC-offset
// ISO instant (always 'Z'), or undefined when blank/unparseable. The browser
// reads the local value in its own zone; toISOString() emits the offset the
// Events SDK's instant field requires. Shared by the Events page and the
// quick-add event form.
export function toInstant(localValue: string): string | undefined {
  if (!localValue) return undefined
  const d = new Date(localValue)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}

// Inverse of toInstant: an ISO instant → the local "YYYY-MM-DDTHH:mm" value a
// datetime-local input expects (or '' when null/unparseable). Round-trips with
// toInstant (both read the runtime's local zone) so an edit form pre-fills with
// the same wall-clock the user originally entered.
export function instantToLocalInput(instant: string | null | undefined): string {
  if (!instant) return ''
  const d = new Date(instant)
  if (Number.isNaN(d.getTime())) return ''
  const y = d.getFullYear()
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const da = String(d.getDate()).padStart(2, '0')
  const h = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${y}-${mo}-${da}T${h}:${mi}`
}

// ── task due dates ────────────────────────────────────────────────
//
// Task due dates are date-only. We anchor them to LOCAL midnight (using the
// Date(y, m-1, d) local-time constructor) so they sit inside the user's own
// local day window — the same window the read-side (composeMyDay /
// composeUpcoming, zonedDayWindow) applies. UTC midnight would shift the
// instant backwards for west-of-UTC users, making "today" dues fall in
// yesterday's window and appear overdue.

// YYYY-MM-DD date input → ISO instant anchored to local midnight, or null
// when blank / unparseable.
export function dateInputToInstant(value: string): string | null {
  if (!value) return null
  const [ys, ms, ds] = value.split('-')
  const y = Number(ys)
  const m = Number(ms)
  const d = Number(ds)
  const dt = new Date(y, m - 1, d) // local midnight
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString()
}

// ISO instant → YYYY-MM-DD date input using local calendar parts, or '' when
// null / unparseable. Inverse of dateInputToInstant.
export function instantToDateInput(instant: string | null): string {
  if (!instant) return ''
  const dt = new Date(instant)
  if (Number.isNaN(dt.getTime())) return ''
  const y = dt.getFullYear()
  const m = String(dt.getMonth() + 1).padStart(2, '0')
  const da = String(dt.getDate()).padStart(2, '0')
  return `${y}-${m}-${da}`
}

// ISO instant → local "HH:mm" for a <input type="time">, or '' when null /
// unparseable. Inverse pairing for combineDueDateTime when a time is set. Reads
// the browser's local zone (matching combineDueDateTime's toInstant), so the
// round-trip is self-consistent. Callers gate on hasTimeOfDay first, so the
// documented `T00:00Z` edge there (a far-east-of-UTC time that lands on UTC
// midnight) never reaches here — it stays blank, which the BFF still treats as
// timed via localClockIsMidnight.
export function instantToTimeInput(instant: string | null): string {
  if (!instant) return ''
  const dt = new Date(instant)
  if (Number.isNaN(dt.getTime())) return ''
  const h = String(dt.getHours()).padStart(2, '0')
  const mi = String(dt.getMinutes()).padStart(2, '0')
  return `${h}:${mi}`
}

// Combine a date input (YYYY-MM-DD) with an optional time input (HH:mm) into a
// task dueDate:
//   - no date            → null (clears the due)
//   - date, no time      → local-midnight instant (date-only; never notifies)
//   - date + time        → a true local instant (toISOString); this is the
//                          timed due the notification scheduler fires on.
// (The browser's IANA tz is attached to task writes by api.ts `taskTz()`, which
// the BFF uses to tell a timed due from a day-only one.)
export function combineDueDateTime(dateInput: string, timeInput: string): string | null {
  if (!dateInput) return null
  if (!timeInput) return dateInputToInstant(dateInput)
  return toInstant(`${dateInput}T${timeInput}`) ?? dateInputToInstant(dateInput)
}

// ── quick notes ────────────────────────────────────────────────────

// Split a free-form quick-note textarea into a Lists item's `title` (the
// heading) and `notes` (the body). The first non-empty line becomes the
// title (the BFF caps it at 200 — we trim defensively); everything after
// that first line is the body (the BFF caps it at 2000). Returns null when
// the input is empty/whitespace-only so callers can no-op. A single long
// line with no break overflows past 200 chars into the body so nothing is
// lost.
export function splitQuickNote(raw: string): { title: string; notes?: string } | null {
  const text = raw.replace(/\r\n/g, '\n').trim()
  if (text === '') return null
  const nl = text.indexOf('\n')
  let title = nl === -1 ? text : text.slice(0, nl)
  let rest = nl === -1 ? '' : text.slice(nl + 1)
  title = title.trim()
  if (title.length > 200) {
    rest = title.slice(200) + (rest ? `\n${rest}` : '')
    title = title.slice(0, 200)
  }
  const notes = rest.trim()
  return notes ? { title, notes } : { title }
}

// Resolve the effective title for a note being saved from the inline editor.
// When the title field is non-empty (even just whitespace), it is used as-is
// (trimmed). When the title field is empty, the first non-empty line of the
// body is promoted to the title (consistent with splitQuickNote behaviour for
// new notes). Falls back to '(untitled)' when both fields are blank.
export function resolveNoteTitle(title: string, body: string): string {
  const t = title.trim()
  if (t) return t
  // Promote first non-empty body line as title.
  const firstLine = body
    .replace(/\r\n/g, '\n')
    .split('\n')
    .find((l) => l.trim() !== '')
  return firstLine?.trim() || '(untitled)'
}

// ── time formatting ────────────────────────────────────────────────

// 12-hour clock label from explicit hour/minute (tz-resolved by the caller).
// e.g. clockLabel(19, 30) -> "7:30 PM".
export function clockLabel(hours: number, minutes: number): string {
  const ap = hours < 12 ? 'AM' : 'PM'
  const h12 = hours % 12 === 0 ? 12 : hours % 12
  return `${h12}:${String(minutes).padStart(2, '0')} ${ap}`
}

// Format an ISO instant as a local 12-hour time. Empty string for null /
// unparseable input.
export function fmtTime(instant: string | null): string {
  if (!instant) return ''
  const d = new Date(instant)
  if (Number.isNaN(d.getTime())) return ''
  return clockLabel(d.getHours(), d.getMinutes())
}

// Format a wall-clock 'HH:MM' / 'HH:MM:SS' string (a group event day's own
// time, already resolved in the event's day — no instant/tz) as a 12-hour
// label. Empty string for null / unparseable input.
export function fmtClock(hhmm: string | null): string {
  if (!hhmm) return ''
  const m = /^(\d{2}):(\d{2})/.exec(hhmm)
  if (!m) return ''
  return clockLabel(Number(m[1]), Number(m[2]))
}

// Display label for a group event day's window: "All day" when it has no start
// time, "9:00 AM – 5:00 PM" when both ends are set, else just the start.
export function eventDayWindow(startTime: string | null, endTime: string | null): string {
  if (startTime == null) return 'All day'
  const start = fmtClock(startTime)
  const end = fmtClock(endTime)
  return end ? `${start} – ${end}` : start
}

// True when a task's due instant carries an explicit time-of-day. "No time
// set" must render as all-day, NOT as "12:00 AM". A due is treated as all-day
// when EITHER:
//   • its UTC wall-clock is midnight ("…T00:00…") — how a date-only / no-time
//     recurring occurrence is stored (occurrenceDueDate stamps UTC midnight), or
//   • it lands on the user's LOCAL midnight — how a one-off date-only due is
//     stored (dateInputToInstant anchors to local midnight, so its UTC string
//     is non-zero for non-UTC users; the old pure-string test misread that as
//     timed and showed "12:00 AM").
// The local check uses the runtime zone (Planner has no stored per-user tz; the
// client zone IS the runtime zone), matching the rest of this module. A bare
// date string ("2026-06-04") is all-day. A task set to exactly midnight reads
// as all-day — an acceptable edge, since one-off tasks have no time picker.
// (Recurring no-time day PLACEMENT under a non-UTC tz is a separate, deferred
// concern; this only fixes the all-day vs timed DISPLAY split.)
export function hasTimeOfDay(instant: string | null): boolean {
  if (!instant) return false
  const m = /T(\d{2}):(\d{2})/.exec(instant)
  if (!m) return false
  if (m[1] === '00' && m[2] === '00') return false
  const d = new Date(instant)
  if (Number.isNaN(d.getTime())) return false
  return !(d.getHours() === 0 && d.getMinutes() === 0)
}

// Timezone invariant: every `dueDate` the planner client receives from
// planner-api is a GENUINE UTC instant. A recurring occurrence's floating local
// wall-clock (lists-api stamps "9:30" as "…T09:30:00.000Z") is resolved into the
// request tz server-side — the BFF is the single resolver (resolveRecurrenceDues
// on my-day / upcoming / the item-list reads). So the client never re-anchors:
// it renders every due with the plain local formatters below (fmtTime / localYmd
// / toLocaleDateString), which read the runtime zone, and the time + day the
// user set come out right in any viewer timezone.

// Local calendar day (YYYY-MM-DD) of an instant, in the runtime's timezone.
export function localYmd(instant: string): string {
  const d = new Date(instant)
  const y = d.getFullYear()
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const da = String(d.getDate()).padStart(2, '0')
  return `${y}-${mo}-${da}`
}

// ── My Day ─────────────────────────────────────────────────────────

export interface ScheduleEntry {
  id: string
  kind: 'task' | 'event' | 'eventDay'
  title: string
  at: string // the sort instant (dueDate / startAt / wall-clock day+time)
  task?: MyDayTask
  event?: MyDayEvent
  eventDay?: EventDayDto
}

export interface MyDaySplit {
  allDay: MyDayTask[]
  allDayEvents: EventDayDto[] // all-day group event days (read-only)
  allDayPersonalEvents: MyDayEvent[] // all-day + multi-day-continuation personal events
  timeline: ScheduleEntry[]
}

// Split a My Day payload into the all-day list (tasks whose due time is
// midnight / date-only, all-day group event days, and all-day / continuation
// personal events) and the timed schedule (timed tasks, personal events that
// start today, and timed group event days), the latter sorted ascending by
// instant.
//
// `todayYmd` (the viewer's local calendar day) drives the multi-day handling: a
// personal event whose startAt falls on a PRIOR day is a continuation of a
// multi-day event into today, so it shows in the all-day band (its day-1 start
// time is meaningless today) rather than the timeline at a stale past time. When
// omitted, only the explicit all-day flag routes an event aside (back-compat).
//
// Mixed sort keys are safe: tasks/personal events carry real UTC instants while
// a timed group day carries only a wall-clock `date`+`startTime`. Per the
// Planner tz model (no stored per-user tz — the client supplies its own zone to
// the BFF, which is also the runtime zone here), `Date.parse('<date>T<time>')`
// reads the string in that same zone, yielding the epoch whose local rendering
// IS `startTime`. So sorting by epoch equals sorting by displayed local time,
// and a group day interleaves correctly with the instants beside it.
export function splitMyDay(
  tasks: MyDayTask[],
  events: MyDayEvent[],
  eventDays: EventDayDto[] = [],
  todayYmd?: string,
): MyDaySplit {
  const allDay: MyDayTask[] = []
  const allDayEvents: EventDayDto[] = []
  const allDayPersonalEvents: MyDayEvent[] = []
  const timeline: ScheduleEntry[] = []

  for (const t of tasks) {
    if (t.dueDate && hasTimeOfDay(t.dueDate)) {
      timeline.push({
        id: t.id,
        kind: 'task',
        title: t.title,
        // dueDate is a genuine instant (the BFF resolved any recurring floating
        // due in the request tz), so it both sorts and renders in local time.
        at: t.dueDate,
        task: t,
      })
    } else {
      allDay.push(t)
    }
  }
  for (const e of events) {
    // A multi-day event whose start day is before today continues INTO today —
    // its day-1 start time doesn't apply, so treat it as all-day for today.
    const startsBeforeToday =
      todayYmd != null && e.startAt != null && localYmd(e.startAt) < todayYmd
    // Issue #545: use the allDay flag from the server (with midnight-inference
    // fallback for backward compat).
    const isAllDay = e.allDay || !e.startAt || startsBeforeToday
    if (!isAllDay && e.startAt) {
      timeline.push({ id: e.id, kind: 'event', title: e.name, at: e.startAt, event: e })
    } else if (e.startAt) {
      // All-day and continuation personal events sit in the all-day band. Events
      // with no startAt at all have no calendar position and are dropped.
      allDayPersonalEvents.push(e)
    }
  }
  for (const d of eventDays) {
    if (d.startTime == null) {
      allDayEvents.push(d)
    } else {
      timeline.push({
        id: `${d.eventId}@${d.date}`,
        kind: 'eventDay',
        title: d.name,
        at: `${d.date}T${d.startTime}`,
        eventDay: d,
      })
    }
  }

  timeline.sort((a, b) => {
    const ad = Date.parse(a.at)
    const bd = Date.parse(b.at)
    if (ad !== bd) return ad - bd
    return a.title.localeCompare(b.title)
  })
  // Order the all-day band by startAt ascending so ongoing multi-day events
  // (which started on prior days) lead, then genuine all-day events that start
  // today, then by name. The BFF already returns startAt-ascending, so this is a
  // no-op in practice — it just makes the band's contract explicit rather than
  // relying on upstream order.
  allDayPersonalEvents.sort((a, b) => {
    const am = a.startAt ? Date.parse(a.startAt) : 0
    const bm = b.startAt ? Date.parse(b.startAt) : 0
    return am !== bm ? am - bm : a.name.localeCompare(b.name)
  })
  return { allDay, allDayEvents, allDayPersonalEvents, timeline }
}

// The soonest schedule entry at/after `nowMs` (the "Next" stat). Null when the
// timeline is empty or everything is in the past.
export function pickNext(timeline: ScheduleEntry[], nowMs: number): ScheduleEntry | null {
  let best: ScheduleEntry | null = null
  let bestMs = Infinity
  for (const e of timeline) {
    const t = Date.parse(e.at)
    if (!Number.isFinite(t) || t < nowMs) continue
    if (t < bestMs) {
      bestMs = t
      best = e
    }
  }
  return best
}

// Whole-percent completion, clamped to 0-100. An empty day (no tasks) reads as 100% done.
export function progressPct(done: number, total: number): number {
  if (total <= 0) return 100
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)))
}

// ── Upcoming ───────────────────────────────────────────────────────

// Parse a YYYY-MM-DD string into a UTC-midnight epoch (ms), on the date parts
// only so it's free of timezone/DST drift. Missing parts default sensibly.
function ymdToUtc(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number)
  return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)
}

// Day-count between two YYYY-MM-DD calendar dates (target - today).
export function dayDiff(targetYmd: string, todayYmd: string): number {
  return Math.round((ymdToUtc(targetYmd) - ymdToUtc(todayYmd)) / 86_400_000)
}

// Relative label for an Upcoming day group: "Today", "Tomorrow", "In N days"
// (within a week), else the weekday name. Past dates read "Overdue".
export function relativeDayLabel(targetYmd: string, todayYmd: string): string {
  const diff = dayDiff(targetYmd, todayYmd)
  if (diff < 0) return 'Overdue'
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Tomorrow'
  if (diff < 7) return `In ${diff} days`
  return new Date(ymdToUtc(targetYmd)).toLocaleDateString(undefined, {
    weekday: 'long',
    timeZone: 'UTC',
  })
}

// Display date for a group header, e.g. "Jun 5".
export function groupDateLabel(ymd: string): string {
  return new Date(ymdToUtc(ymd)).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

export interface UpcomingGroup {
  ymd: string
  dateLabel: string
  rel: string
  items: UpcomingItem[]
}

// The local calendar day (YYYY-MM-DD) an Upcoming item belongs to. Tasks/events
// carry a UTC instant resolved to the runtime tz; an eventDay already carries a
// bare calendar date, so it's used verbatim (no tz drift).
function itemYmd(i: UpcomingItem): string | null {
  if (i.kind === 'eventDay') return i.eventDay.date
  if (i.kind === 'holiday') return i.holiday.observedDate
  if (i.kind === 'task') {
    // dueDate is a genuine instant (the BFF resolved any recurring floating due),
    // so its local calendar day groups it under the day it falls on.
    return i.task.dueDate ? localYmd(i.task.dueDate) : null
  }
  return i.event.startAt ? localYmd(i.event.startAt) : null
}

// Group dated Upcoming items by their local calendar day, preserving the
// soonest-first order the BFF already applied. Each group carries a display
// date + a relative label resolved against `todayYmd`.
export function groupUpcomingByDay(dated: UpcomingItem[], todayYmd: string): UpcomingGroup[] {
  const groups: UpcomingGroup[] = []
  const byYmd = new Map<string, UpcomingGroup>()
  for (const item of dated) {
    const ymd = itemYmd(item)
    if (!ymd) continue
    let g = byYmd.get(ymd)
    if (!g) {
      g = { ymd, dateLabel: groupDateLabel(ymd), rel: relativeDayLabel(ymd, todayYmd), items: [] }
      byYmd.set(ymd, g)
      groups.push(g)
    }
    g.items.push(item)
  }
  return groups
}

// Partition day-groups for the single-scroll agenda. `today` (and overdue)
// items are already surfaced in the My Day roll-up above the feed, so the
// "Coming up" list renders only `future` (diff ≥ 1) — this is what prevents
// today's items from appearing twice on one page. `overdue`/`today` are kept
// for callers that want them (e.g. the calendar, which needs the today cell
// populated). Input order within each bucket is preserved.
export interface AgendaGroups {
  overdue: UpcomingGroup[]
  today: UpcomingGroup[]
  future: UpcomingGroup[]
}

export function splitAgendaGroups(groups: UpcomingGroup[], todayYmd: string): AgendaGroups {
  const overdue: UpcomingGroup[] = []
  const today: UpcomingGroup[] = []
  const future: UpcomingGroup[] = []
  for (const g of groups) {
    const diff = dayDiff(g.ymd, todayYmd)
    if (diff < 0) overdue.push(g)
    else if (diff === 0) today.push(g)
    else future.push(g)
  }
  return { overdue, today, future }
}

// ── Calendar view helpers ──────────────────────────────────────────

// A single day-cell in a month or week calendar grid.
export interface CalendarCell {
  /** YYYY-MM-DD local calendar date for this cell. */
  date: string
  /** False for leading/trailing cells from the previous or next month. */
  inCurrentMonth: boolean
  /** Upcoming items that fall on this local day. */
  items: UpcomingItem[]
}

// Build a lookup map from a groupUpcomingByDay result so calendar builders can
// find items for any ymd in O(1).
function makeGroupMap(groups: UpcomingGroup[]): Map<string, UpcomingItem[]> {
  const m = new Map<string, UpcomingItem[]>()
  for (const g of groups) m.set(g.ymd, g.items)
  return m
}

// Add `days` calendar days to a YYYY-MM-DD string. Returns a new YYYY-MM-DD.
// Uses the Date local-time constructor so DST-jump days still produce the
// correct calendar date (no UTC drift on the date parts).
function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number)
  const dt = new Date(y, (m ?? 1) - 1, (d ?? 1) + days)
  const yr = dt.getFullYear()
  const mo = String(dt.getMonth() + 1).padStart(2, '0')
  const da = String(dt.getDate()).padStart(2, '0')
  return `${yr}-${mo}-${da}`
}

// The YYYY-MM-DD for the first day of a given year+month.
function firstOfMonth(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}-01`
}

// The day-of-week (0=Sun … 6=Sat) of a YYYY-MM-DD date, using the local
// calendar (same system the rest of the helpers use).
function dow(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(y, (m ?? 1) - 1, d ?? 1).getDay()
}

// Build the month grid for a given year + month (1-based).
// `weekStart`: 0 = Sunday (default), 1 = Monday.
// Returns an array of week-rows, each containing 7 CalendarCells.
// Leading/trailing cells from adjacent months fill out the first/last row so
// every row is exactly 7 days, and `inCurrentMonth` is false for those cells.
// Undated items are never included (they have no ymd in the groups map).
export function buildMonthGrid(
  groups: UpcomingGroup[],
  year: number,
  month: number,
  weekStart: 0 | 1 = 0,
): CalendarCell[][] {
  const groupMap = makeGroupMap(groups)
  const first = firstOfMonth(year, month)
  // How far back to go from the 1st to reach the grid's starting Sunday/Monday.
  const startDow = (dow(first) - weekStart + 7) % 7
  // Start of the grid (may be in the previous month).
  let cursor = addDays(first, -startDow)

  // Determine the last day of the month.
  // new Date(year, month, 0) gives the last day of the previous month in the
  // local calendar — so new Date(year, month, 0).getDate() = days in month.
  const daysInMonth = new Date(year, month, 0).getDate()

  // numWeeks covers startDow leading cells + all days in the month (rounds up
  // to a full week), clamped naturally to 4–6 by the calendar layout.
  const totalDays = startDow + daysInMonth
  const numWeeks = Math.ceil(totalDays / 7)

  const rows: CalendarCell[][] = []
  for (let w = 0; w < numWeeks; w++) {
    const row: CalendarCell[] = []
    for (let d = 0; d < 7; d++) {
      const cellMonth = Number(cursor.slice(5, 7))
      row.push({
        date: cursor,
        inCurrentMonth: cellMonth === month,
        items: groupMap.get(cursor) ?? [],
      })
      cursor = addDays(cursor, 1)
    }
    rows.push(row)
  }
  return rows
}

// Build a 7-cell strip for the week containing `anchorYmd`.
// `weekStart`: 0 = Sunday (default), 1 = Monday.
// inCurrentMonth is always true (a week strip doesn't have a "current month").
export function buildWeekStrip(
  groups: UpcomingGroup[],
  anchorYmd: string,
  weekStart: 0 | 1 = 0,
): CalendarCell[] {
  const groupMap = makeGroupMap(groups)
  const dayOffset = (dow(anchorYmd) - weekStart + 7) % 7
  const weekStart_ymd = addDays(anchorYmd, -dayOffset)

  const cells: CalendarCell[] = []
  for (let d = 0; d < 7; d++) {
    const date = addDays(weekStart_ymd, d)
    cells.push({
      date,
      inCurrentMonth: true,
      items: groupMap.get(date) ?? [],
    })
  }
  return cells
}

// ── List-row delete confirm ────────────────────────────────────────

// How long (ms) the inline "Confirm delete?" chip stays visible before it
// auto-dismisses. Exported so tests can assert on the value without hard-
// coding it; the component reads this constant rather than a magic number.
export const LIST_CONFIRM_TIMEOUT_MS = 4000

// State machine for the list-row confirm flow. Returns the next `confirmListId`
// given the current one and an action, purely — no side-effects, no timers.
// Used by tests to verify the state-transition logic in isolation.
export type ConfirmAction =
  | { type: 'open'; listId: string }
  | { type: 'cancel' }
  | { type: 'confirm' }

export function nextConfirmListId(
  current: string | null,
  action: ConfirmAction,
): string | null {
  switch (action.type) {
    case 'open':
      return action.listId
    case 'cancel':
    case 'confirm':
      return null
    default:
      return current
  }
}

// --- notes folders (#549) -------------------------------------------

interface FolderLike {
  id: string
  isDefault: boolean
}

// Order folders for the rail/picker: the default folder first, the rest in
// their given order. Pure (the BFF already returns folders oldest-first, so
// "the rest" preserves that). Unit-tested.
export function orderFolders<T extends FolderLike>(folders: T[]): T[] {
  const def = folders.filter((f) => f.isDefault)
  const rest = folders.filter((f) => !f.isDefault)
  return [...def, ...rest]
}

// Count notes per folder id, for the rail badges. Pure. Unit-tested.
export function countNotesByFolder(notes: { folderId: string }[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const n of notes) counts[n.folderId] = (counts[n.folderId] ?? 0) + 1
  return counts
}

// --- My Day status line (header toolbar) -----------------------------

// Compose the My Day agenda status line shown on the header toolbar:
// "<date> · All clear" when nothing is due, "<date> · N of M tasks done"
// otherwise, or just the bare date label when task counts aren't known yet
// (total === null, i.e. the day roll-up hasn't loaded). Pure. Unit-tested.
export function mydayStatusLabel(
  dateLabel: string,
  total: number | null,
  done: number,
): string {
  if (total === null) return dateLabel
  if (total === 0) return `${dateLabel} · All clear`
  return `${dateLabel} · ${done} of ${total} tasks done`
}


import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  clockLabel,
  fmtClock,
  normalizeDayMode,
  eventDayWindow,
  hasTimeOfDay,
  splitMyDay,
  pickNext,
  progressPct,
  dayDiff,
  relativeDayLabel,
  groupUpcomingByDay,
  buildMonthGrid,
  buildWeekStrip,
  splitQuickNote,
  resolveNoteTitle,
  toInstant,
  instantToLocalInput,
  dateInputToInstant,
  instantToDateInput,
  LIST_CONFIRM_TIMEOUT_MS,
  nextConfirmListId,
  type ScheduleEntry,
  type CalendarCell,
} from './planner-helpers.js'
import type { MyDayTask, MyDayEvent, EventDayDto, UpcomingItem } from './api.js'

function task(over: Partial<MyDayTask> = {}): MyDayTask {
  return {
    id: 't1',
    listId: 'l1',
    title: 'Task',
    completed: false,
    priority: null,
    dueDate: null,
    seriesId: null,
    customFields: {},
    ...over,
  }
}

function event(over: Partial<MyDayEvent> = {}): MyDayEvent {
  return {
    id: 'e1',
    name: 'Event',
    startAt: null,
    endAt: null,
    locationLabel: null,
    ticketCount: 0,
    ...over,
  }
}

function eventDay(over: Partial<EventDayDto> = {}): EventDayDto {
  return {
    eventId: 'event_1',
    slug: 'fest',
    name: 'Festival',
    scopeType: 'group',
    date: '2026-06-04',
    dayLabel: 'Day 1',
    startTime: null,
    endTime: null,
    owned: false,
    ...over,
  }
}

describe('normalizeDayMode', () => {
  it("passes 'upcoming' through", () => {
    expect(normalizeDayMode('upcoming')).toBe('upcoming')
  })

  it("defaults 'today' and unknown/empty/null values to 'today'", () => {
    expect(normalizeDayMode('today')).toBe('today')
    expect(normalizeDayMode('week')).toBe('today')
    expect(normalizeDayMode('')).toBe('today')
    expect(normalizeDayMode(null)).toBe('today')
    expect(normalizeDayMode(undefined)).toBe('today')
  })
})

describe('clockLabel', () => {
  it('formats 12-hour times with AM/PM', () => {
    expect(clockLabel(0, 0)).toBe('12:00 AM')
    expect(clockLabel(9, 5)).toBe('9:05 AM')
    expect(clockLabel(12, 0)).toBe('12:00 PM')
    expect(clockLabel(13, 30)).toBe('1:30 PM')
    expect(clockLabel(23, 59)).toBe('11:59 PM')
  })
})

describe('hasTimeOfDay', () => {
  it('treats date-only and midnight instants as all-day', () => {
    expect(hasTimeOfDay(null)).toBe(false)
    expect(hasTimeOfDay('2026-06-04')).toBe(false)
    expect(hasTimeOfDay('2026-06-04T00:00:00Z')).toBe(false)
  })
  it('detects an explicit non-midnight time', () => {
    expect(hasTimeOfDay('2026-06-04T09:30:00Z')).toBe(true)
    expect(hasTimeOfDay('2026-06-04T00:01:00Z')).toBe(true)
  })
  // The bug: a date-only due is stored at LOCAL midnight (dateInputToInstant),
  // so for a non-UTC user its ISO string has a non-zero UTC time. The old
  // string test read that as "timed" and rendered "12:00 AM". These cases use
  // the local-time Date constructor so they assert the fix in ANY runner zone.
  it('treats a local-midnight instant (date-only due) as all-day in any zone', () => {
    expect(hasTimeOfDay(new Date(2026, 5, 4).toISOString())).toBe(false)
  })
  it('treats a local timed instant as timed in any zone', () => {
    expect(hasTimeOfDay(new Date(2026, 5, 4, 14, 30).toISOString())).toBe(true)
  })
})

describe('fmtClock', () => {
  it('formats a wall-clock HH:MM(:SS) string in 12-hour form', () => {
    expect(fmtClock('09:00')).toBe('9:00 AM')
    expect(fmtClock('17:30')).toBe('5:30 PM')
    expect(fmtClock('09:30:00')).toBe('9:30 AM')
  })
  it('returns empty for null / unparseable input', () => {
    expect(fmtClock(null)).toBe('')
    expect(fmtClock('nope')).toBe('')
  })
})

describe('eventDayWindow', () => {
  it('reads "All day" when there is no start time', () => {
    expect(eventDayWindow(null, null)).toBe('All day')
    expect(eventDayWindow(null, '17:00')).toBe('All day')
  })
  it('renders the start–end window when both ends are set', () => {
    expect(eventDayWindow('09:00', '17:00')).toBe('9:00 AM – 5:00 PM')
  })
  it('falls back to just the start when the end is missing', () => {
    expect(eventDayWindow('09:00', null)).toBe('9:00 AM')
  })
})

describe('splitMyDay', () => {
  it('routes all-day tasks aside and sorts the timed schedule by instant', () => {
    const tasks = [
      task({ id: 'allday', dueDate: '2026-06-04' }),
      task({ id: 'late', dueDate: '2026-06-04T15:00:00Z' }),
      task({ id: 'early', dueDate: '2026-06-04T08:00:00Z' }),
    ]
    const events = [event({ id: 'ev', startAt: '2026-06-04T12:00:00Z' })]
    const { allDay, allDayEvents, timeline } = splitMyDay(tasks, events)

    expect(allDay.map((t) => t.id)).toEqual(['allday'])
    expect(allDayEvents).toEqual([])
    expect(timeline.map((e) => e.id)).toEqual(['early', 'ev', 'late'])
    expect(timeline.map((e) => e.kind)).toEqual(['task', 'event', 'task'])
  })

  it('routes all-day group days aside and merges timed group days into the schedule', () => {
    // Zone-less wall-clock instants so the comparison is tz-stable: a timed
    // group day at 09:00 sorts among the day's timed tasks/events by its own
    // start time.
    const tasks = [task({ id: 'noon', dueDate: '2026-06-04T12:00:00' })]
    const eventDays = [
      eventDay({ eventId: 'all', date: '2026-06-04', startTime: null }),
      eventDay({ eventId: 'morning', name: 'Morning', date: '2026-06-04', startTime: '09:00', endTime: '10:00' }),
    ]
    const { allDayEvents, timeline } = splitMyDay(tasks, [], eventDays)

    expect(allDayEvents.map((d) => d.eventId)).toEqual(['all'])
    expect(timeline.map((e) => e.id)).toEqual(['morning@2026-06-04', 'noon'])
    expect(timeline.map((e) => e.kind)).toEqual(['eventDay', 'task'])
    expect(timeline[0]?.eventDay?.name).toBe('Morning')
  })
})

describe('pickNext', () => {
  const timeline: ScheduleEntry[] = [
    { id: 'past', kind: 'task', title: 'Past', at: '2026-06-04T08:00:00Z' },
    { id: 'soon', kind: 'event', title: 'Soon', at: '2026-06-04T12:00:00Z' },
    { id: 'later', kind: 'task', title: 'Later', at: '2026-06-04T18:00:00Z' },
  ]
  it('returns the soonest entry at/after now', () => {
    const now = Date.parse('2026-06-04T10:00:00Z')
    expect(pickNext(timeline, now)?.id).toBe('soon')
  })
  it('returns null when everything is in the past', () => {
    const now = Date.parse('2026-06-04T20:00:00Z')
    expect(pickNext(timeline, now)).toBeNull()
  })
})

describe('progressPct', () => {
  it('returns 100 for an empty day (total = 0)', () => {
    expect(progressPct(0, 0)).toBe(100)
  })
  it('returns 0 when nothing is done', () => {
    expect(progressPct(0, 3)).toBe(0)
  })
  it('rounds to whole percent', () => {
    expect(progressPct(2, 4)).toBe(50)
  })
  it('clamps over-100 values to 100', () => {
    expect(progressPct(5, 4)).toBe(100)
  })
})

describe('dayDiff / relativeDayLabel', () => {
  it('counts calendar days regardless of tz', () => {
    expect(dayDiff('2026-06-04', '2026-06-04')).toBe(0)
    expect(dayDiff('2026-06-05', '2026-06-04')).toBe(1)
    expect(dayDiff('2026-06-11', '2026-06-04')).toBe(7)
    expect(dayDiff('2026-06-03', '2026-06-04')).toBe(-1)
  })
  it('labels near-term days relatively, far days by weekday', () => {
    expect(relativeDayLabel('2026-06-04', '2026-06-04')).toBe('Today')
    expect(relativeDayLabel('2026-06-05', '2026-06-04')).toBe('Tomorrow')
    expect(relativeDayLabel('2026-06-06', '2026-06-04')).toBe('In 2 days')
    expect(relativeDayLabel('2026-06-03', '2026-06-04')).toBe('Overdue')
    // 2026-06-12 is a Friday — 8 days out, past the "In N days" window.
    expect(relativeDayLabel('2026-06-12', '2026-06-04')).toBe('Friday')
  })
})

describe('groupUpcomingByDay', () => {
  // Midday, zone-less instants → local Y/M/D equals the literal date in any tz.
  const t = (id: string, date: string): UpcomingItem => ({
    kind: 'task',
    task: task({ id, dueDate: `${date}T12:00:00` }),
  })
  const ev = (id: string, date: string): UpcomingItem => ({
    kind: 'event',
    event: event({ id, startAt: `${date}T12:00:00` }),
  })

  const ed = (eventId: string, date: string): UpcomingItem => ({
    kind: 'eventDay',
    eventDay: eventDay({ eventId, date }),
  })

  it('groups by local day, preserving order and tagging relative labels', () => {
    const groups = groupUpcomingByDay(
      [t('a', '2026-06-04'), ev('b', '2026-06-04'), t('c', '2026-06-05')],
      '2026-06-04',
    )
    expect(groups.map((g) => g.ymd)).toEqual(['2026-06-04', '2026-06-05'])
    expect(groups[0]?.rel).toBe('Today')
    expect(groups[0]?.items).toHaveLength(2)
    expect(groups[1]?.rel).toBe('Tomorrow')
    expect(groups[1]?.items).toHaveLength(1)
  })

  it('groups an eventDay by its bare calendar date (no tz drift)', () => {
    const groups = groupUpcomingByDay([ed('fest', '2026-06-05'), t('a', '2026-06-04')], '2026-06-04')
    // Order is preserved as the BFF supplied it; each lands in its own day.
    expect(groups.map((g) => g.ymd)).toEqual(['2026-06-05', '2026-06-04'])
    expect(groups[0]?.items[0]?.kind).toBe('eventDay')
  })

  it('co-groups an eventDay with a task on the same calendar day', () => {
    const groups = groupUpcomingByDay([t('a', '2026-06-04'), ed('fest', '2026-06-04')], '2026-06-04')
    expect(groups).toHaveLength(1)
    expect(groups[0]?.ymd).toBe('2026-06-04')
    expect(groups[0]?.items.map((i) => i.kind)).toEqual(['task', 'eventDay'])
  })
})

describe('splitQuickNote', () => {
  it('returns null for empty / whitespace-only input', () => {
    expect(splitQuickNote('')).toBeNull()
    expect(splitQuickNote('   \n  \t ')).toBeNull()
  })

  it('uses a single line as the title with no body', () => {
    expect(splitQuickNote('Buy milk')).toEqual({ title: 'Buy milk' })
  })

  it('splits the first line as title and the rest as body', () => {
    expect(splitQuickNote('Groceries\neggs\nmilk')).toEqual({
      title: 'Groceries',
      notes: 'eggs\nmilk',
    })
  })

  it('trims surrounding whitespace and blank lines around the body', () => {
    expect(splitQuickNote('  Title  \n\n  body  \n\n')).toEqual({
      title: 'Title',
      notes: 'body',
    })
  })

  it('normalises CRLF line endings', () => {
    expect(splitQuickNote('Title\r\nbody')).toEqual({ title: 'Title', notes: 'body' })
  })

  it('overflows a >200-char first line into the body so nothing is lost', () => {
    const long = 'x'.repeat(250)
    const out = splitQuickNote(long)
    expect(out?.title).toHaveLength(200)
    expect(out?.notes).toBe('x'.repeat(50))
  })
})

describe('resolveNoteTitle', () => {
  it('uses a non-empty title field as-is (trimmed)', () => {
    expect(resolveNoteTitle('My note', 'some body')).toBe('My note')
    expect(resolveNoteTitle('  Padded  ', 'body')).toBe('Padded')
    expect(resolveNoteTitle('Title only', '')).toBe('Title only')
  })

  it('promotes the first body line when the title is empty', () => {
    expect(resolveNoteTitle('', 'First line\nSecond line')).toBe('First line')
    expect(resolveNoteTitle('', 'Only line')).toBe('Only line')
  })

  it('skips leading blank body lines when promoting', () => {
    expect(resolveNoteTitle('', '\n\nActual content\nMore')).toBe('Actual content')
  })

  it('falls back to (untitled) when both title and body are blank/whitespace', () => {
    expect(resolveNoteTitle('', '')).toBe('(untitled)')
    expect(resolveNoteTitle('   ', '   \n  \t ')).toBe('(untitled)')
  })

  it('normalises CRLF in body when promoting', () => {
    expect(resolveNoteTitle('', 'Line one\r\nLine two')).toBe('Line one')
  })
})

describe('toInstant', () => {
  it('returns undefined for a blank value', () => {
    expect(toInstant('')).toBeUndefined()
  })

  it('returns undefined for an unparseable value', () => {
    expect(toInstant('not-a-date')).toBeUndefined()
  })

  it('converts a datetime-local value to a Z-offset ISO instant', () => {
    const out = toInstant('2026-06-05T09:30')
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })
})

describe('instantToLocalInput', () => {
  it('returns "" for null / undefined / unparseable', () => {
    expect(instantToLocalInput(null)).toBe('')
    expect(instantToLocalInput(undefined)).toBe('')
    expect(instantToLocalInput('not-a-date')).toBe('')
  })

  it('round-trips with toInstant (same local wall-clock)', () => {
    const local = '2026-06-05T09:30'
    const instant = toInstant(local)
    expect(instant).toBeDefined()
    expect(instantToLocalInput(instant!)).toBe(local)
  })

  it('produces a value matching the datetime-local format', () => {
    expect(instantToLocalInput('2026-06-05T09:30:00.000Z')).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/,
    )
  })
})

describe('LIST_CONFIRM_TIMEOUT_MS', () => {
  it('is 4000ms', () => {
    expect(LIST_CONFIRM_TIMEOUT_MS).toBe(4000)
  })
})

describe('nextConfirmListId', () => {
  it('returns the listId when action is open', () => {
    expect(nextConfirmListId(null, { type: 'open', listId: 'abc' })).toBe('abc')
    expect(nextConfirmListId('xyz', { type: 'open', listId: 'abc' })).toBe('abc')
  })
  it('replaces any pending confirm when a different list opens', () => {
    expect(nextConfirmListId('list-1', { type: 'open', listId: 'list-2' })).toBe('list-2')
  })
  it('returns null on cancel', () => {
    expect(nextConfirmListId('abc', { type: 'cancel' })).toBeNull()
    expect(nextConfirmListId(null, { type: 'cancel' })).toBeNull()
  })
  it('returns null on confirm (delete)', () => {
    expect(nextConfirmListId('abc', { type: 'confirm' })).toBeNull()
  })
})

// This describe block pins TZ to America/Los_Angeles via beforeAll/afterAll so
// the local-vs-UTC anchor divergence is always observable, regardless of the
// host timezone. Under UTC, the old broken implementation (anchoring to UTC
// midnight) and the new correct one produce identical output, so the regression
// test would be meaningless. Pinning to a negative-UTC-offset timezone ensures
// the test catches the bug even on CI (which typically runs under UTC).
describe('dateInputToInstant / instantToDateInput', () => {
  const ORIG_TZ = process.env.TZ
  beforeAll(() => { process.env.TZ = 'America/Los_Angeles' })
  afterAll(() => {
    if (ORIG_TZ === undefined) delete process.env.TZ
    else process.env.TZ = ORIG_TZ
  })

  it('round-trips a YYYY-MM-DD value', () => {
    const instant = dateInputToInstant('2026-06-09')
    expect(instant).not.toBeNull()
    expect(instantToDateInput(instant!)).toBe('2026-06-09')
  })

  it('anchors to LOCAL midnight, not UTC midnight', () => {
    // In America/Los_Angeles (UTC-7 in June) local midnight for 2026-06-09 is
    // 2026-06-09T07:00:00.000Z — NOT 2026-06-09T00:00:00.000Z.
    // new Date(2026, 5, 9) builds the same local-midnight instant.
    const expected = new Date(2026, 5, 9).toISOString()
    expect(dateInputToInstant('2026-06-09')).toBe(expected)
    expect(dateInputToInstant('2026-06-09')).not.toBe('2026-06-09T00:00:00.000Z')
  })

  it('returns null for an empty or blank value', () => {
    expect(dateInputToInstant('')).toBeNull()
  })

  it('returns "" for null / unparseable input', () => {
    expect(instantToDateInput(null)).toBe('')
    expect(instantToDateInput('not-a-date')).toBe('')
  })
})

// ── buildMonthGrid / buildWeekStrip (#423 calendar helpers) ────────
//
// Tests are pinned to America/Los_Angeles (UTC-7 in summer) so that
// day-boundary behaviour is visible even on UTC CI hosts.
describe('buildMonthGrid', () => {
  const ORIG_TZ = process.env.TZ
  beforeAll(() => { process.env.TZ = 'America/Los_Angeles' })
  afterAll(() => {
    if (ORIG_TZ === undefined) delete process.env.TZ
    else process.env.TZ = ORIG_TZ
  })

  // Helper: flat item on a given YYYY-MM-DD date
  const item = (id: string, date: string): UpcomingItem => ({
    kind: 'task',
    task: task({ id, dueDate: `${date}T12:00:00` }),
  })

  it('produces a grid of week rows where every row has 7 cells', () => {
    const groups = groupUpcomingByDay([], '2026-06-01')
    const rows = buildMonthGrid(groups, 2026, 6)
    for (const row of rows) {
      expect(row).toHaveLength(7)
    }
    // June 2026 starts on a Monday; with weekStart=0 (Sun) there should be 5
    // rows (leading Sunday from May, then Mon 1 Jun … Sat 27 Jun, last row
    // Sun 28 – Sat 4 Jul).
    expect(rows.length).toBeGreaterThanOrEqual(4)
    expect(rows.length).toBeLessThanOrEqual(6)
  })

  it('marks leading cells from the previous month as inCurrentMonth=false', () => {
    // June 2026 starts on a Monday, so with Sunday week-start the first cell
    // is Sunday May 31 (inCurrentMonth=false).
    const groups = groupUpcomingByDay([], '2026-06-01')
    const rows = buildMonthGrid(groups, 2026, 6, 0)
    const firstCell = rows[0]![0]!
    expect(firstCell.date).toBe('2026-05-31')
    expect(firstCell.inCurrentMonth).toBe(false)
  })

  it('marks trailing cells from the next month as inCurrentMonth=false', () => {
    // June has 30 days. The last cell in the grid after Jun 30 should be July.
    const groups = groupUpcomingByDay([], '2026-06-01')
    const rows = buildMonthGrid(groups, 2026, 6, 0)
    const lastRow = rows[rows.length - 1]!
    const lastCell = lastRow[lastRow.length - 1]!
    // Last row ends in early July.
    expect(lastCell.inCurrentMonth).toBe(false)
    expect(lastCell.date.startsWith('2026-07')).toBe(true)
  })

  it('places items in the correct day cell using LOCAL day', () => {
    // An item due at local noon on June 9 must land in the June 9 cell.
    const groups = groupUpcomingByDay(
      [item('a', '2026-06-09'), item('b', '2026-06-15')],
      '2026-06-01',
    )
    const rows = buildMonthGrid(groups, 2026, 6, 0)
    const flat: CalendarCell[] = rows.flat()

    const jun9 = flat.find((c) => c.date === '2026-06-09')!
    expect(jun9).toBeDefined()
    expect(jun9.items).toHaveLength(1)
    expect(jun9.items[0]?.kind === 'task' && jun9.items[0].task.id).toBe('a')

    const jun15 = flat.find((c) => c.date === '2026-06-15')!
    expect(jun15).toBeDefined()
    expect(jun15.items).toHaveLength(1)
  })

  it('empty days have an empty items array', () => {
    const groups = groupUpcomingByDay([], '2026-06-01')
    const rows = buildMonthGrid(groups, 2026, 6, 0)
    const flat: CalendarCell[] = rows.flat()
    for (const cell of flat) {
      if (cell.date !== '2026-06-09') {
        expect(cell.items).toHaveLength(0)
      }
    }
    // Re-run with actual item to verify the non-empty case is tested above:
    // (the empty-day test just verifies the default shape)
    const grouped2 = groupUpcomingByDay([item('x', '2026-06-09')], '2026-06-01')
    const rows2 = buildMonthGrid(grouped2, 2026, 6, 0)
    const flat2: CalendarCell[] = rows2.flat()
    const withItems = flat2.filter((c) => c.items.length > 0)
    expect(withItems).toHaveLength(1)
    expect(withItems[0]!.date).toBe('2026-06-09')
  })

  it('excludes undated items (they have no ymd in the groups map)', () => {
    // undated tasks are in data.undated, not in groupUpcomingByDay output — so
    // they never enter the groups array and never appear in a calendar cell.
    const undatedTask: UpcomingItem = {
      kind: 'task',
      task: task({ id: 'noDue', dueDate: null }),
    }
    const groups = groupUpcomingByDay([undatedTask], '2026-06-01')
    // groupUpcomingByDay skips items with null ymd — groups should be empty.
    expect(groups).toHaveLength(0)
    const rows = buildMonthGrid(groups, 2026, 6, 0)
    const flat: CalendarCell[] = rows.flat()
    expect(flat.every((c) => c.items.length === 0)).toBe(true)
  })

  it('week-start=1 (Monday) shifts the grid so Monday is the first column', () => {
    // June 2026 starts on Monday — with Monday week-start, the first cell of
    // the first row should be June 1 itself (no leading adjacent-month cell).
    const groups = groupUpcomingByDay([], '2026-06-01')
    const rows = buildMonthGrid(groups, 2026, 6, 1)
    const firstCell = rows[0]![0]!
    expect(firstCell.date).toBe('2026-06-01')
    expect(firstCell.inCurrentMonth).toBe(true)
  })

  it('handles a month boundary correctly (Dec → Jan year rollover)', () => {
    const groups = groupUpcomingByDay([], '2026-12-01')
    const rows = buildMonthGrid(groups, 2026, 12, 0)
    // Last row must contain cells dated 2027-01-xx (trailing days in January).
    const lastRow = rows[rows.length - 1]!
    const trailingJan = lastRow.filter((c) => c.date.startsWith('2027-01'))
    expect(trailingJan.length).toBeGreaterThan(0)
    expect(trailingJan.every((c) => !c.inCurrentMonth)).toBe(true)
  })
})

describe('buildWeekStrip', () => {
  const ORIG_TZ = process.env.TZ
  beforeAll(() => { process.env.TZ = 'America/Los_Angeles' })
  afterAll(() => {
    if (ORIG_TZ === undefined) delete process.env.TZ
    else process.env.TZ = ORIG_TZ
  })

  const item = (id: string, date: string): UpcomingItem => ({
    kind: 'task',
    task: task({ id, dueDate: `${date}T12:00:00` }),
  })

  it('always produces exactly 7 cells', () => {
    const groups = groupUpcomingByDay([], '2026-06-09')
    const cells = buildWeekStrip(groups, '2026-06-09', 0)
    expect(cells).toHaveLength(7)
  })

  it('with Sunday week-start, first cell is the Sunday of the anchor week', () => {
    // 2026-06-09 is a Tuesday; the Sunday of that week is Jun 7.
    const groups = groupUpcomingByDay([], '2026-06-09')
    const cells = buildWeekStrip(groups, '2026-06-09', 0)
    expect(cells[0]!.date).toBe('2026-06-07')
    expect(cells[6]!.date).toBe('2026-06-13')
  })

  it('with Monday week-start, first cell is the Monday of the anchor week', () => {
    // 2026-06-09 is a Tuesday; the Monday of that week is Jun 8.
    const groups = groupUpcomingByDay([], '2026-06-09')
    const cells = buildWeekStrip(groups, '2026-06-09', 1)
    expect(cells[0]!.date).toBe('2026-06-08')
    expect(cells[6]!.date).toBe('2026-06-14')
  })

  it('places items in the correct cell', () => {
    const groups = groupUpcomingByDay(
      [item('tue', '2026-06-09'), item('fri', '2026-06-12')],
      '2026-06-09',
    )
    const cells = buildWeekStrip(groups, '2026-06-09', 0)
    const tueSell = cells.find((c) => c.date === '2026-06-09')!
    expect(tueSell.items).toHaveLength(1)
    const friCell = cells.find((c) => c.date === '2026-06-12')!
    expect(friCell.items).toHaveLength(1)
    // Empty days
    const monCell = cells.find((c) => c.date === '2026-06-08')!
    expect(monCell.items).toHaveLength(0)
  })

  it('inCurrentMonth is always true for week cells', () => {
    // Week strip spans month boundaries (e.g. Jun 28 – Jul 4) but inCurrentMonth
    // is not meaningful for week view — the helper always sets it to true.
    const groups = groupUpcomingByDay([], '2026-06-28')
    const cells = buildWeekStrip(groups, '2026-06-28', 0)
    expect(cells.every((c) => c.inCurrentMonth)).toBe(true)
  })

  it('excludes undated items', () => {
    const undated: UpcomingItem = { kind: 'task', task: task({ id: 'nd', dueDate: null }) }
    const groups = groupUpcomingByDay([undated], '2026-06-09')
    expect(groups).toHaveLength(0)
    const cells = buildWeekStrip(groups, '2026-06-09', 0)
    expect(cells.every((c) => c.items.length === 0)).toBe(true)
  })

  it('handles a year boundary correctly (Dec 28 anchor → Dec 27 – Jan 2)', () => {
    // 2026-12-28 is a Monday. With Sunday week-start (weekStart=0) the strip
    // starts on the preceding Sunday 2026-12-27 and ends on 2027-01-02,
    // crossing the year boundary.
    const groups = groupUpcomingByDay([], '2026-12-28')
    const cells = buildWeekStrip(groups, '2026-12-28', 0)
    expect(cells).toHaveLength(7)
    expect(cells[0]!.date).toBe('2026-12-27')
    expect(cells[1]!.date).toBe('2026-12-28')
    expect(cells[2]!.date).toBe('2026-12-29')
    expect(cells[3]!.date).toBe('2026-12-30')
    expect(cells[4]!.date).toBe('2026-12-31')
    expect(cells[5]!.date).toBe('2027-01-01')
    expect(cells[6]!.date).toBe('2027-01-02')
    // inCurrentMonth is always true for week cells regardless of year boundary.
    expect(cells.every((c) => c.inCurrentMonth)).toBe(true)
  })
})

// ── quick-add date conversion contract (#430) ──────────────────────
// These assertions pin the expected quick-add form behaviour: an empty
// date field must yield null (no dueDate sent) and a filled one must
// yield the local-midnight instant (not UTC midnight). They reuse the
// same TZ override pattern above to stay meaningful on UTC hosts.
describe('quick-add date conversion (dateInputToInstant contract for AddTaskForm)', () => {
  const ORIG_TZ = process.env.TZ
  beforeAll(() => { process.env.TZ = 'America/Los_Angeles' })
  afterAll(() => {
    if (ORIG_TZ === undefined) delete process.env.TZ
    else process.env.TZ = ORIG_TZ
  })

  it('empty date input → null (no dueDate forwarded to API)', () => {
    // When the user leaves the date field blank the submit handler should
    // omit dueDate entirely; dateInputToInstant('') must return null.
    expect(dateInputToInstant('')).toBeNull()
  })

  it('filled date input → local-midnight ISO instant (not UTC midnight)', () => {
    // A quick-added task due "today" for a west-of-UTC user must anchor to
    // local midnight so it falls inside that user's local-day window on
    // the read side (composeMyDay / composeUpcoming zonedDayWindow).
    const result = dateInputToInstant('2026-06-09')
    const localMidnight = new Date(2026, 5, 9).toISOString() // local midnight
    const utcMidnight = '2026-06-09T00:00:00.000Z'
    expect(result).toBe(localMidnight)
    expect(result).not.toBe(utcMidnight)
  })
})


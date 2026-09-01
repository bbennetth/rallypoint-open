import { describe, expect, it } from 'vitest'
import { bucketTasks, dueChip, partitionTasks } from './tasks-helpers.js'

const t = (id: string, completed: boolean) => ({ id, completed })

describe('partitionTasks', () => {
  it('returns two empty groups for an empty list', () => {
    expect(partitionTasks([])).toEqual({ open: [], completed: [] })
  })

  it('keeps an all-open list intact', () => {
    const items = [t('a', false), t('b', false)]
    expect(partitionTasks(items)).toEqual({ open: items, completed: [] })
  })

  it('keeps an all-completed list intact', () => {
    const items = [t('a', true), t('b', true)]
    expect(partitionTasks(items)).toEqual({ open: [], completed: items })
  })

  it('splits a mixed list preserving relative order within each group', () => {
    const items = [t('a', true), t('b', false), t('c', true), t('d', false), t('e', true)]
    const { open, completed } = partitionTasks(items)
    expect(open.map((i) => i.id)).toEqual(['b', 'd'])
    expect(completed.map((i) => i.id)).toEqual(['a', 'c', 'e'])
  })

  it('does not mutate the input', () => {
    const items = [t('a', true), t('b', false)]
    const snapshot = [...items]
    partitionTasks(items)
    expect(items).toEqual(snapshot)
  })
})

// Local-time instants, matching how the page compares (client-local calendar
// day). Month is 0-based throughout.
const iso = (y: number, m: number, d: number, h = 12, min = 0) =>
  new Date(y, m, d, h, min).toISOString()

const task = (id: string, dueDate: string | null, completed = false) => ({
  id,
  dueDate,
  completed,
})

const ids = (items: readonly { id: string }[]) => items.map((i) => i.id)

describe('bucketTasks', () => {
  // 2026-07-22 is a Wednesday.
  const WED = new Date(2026, 6, 22, 15, 30)

  it('splits around the local midnight boundary', () => {
    const buckets = bucketTasks(
      [
        task('start', iso(2026, 6, 22, 0, 0)),
        task('end', iso(2026, 6, 22, 23, 59)),
        task('lastnight', iso(2026, 6, 21, 23, 59)),
        task('tomorrow', iso(2026, 6, 23, 0, 0)),
      ],
      WED,
    )
    expect(ids(buckets.today)).toEqual(['start', 'end'])
    expect(ids(buckets.overdue)).toEqual(['lastnight'])
    expect(ids(buckets.thisWeek)).toEqual(['tomorrow'])
  })

  it('never buckets skipped occurrences, even if the completed mirror drifted', () => {
    const buckets = bucketTasks(
      [
        // Normal shape: the recurrence sweep sets completed=true.
        { ...task('swept', iso(2026, 6, 20)), completed: true, status: 'skipped' },
        // Drifted shape: status says skipped but completed never mirrored.
        { ...task('drifted', iso(2026, 6, 20)), status: 'skipped' },
        { ...task('open', iso(2026, 6, 20)), status: 'todo' },
      ],
      WED,
    )
    expect(ids(buckets.overdue)).toEqual(['open'])
  })

  it('bounds "this week" at Sunday of the current ISO week', () => {
    const buckets = bucketTasks(
      [
        task('sat', iso(2026, 6, 25)),
        task('sun', iso(2026, 6, 26)),
        task('nextMon', iso(2026, 6, 27)),
      ],
      WED,
    )
    expect(ids(buckets.thisWeek)).toEqual(['sat', 'sun'])
    expect(ids(buckets.later)).toEqual(['nextMon'])
  })

  it('on a Sunday, tomorrow is already next week', () => {
    const sunday = new Date(2026, 6, 26, 9, 0)
    const buckets = bucketTasks(
      [task('today', iso(2026, 6, 26)), task('mon', iso(2026, 6, 27))],
      sunday,
    )
    expect(ids(buckets.today)).toEqual(['today'])
    expect(buckets.thisWeek).toEqual([])
    expect(ids(buckets.later)).toEqual(['mon'])
  })

  it('sends anything before today to overdue, however old', () => {
    const buckets = bucketTasks(
      [task('lastWeek', iso(2026, 6, 15)), task('lastMonth', iso(2026, 5, 10))],
      WED,
    )
    expect(ids(buckets.overdue)).toEqual(['lastMonth', 'lastWeek'])
  })

  it('sends null and unparseable due dates to undated, in input order', () => {
    const buckets = bucketTasks(
      [task('a', null), task('b', 'not-a-date'), task('c', null)],
      WED,
    )
    expect(ids(buckets.undated)).toEqual(['a', 'b', 'c'])
  })

  it('excludes completed items from every bucket', () => {
    const buckets = bucketTasks(
      [
        task('doneToday', iso(2026, 6, 22), true),
        task('doneNever', null, true),
        task('open', iso(2026, 6, 22)),
      ],
      WED,
    )
    expect(ids(buckets.today)).toEqual(['open'])
    expect(Object.values(buckets).flat()).toHaveLength(1)
  })

  it('sorts dated buckets soonest-first, keeping API order on same-day ties', () => {
    const buckets = bucketTasks(
      [
        task('aug5', iso(2026, 7, 5)),
        task('jul30-a', iso(2026, 6, 30, 18)),
        task('jul30-b', iso(2026, 6, 30, 8)),
      ],
      WED,
    )
    expect(ids(buckets.later)).toEqual(['jul30-a', 'jul30-b', 'aug5'])
  })

  it('does not mutate the input', () => {
    const items = [task('a', iso(2026, 6, 30)), task('b', null)]
    const snapshot = [...items]
    bucketTasks(items, WED)
    expect(items).toEqual(snapshot)
  })
})

describe('dueChip', () => {
  it('shows no chip in Today or No date', () => {
    expect(dueChip('today', iso(2026, 6, 22), 'en-US')).toBeNull()
    expect(dueChip('undated', null, 'en-US')).toBeNull()
  })

  it('shows the short weekday for This week', () => {
    // 2026-07-23 is a Thursday.
    expect(dueChip('thisWeek', iso(2026, 6, 23), 'en-US')).toEqual({
      label: 'Thu',
      hot: false,
    })
  })

  it('shows the missed date, hot, for Overdue', () => {
    expect(dueChip('overdue', iso(2026, 5, 9), 'en-US')).toEqual({
      label: 'Jun 9',
      hot: true,
    })
  })

  it('shows the date for Later', () => {
    expect(dueChip('later', iso(2026, 5, 30), 'en-US')).toEqual({
      label: 'Jun 30',
      hot: false,
    })
  })

  it('is null-safe on missing or unparseable dates', () => {
    expect(dueChip('later', null, 'en-US')).toBeNull()
    expect(dueChip('overdue', 'not-a-date', 'en-US')).toBeNull()
  })
})

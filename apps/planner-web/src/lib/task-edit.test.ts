import { describe, it, expect } from 'vitest'
import {
  applyPatchToState,
  buildTaskPatch,
  pickDefaultList,
  taskEditState,
  type TaskEditState,
} from './task-edit.js'
import { combineDueDateTime, dateInputToInstant, instantToDateInput } from './planner-helpers.js'

const base: TaskEditState = { title: 'Walk the dog', priority: null, dueInput: '', dueTimeInput: '' }

describe('taskEditState', () => {
  it('maps a task into the editable baseline, splitting a date-only due', () => {
    const due = dateInputToInstant('2026-06-15')!
    expect(taskEditState({ title: 'T', priority: 'high', dueDate: due })).toEqual({
      title: 'T',
      priority: 'high',
      dueInput: '2026-06-15',
      dueTimeInput: '',
    })
    expect(taskEditState({ title: 'T', priority: null, dueDate: null })).toEqual({
      title: 'T',
      priority: null,
      dueInput: '',
      dueTimeInput: '',
    })
  })

  it('pre-fills the time input for a timed due', () => {
    const timed = combineDueDateTime('2026-06-15', '14:30')!
    expect(taskEditState({ title: 'T', priority: null, dueDate: timed })).toEqual({
      title: 'T',
      priority: null,
      dueInput: '2026-06-15',
      dueTimeInput: '14:30',
    })
  })
})

describe('buildTaskPatch', () => {
  it('returns null when nothing changed', () => {
    expect(buildTaskPatch(base, { ...base })).toBeNull()
  })

  it('includes only changed fields', () => {
    expect(buildTaskPatch(base, { ...base, title: 'Feed the dog' })).toEqual({
      title: 'Feed the dog',
    })
    expect(buildTaskPatch(base, { ...base, priority: 'high' })).toEqual({ priority: 'high' })
  })

  it('trims the title and skips a whitespace-only title change', () => {
    expect(buildTaskPatch(base, { ...base, title: '  Feed the dog  ' })).toEqual({
      title: 'Feed the dog',
    })
    expect(buildTaskPatch(base, { ...base, title: '   ' })).toBeNull()
  })

  it('treats a trimmed-equal title as unchanged', () => {
    expect(buildTaskPatch(base, { ...base, title: '  Walk the dog ' })).toBeNull()
  })

  it('converts a set due date to a local-midnight instant and clears with null', () => {
    const patch = buildTaskPatch(base, { ...base, dueInput: '2026-06-15' })
    expect(patch).toEqual({ dueDate: dateInputToInstant('2026-06-15') })

    const withDue: TaskEditState = { ...base, dueInput: '2026-06-15' }
    expect(buildTaskPatch(withDue, { ...withDue, dueInput: '' })).toEqual({ dueDate: null })
  })

  it('combines date + time into a timed instant, and a time-only change re-emits dueDate', () => {
    const patch = buildTaskPatch(base, { ...base, dueInput: '2026-06-15', dueTimeInput: '14:30' })
    expect(patch).toEqual({ dueDate: combineDueDateTime('2026-06-15', '14:30') })

    const dated: TaskEditState = { ...base, dueInput: '2026-06-15' }
    expect(buildTaskPatch(dated, { ...dated, dueTimeInput: '09:00' })).toEqual({
      dueDate: combineDueDateTime('2026-06-15', '09:00'),
    })
  })

  it('clearing priority back to null is a change', () => {
    const withPri: TaskEditState = { ...base, priority: 'low' }
    expect(buildTaskPatch(withPri, { ...withPri, priority: null })).toEqual({ priority: null })
  })
})

describe('applyPatchToState', () => {
  it('advances the baseline by the saved patch only', () => {
    const next = applyPatchToState(base, { title: 'New', dueDate: dateInputToInstant('2026-07-01') })
    expect(next.title).toBe('New')
    expect(next.priority).toBeNull()
    expect(next.dueInput).toBe('2026-07-01')
    expect(next.dueTimeInput).toBe('')
  })

  it('round-trips a timed due then a cleared due', () => {
    const timedPatch = { dueDate: combineDueDateTime('2026-07-01', '08:15') }
    const timed = applyPatchToState(base, timedPatch)
    expect(timed.dueInput).toBe('2026-07-01')
    expect(timed.dueTimeInput).toBe('08:15')
    expect(applyPatchToState(timed, { dueDate: null }).dueTimeInput).toBe('')
  })

  it('successive diffs against the advanced baseline are empty', () => {
    const draft: TaskEditState = {
      title: 'New',
      priority: 'high',
      dueInput: '2026-07-01',
      dueTimeInput: '14:30',
    }
    const patch = buildTaskPatch(base, draft)!
    const next = applyPatchToState(base, patch)
    expect(buildTaskPatch(next, draft)).toBeNull()
  })
})

describe('pickDefaultList', () => {
  const lists = [{ id: 'a' }, { id: 'b' }]

  it('prefers the stored id when it still exists', () => {
    expect(pickDefaultList(lists, 'b')).toBe('b')
  })

  it('falls back to the first list when the stored id is gone or unset', () => {
    expect(pickDefaultList(lists, 'zz')).toBe('a')
    expect(pickDefaultList(lists, null)).toBe('a')
  })

  it("returns '' when there are no lists", () => {
    expect(pickDefaultList([], 'a')).toBe('')
  })
})

describe('due-date round-trip', () => {
  it('instantToDateInput(dateInputToInstant(x)) === x', () => {
    expect(instantToDateInput(dateInputToInstant('2026-06-15'))).toBe('2026-06-15')
  })
})

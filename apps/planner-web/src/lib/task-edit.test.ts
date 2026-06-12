import { describe, it, expect } from 'vitest'
import {
  applyPatchToState,
  buildTaskPatch,
  pickDefaultList,
  taskEditState,
  type TaskEditState,
} from './task-edit.js'
import { dateInputToInstant, instantToDateInput } from './planner-helpers.js'

const base: TaskEditState = { title: 'Walk the dog', priority: null, dueInput: '' }

describe('taskEditState', () => {
  it('maps a task into the editable baseline, converting dueDate to input form', () => {
    const due = dateInputToInstant('2026-06-15')!
    expect(taskEditState({ title: 'T', priority: 'high', dueDate: due })).toEqual({
      title: 'T',
      priority: 'high',
      dueInput: '2026-06-15',
    })
    expect(taskEditState({ title: 'T', priority: null, dueDate: null })).toEqual({
      title: 'T',
      priority: null,
      dueInput: '',
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
    // Emptying the title is not a save — a task keeps its last real title.
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
  })

  it('round-trips a cleared due date', () => {
    const withDue: TaskEditState = { ...base, dueInput: '2026-07-01' }
    expect(applyPatchToState(withDue, { dueDate: null }).dueInput).toBe('')
  })

  it('successive diffs against the advanced baseline are empty', () => {
    const draft: TaskEditState = { title: 'New', priority: 'high', dueInput: '2026-07-01' }
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

// Sanity: the input<->instant round-trip the editor relies on.
describe('due-date round-trip', () => {
  it('instantToDateInput(dateInputToInstant(x)) === x', () => {
    expect(instantToDateInput(dateInputToInstant('2026-06-15'))).toBe('2026-06-15')
  })
})

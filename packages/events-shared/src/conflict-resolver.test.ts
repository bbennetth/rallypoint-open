import { describe, it, expect } from 'vitest'
import { findConflicts, type LabeledSet, type DueThing } from './conflict-resolver.js'

const set = (label: string, start: number, end: number): LabeledSet => ({ label, start, end })
const thing = (id: string, at: number, kind: 'task' | 'rally' = 'task'): DueThing => ({
  id,
  title: id,
  at,
  kind,
})

describe('findConflicts', () => {
  it('flags a task due inside a set', () => {
    const sets = [set('Headliner', 100, 200)]
    const out = findConflicts(sets, [thing('t1', 150)])
    expect(out).toHaveLength(1)
    expect(out[0]!.id).toBe('t1')
    expect(out[0]!.sets.map((s) => s.label)).toEqual(['Headliner'])
  })

  it('does not flag a thing outside every set', () => {
    const sets = [set('A', 100, 200)]
    expect(findConflicts(sets, [thing('t1', 50)])).toHaveLength(0)
    expect(findConflicts(sets, [thing('t1', 250)])).toHaveLength(0)
  })

  it('treats the range as half-open: start conflicts, end does not', () => {
    const sets = [set('A', 100, 200)]
    expect(findConflicts(sets, [thing('start', 100)])).toHaveLength(1)
    expect(findConflicts(sets, [thing('end', 200)])).toHaveLength(0)
  })

  it('reports every overlapping set when sets overlap', () => {
    const sets = [set('A', 100, 300), set('B', 200, 400)]
    const out = findConflicts(sets, [thing('t1', 250)])
    expect(out).toHaveLength(1)
    expect(out[0]!.sets.map((s) => s.label).sort()).toEqual(['A', 'B'])
  })

  it('preserves the kind of the conflicting thing', () => {
    const sets = [set('A', 100, 200)]
    const out = findConflicts(sets, [thing('r1', 150, 'rally')])
    expect(out[0]!.kind).toBe('rally')
  })

  it('returns nothing for empty inputs', () => {
    expect(findConflicts([], [thing('t1', 150)])).toHaveLength(0)
    expect(findConflicts([set('A', 100, 200)], [])).toHaveLength(0)
  })

  it('flags multiple things independently', () => {
    const sets = [set('A', 100, 200)]
    const out = findConflicts(sets, [thing('in', 150), thing('out', 500), thing('in2', 120)])
    expect(out.map((c) => c.id).sort()).toEqual(['in', 'in2'])
  })
})

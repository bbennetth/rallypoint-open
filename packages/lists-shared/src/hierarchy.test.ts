import { describe, it, expect } from 'vitest'
import {
  validateParentAssignment,
  childRollup,
  MAX_PARENT_DEPTH,
} from './hierarchy.js'

function parentMap(pairs: Array<[string, string | null]>): Map<string, string | null> {
  return new Map(pairs)
}

describe('validateParentAssignment', () => {
  it('rejects self-parenting', () => {
    const m = parentMap([['a', null]])
    expect(validateParentAssignment(m, 'a', 'a')).toBe('self')
  })

  it('rejects an unknown parent', () => {
    const m = parentMap([['a', null]])
    expect(validateParentAssignment(m, 'a', 'ghost')).toBe('missing')
  })

  it('allows a simple top-level parent', () => {
    const m = parentMap([
      ['a', null],
      ['b', null],
    ])
    expect(validateParentAssignment(m, 'b', 'a')).toBe('ok')
  })

  it('detects a direct cycle (parent is a child of the item)', () => {
    // a is parent of b; trying to set a.parent = b closes a 2-cycle.
    const m = parentMap([
      ['a', null],
      ['b', 'a'],
    ])
    expect(validateParentAssignment(m, 'a', 'b')).toBe('cycle')
  })

  it('detects a deep cycle', () => {
    // chain a → b → c (c child of b child of a). Setting a.parent = c cycles.
    const m = parentMap([
      ['a', null],
      ['b', 'a'],
      ['c', 'b'],
    ])
    expect(validateParentAssignment(m, 'a', 'c')).toBe('cycle')
  })

  it('enforces the depth cap at the boundary', () => {
    // Chain r0(depth 0) → r1 → … → r5(depth MAX_PARENT_DEPTH). r{i} has depth i.
    const pairs: Array<[string, string | null]> = [['r0', null]]
    for (let i = 1; i <= MAX_PARENT_DEPTH; i++) pairs.push([`r${i}`, `r${i - 1}`])
    pairs.push(['x', null])
    const m = parentMap(pairs)
    // Under r0 (depth 0) → x at depth 1: fine.
    expect(validateParentAssignment(m, 'x', 'r0')).toBe('ok')
    // Boundary: under r4 (depth 4) → x at depth 5 == cap: still allowed.
    expect(validateParentAssignment(m, 'x', `r${MAX_PARENT_DEPTH - 1}`)).toBe('ok')
    // Under r5 (depth 5) → x at depth 6: one past the cap.
    expect(validateParentAssignment(m, 'x', `r${MAX_PARENT_DEPTH}`)).toBe('too_deep')
  })

  it('survives a pre-existing corrupt cycle upstream without infinite loop', () => {
    // b ↔ c corrupt cycle; assigning a under b must not hang.
    const m = parentMap([
      ['a', null],
      ['b', 'c'],
      ['c', 'b'],
    ])
    const r = validateParentAssignment(m, 'a', 'b')
    expect(['too_deep', 'ok']).toContain(r)
  })
})

describe('childRollup', () => {
  it('counts direct children and done children per parent', () => {
    const roll = childRollup([
      { id: 'p', parentId: null, completed: false },
      { id: 'c1', parentId: 'p', completed: true },
      { id: 'c2', parentId: 'p', completed: false },
      { id: 'c3', parentId: 'p', completed: true },
      { id: 'top', parentId: null, completed: false },
    ])
    expect(roll.get('p')).toEqual({ total: 3, done: 2 })
    expect(roll.has('top')).toBe(false)
  })

  it('returns an empty map when nothing is nested', () => {
    const roll = childRollup([
      { id: 'a', parentId: null, completed: false },
      { id: 'b', parentId: null, completed: true },
    ])
    expect(roll.size).toBe(0)
  })
})

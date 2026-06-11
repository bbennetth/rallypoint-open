import { describe, it, expect } from 'vitest'
import { gridKeyAction } from './grid-keys.js'

describe('gridKeyAction', () => {
  it('returns none for an empty grid regardless of key', () => {
    for (const key of ['j', 'k', 'x', 'e']) {
      expect(gridKeyAction(key, { activeRow: 0, rowCount: 0 })).toEqual({ type: 'none' })
    }
  })

  it('j moves down, clamped at the last row', () => {
    expect(gridKeyAction('j', { activeRow: 0, rowCount: 3 })).toEqual({ type: 'move', row: 1 })
    expect(gridKeyAction('j', { activeRow: 2, rowCount: 3 })).toEqual({ type: 'move', row: 2 })
  })

  it('k moves up, clamped at the first row', () => {
    expect(gridKeyAction('k', { activeRow: 2, rowCount: 3 })).toEqual({ type: 'move', row: 1 })
    expect(gridKeyAction('k', { activeRow: 0, rowCount: 3 })).toEqual({ type: 'move', row: 0 })
  })

  it('k from an unset (-1) active row lands on the first row', () => {
    expect(gridKeyAction('k', { activeRow: -1, rowCount: 3 })).toEqual({ type: 'move', row: 0 })
  })

  it('j from an unset (-1) active row lands on the first row', () => {
    expect(gridKeyAction('j', { activeRow: -1, rowCount: 3 })).toEqual({ type: 'move', row: 0 })
  })

  it('j clamps when the active row is already past the last row', () => {
    expect(gridKeyAction('j', { activeRow: 10, rowCount: 3 })).toEqual({ type: 'move', row: 2 })
  })

  it('x selects only when the active row is in range', () => {
    expect(gridKeyAction('x', { activeRow: 1, rowCount: 3 })).toEqual({ type: 'select' })
    expect(gridKeyAction('x', { activeRow: -1, rowCount: 3 })).toEqual({ type: 'none' })
    expect(gridKeyAction('x', { activeRow: 5, rowCount: 3 })).toEqual({ type: 'none' })
  })

  it('e edits only when the active row is in range', () => {
    expect(gridKeyAction('e', { activeRow: 0, rowCount: 3 })).toEqual({ type: 'edit' })
    expect(gridKeyAction('e', { activeRow: -1, rowCount: 3 })).toEqual({ type: 'none' })
    expect(gridKeyAction('e', { activeRow: 9, rowCount: 3 })).toEqual({ type: 'none' })
  })

  it('returns none for unmapped keys', () => {
    for (const key of ['a', 'Enter', 'ArrowDown', ' ']) {
      expect(gridKeyAction(key, { activeRow: 0, rowCount: 3 })).toEqual({ type: 'none' })
    }
  })
})

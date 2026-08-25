import { beforeEach, describe, expect, it } from 'vitest'
import { clearPendingPhoto, stashPendingPhoto, takePendingPhoto } from './pending-photo.js'

const meal = new File(['meal'], 'meal.jpg', { type: 'image/jpeg' })
const board = new File(['board'], 'board.jpg', { type: 'image/jpeg' })

beforeEach(clearPendingPhoto)

describe('pending-photo', () => {
  it('hands the file over exactly once', () => {
    stashPendingPhoto('meal', meal)
    expect(takePendingPhoto('meal')).toBe(meal)
    // StrictMode double-invokes mount effects; the consumer guards with a
    // ref, and this is the backstop that makes a slip visible.
    expect(takePendingPhoto('meal')).toBeNull()
  })

  it('returns null when empty', () => {
    expect(takePendingPhoto('meal')).toBeNull()
  })

  it('does not consume the slot on a kind mismatch', () => {
    stashPendingPhoto('board', board)
    expect(takePendingPhoto('meal')).toBeNull()
    // The intended consumer can still claim it after the wrong page looked.
    expect(takePendingPhoto('board')).toBe(board)
  })

  it('a second stash replaces the first', () => {
    stashPendingPhoto('meal', meal)
    const newer = new File(['newer'], 'newer.jpg', { type: 'image/jpeg' })
    stashPendingPhoto('meal', newer)
    expect(takePendingPhoto('meal')).toBe(newer)
    expect(takePendingPhoto('meal')).toBeNull()
  })
})

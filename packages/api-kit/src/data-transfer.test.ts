import { describe, expect, it } from 'vitest'
import { ImportTally } from './data-transfer.js'

describe('ImportTally', () => {
  it('starts empty', () => {
    expect(new ImportTally().summary()).toEqual({ counts: {}, warnings: [] })
  })

  it('accumulates created and skipped per entity', () => {
    const tally = new ImportTally()
    tally.created('workouts', 3)
    tally.skipped('workouts')
    tally.created('metrics')
    expect(tally.summary().counts).toEqual({
      workouts: { created: 3, skipped: 1 },
      metrics: { created: 1, skipped: 0 },
    })
  })

  it('keeps entities in first-touched order', () => {
    const tally = new ImportTally()
    tally.created('exercises')
    tally.created('workouts')
    tally.skipped('exercises')
    expect(Object.keys(tally.summary().counts)).toEqual(['exercises', 'workouts'])
  })

  it('collects warnings in order', () => {
    const tally = new ImportTally()
    tally.warn({ entity: 'workouts', ref: 'w1', code: 'missing_exercise', message: 'gone' })
    tally.warn({ entity: 'foodLogEntries', code: 'missing_food_item', message: 'unresolved' })
    expect(tally.summary().warnings).toEqual([
      { entity: 'workouts', ref: 'w1', code: 'missing_exercise', message: 'gone' },
      { entity: 'foodLogEntries', code: 'missing_food_item', message: 'unresolved' },
    ])
  })

  it('returns a snapshot that later mutation does not change', () => {
    const tally = new ImportTally()
    tally.created('workouts')
    const snapshot = tally.summary()
    tally.created('workouts')
    tally.warn({ entity: 'workouts', code: 'late', message: 'after snapshot' })
    expect(snapshot.counts['workouts']).toEqual({ created: 1, skipped: 0 })
    expect(snapshot.warnings).toEqual([])
  })
})

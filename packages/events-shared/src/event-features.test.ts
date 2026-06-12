import { describe, expect, it } from 'vitest'
import {
  EVENT_FEATURE_DEFAULTS,
  EventFeaturesPatchSchema,
  mergeEventFeatures,
  resolveEventFeatures,
} from './event-features.js'

describe('resolveEventFeatures', () => {
  it('null/undefined resolve to defaults (lineup/sessions/groups on, attendees off)', () => {
    expect(resolveEventFeatures(null)).toEqual(EVENT_FEATURE_DEFAULTS)
    expect(resolveEventFeatures(undefined)).toEqual(EVENT_FEATURE_DEFAULTS)
    expect(EVENT_FEATURE_DEFAULTS).toEqual({
      lineup: true,
      sessions: true,
      groups: true,
      attendees: false,
    })
  })

  it('partial objects merge over defaults', () => {
    expect(resolveEventFeatures({ lineup: false })).toEqual({
      lineup: false,
      sessions: true,
      groups: true,
      attendees: false,
    })
    expect(resolveEventFeatures({ attendees: true })).toMatchObject({ attendees: true })
  })

  it('ignores unknown keys and non-boolean values', () => {
    expect(resolveEventFeatures({ lineup: 'nope', bogus: true, sessions: 0 })).toEqual(
      EVENT_FEATURE_DEFAULTS,
    )
  })

  it('non-object junk (arrays, strings, numbers) resolves to defaults', () => {
    expect(resolveEventFeatures([])).toEqual(EVENT_FEATURE_DEFAULTS)
    expect(resolveEventFeatures('{"lineup":false}')).toEqual(EVENT_FEATURE_DEFAULTS)
    expect(resolveEventFeatures(7)).toEqual(EVENT_FEATURE_DEFAULTS)
  })

  it('does not mutate the defaults object', () => {
    const r = resolveEventFeatures({ lineup: false })
    r.sessions = false
    expect(EVENT_FEATURE_DEFAULTS.lineup).toBe(true)
    expect(EVENT_FEATURE_DEFAULTS.sessions).toBe(true)
  })
})

describe('EventFeaturesPatchSchema', () => {
  it('accepts a partial boolean object', () => {
    expect(EventFeaturesPatchSchema.parse({ groups: false })).toEqual({ groups: false })
    expect(EventFeaturesPatchSchema.parse({})).toEqual({})
  })

  it('rejects unknown keys and non-boolean values', () => {
    expect(EventFeaturesPatchSchema.safeParse({ lineups: false }).success).toBe(false)
    expect(EventFeaturesPatchSchema.safeParse({ lineup: 'off' }).success).toBe(false)
  })
})

describe('mergeEventFeatures', () => {
  it('applies the patch over the stored value and materializes all keys', () => {
    expect(mergeEventFeatures({ lineup: false }, { sessions: false })).toEqual({
      lineup: false,
      sessions: false,
      groups: true,
      attendees: false,
    })
  })

  it('patch wins over stored, stored wins over defaults', () => {
    expect(mergeEventFeatures({ attendees: true }, { attendees: false }).attendees).toBe(false)
    expect(mergeEventFeatures(null, {})).toEqual(EVENT_FEATURE_DEFAULTS)
  })
})

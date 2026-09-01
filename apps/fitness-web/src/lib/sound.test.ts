import { describe, expect, it } from 'vitest'
import { needsResume } from './sound.js'

describe('needsResume', () => {
  it('resumes a suspended context', () => {
    expect(needsResume('suspended')).toBe(true)
  })

  it("resumes iOS's non-standard 'interrupted' state", () => {
    // A screen lock or an incoming call parks the context here — exactly
    // what a rest timer runs through. Missing this left the countdown
    // beeps silent for the rest of the session.
    expect(needsResume('interrupted' as AudioContextState)).toBe(true)
  })

  it('leaves a running context alone', () => {
    expect(needsResume('running')).toBe(false)
  })

  it('never tries to resume a closed context', () => {
    expect(needsResume('closed')).toBe(false)
  })
})

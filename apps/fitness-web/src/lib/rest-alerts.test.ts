import { describe, expect, it } from 'vitest'
import {
  countdownBeepSecond,
  downgradedAlertsMode,
  isNaturalRestFinish,
  restFireAction,
  sanitizeRestAlertsMode,
  shouldRearmRestTimer,
  shouldSignalRestFinish,
} from './rest-alerts.js'

describe('countdownBeepSecond', () => {
  it('fires on natural decrements through the final five seconds', () => {
    expect(countdownBeepSecond(6, 5)).toBe(5)
    expect(countdownBeepSecond(5, 4)).toBe(4)
    expect(countdownBeepSecond(2, 1)).toBe(1)
  })
  it('stays quiet above the window and at zero', () => {
    expect(countdownBeepSecond(8, 7)).toBeNull()
    expect(countdownBeepSecond(1, 0)).toBeNull() // the go tone owns 0
  })
  it('a skip (→ null) never beeps', () => {
    expect(countdownBeepSecond(4, null)).toBeNull()
    expect(countdownBeepSecond(null, null)).toBeNull()
  })
  it('an adjust jump never beeps', () => {
    expect(countdownBeepSecond(4, 19)).toBeNull() // +15
    expect(countdownBeepSecond(20, 5)).toBeNull() // −15 landing in window
    expect(countdownBeepSecond(5, 3)).toBeNull() // throttled 2 s tick
  })
  it('a new rest starting never beeps', () => {
    expect(countdownBeepSecond(null, 5)).toBeNull()
  })
})

describe('isNaturalRestFinish', () => {
  it('only the 1 → 0 tick counts as a finish', () => {
    expect(isNaturalRestFinish(1, 0)).toBe(true)
    expect(isNaturalRestFinish(2, 0)).toBe(false) // throttled jump
    expect(isNaturalRestFinish(1, null)).toBe(false) // skipped at 1 s
    expect(isNaturalRestFinish(30, null)).toBe(false) // skipped
    expect(isNaturalRestFinish(null, 0)).toBe(false)
  })
})

describe('sanitizeRestAlertsMode', () => {
  it('passes known modes and defaults the rest to sound', () => {
    expect(sanitizeRestAlertsMode('off')).toBe('off')
    expect(sanitizeRestAlertsMode('notify')).toBe('notify')
    expect(sanitizeRestAlertsMode('sound')).toBe('sound')
    expect(sanitizeRestAlertsMode('loud')).toBe('sound')
    expect(sanitizeRestAlertsMode(undefined)).toBe('sound')
  })
})

describe('shouldRearmRestTimer', () => {
  const armed = (deadlineMs: number, nextUp = 'Squat · set 2') => ({ deadlineMs, nextUp })
  it('always arms when nothing is armed', () => {
    expect(shouldRearmRestTimer(null, 10_000, 'Squat · set 2')).toBe(true)
  })
  it('keeps the armed timer through natural tick drift', () => {
    expect(shouldRearmRestTimer(armed(10_000), 10_000, 'Squat · set 2')).toBe(false)
    expect(shouldRearmRestTimer(armed(10_000), 10_900, 'Squat · set 2')).toBe(false) // sub-second jitter
    expect(shouldRearmRestTimer(armed(10_000), 9_200, 'Squat · set 2')).toBe(false)
  })
  it('re-arms on a ±15/±30 adjust or a resume', () => {
    expect(shouldRearmRestTimer(armed(10_000), 25_000, 'Squat · set 2')).toBe(true) // +15 s
    expect(shouldRearmRestTimer(armed(25_000), 10_000, 'Squat · set 2')).toBe(true) // −15 s
    expect(shouldRearmRestTimer(armed(10_000), 40_000, 'Squat · set 2')).toBe(true) // paused → resumed later
  })
  it('re-arms when the next-up label changed even at the same deadline', () => {
    // Batch-checking the last two sets of an exercise: the second
    // COMPLETE_SET projects a near-identical deadline, but the label
    // moved on to the next exercise — the armed rest is a different one.
    expect(shouldRearmRestTimer(armed(10_000, 'Squat · set 2'), 10_800, 'Leg Curl · set 1')).toBe(
      true,
    )
    expect(shouldRearmRestTimer(armed(10_000, 'Squat · set 2'), 10_000, '')).toBe(true)
  })
})

describe('restFireAction', () => {
  it('mode off is always silent', () => {
    expect(restFireAction('hidden', 'granted', 'off')).toBe('none')
    expect(restFireAction('visible', 'granted', 'off')).toBe('none')
  })
  it('hidden tab + notify + granted → notification', () => {
    expect(restFireAction('hidden', 'granted', 'notify')).toBe('notify')
  })
  it('everything else falls back to sound — never silently nothing', () => {
    expect(restFireAction('visible', 'granted', 'notify')).toBe('sound')
    expect(restFireAction('hidden', 'denied', 'notify')).toBe('sound')
    expect(restFireAction('hidden', 'default', 'notify')).toBe('sound')
    expect(restFireAction('hidden', 'unsupported', 'notify')).toBe('sound')
    expect(restFireAction('hidden', 'granted', 'sound')).toBe('sound')
    expect(restFireAction('visible', 'granted', 'sound')).toBe('sound')
  })
})

describe('downgradedAlertsMode', () => {
  it('downgrades notify when permission is no longer granted', () => {
    expect(downgradedAlertsMode('notify', 'denied')).toBe('sound')
    expect(downgradedAlertsMode('notify', 'default')).toBe('sound')
    expect(downgradedAlertsMode('notify', 'unsupported')).toBe('sound')
  })
  it('leaves everything else alone', () => {
    expect(downgradedAlertsMode('notify', 'granted')).toBe('notify')
    expect(downgradedAlertsMode('sound', 'denied')).toBe('sound')
    expect(downgradedAlertsMode('off', 'denied')).toBe('off')
  })
})

describe('shouldSignalRestFinish', () => {
  it('the first signal always fires', () => {
    expect(shouldSignalRestFinish(0, 5_000)).toBe(true)
  })
  it('a duplicate inside the gap window is suppressed', () => {
    expect(shouldSignalRestFinish(5_000, 5_050)).toBe(false)
    expect(shouldSignalRestFinish(5_000, 6_400)).toBe(false)
  })
  it('the next rest period signals again', () => {
    expect(shouldSignalRestFinish(5_000, 65_000)).toBe(true)
  })
})

import { describe, expect, it } from 'vitest'
import {
  PUSH_SYNC_MIN_INTERVAL_MS,
  pushHealthReason,
  resyncAction,
  serverKeyMatches,
  shouldSyncPush,
} from './push-sync.js'

describe('resyncAction', () => {
  const granted = { permission: 'granted' as NotificationPermission, keyMatches: true }

  it('does nothing when the user has not opted in', () => {
    expect(resyncAction({ ...granted, enabled: false, hasSubscription: true })).toBe('none')
    // Even a missing subscription is not our business while opted out.
    expect(resyncAction({ ...granted, enabled: false, hasSubscription: false })).toBe('none')
  })

  it('does nothing without notification permission — the heal never prompts', () => {
    expect(
      resyncAction({ enabled: true, permission: 'denied', hasSubscription: true, keyMatches: true }),
    ).toBe('none')
    expect(
      resyncAction({
        enabled: true,
        permission: 'default',
        hasSubscription: false,
        keyMatches: true,
      }),
    ).toBe('none')
  })

  it('subscribes afresh when the browser has no subscription', () => {
    expect(resyncAction({ ...granted, enabled: true, hasSubscription: false })).toBe('resubscribe')
  })

  it('subscribes afresh when the subscription was made under a stale server key', () => {
    expect(
      resyncAction({
        enabled: true,
        permission: 'granted',
        hasSubscription: true,
        keyMatches: false,
      }),
    ).toBe('resubscribe')
  })

  it('verifies with the server when the local subscription looks healthy', () => {
    // The zombie case: alive to the browser, possibly reaped server-side.
    expect(resyncAction({ ...granted, enabled: true, hasSubscription: true })).toBe('verify')
  })
})

describe('shouldSyncPush', () => {
  const now = 1_700_000_000_000

  it('syncs when nothing was ever recorded', () => {
    expect(shouldSyncPush(null, now)).toBe(true)
  })

  it('syncs when the stored stamp is unparseable', () => {
    expect(shouldSyncPush(Number.NaN, now)).toBe(true)
  })

  it('throttles inside the interval', () => {
    expect(shouldSyncPush(now - 1000, now)).toBe(false)
    expect(shouldSyncPush(now - (PUSH_SYNC_MIN_INTERVAL_MS - 1), now)).toBe(false)
  })

  it('syncs at and past the interval boundary', () => {
    expect(shouldSyncPush(now - PUSH_SYNC_MIN_INTERVAL_MS, now)).toBe(true)
    expect(shouldSyncPush(now - PUSH_SYNC_MIN_INTERVAL_MS - 1, now)).toBe(true)
  })

  it('syncs when the clock moved backwards rather than wedging shut', () => {
    expect(shouldSyncPush(now + 60_000, now)).toBe(true)
  })
})

describe('pushHealthReason', () => {
  it('stays quiet for a user who has not opted in', () => {
    for (const permission of ['granted', 'denied', 'default'] as NotificationPermission[]) {
      expect(pushHealthReason({ enabled: false, permission, resyncBlocked: true })).toBeNull()
    }
  })

  it('stays quiet when everything is healthy', () => {
    expect(
      pushHealthReason({ enabled: true, permission: 'granted', resyncBlocked: false }),
    ).toBeNull()
  })

  it('reports OS-level permission loss', () => {
    expect(pushHealthReason({ enabled: true, permission: 'denied', resyncBlocked: false })).toBe(
      'denied',
    )
    expect(pushHealthReason({ enabled: true, permission: 'default', resyncBlocked: false })).toBe(
      'default',
    )
  })

  it('reports a heal the browser refused', () => {
    expect(pushHealthReason({ enabled: true, permission: 'granted', resyncBlocked: true })).toBe(
      'blocked',
    )
  })

  it('prefers the permission reason over the blocked marker', () => {
    // A denied permission is the actionable root cause; a stale blocked
    // marker underneath it would only confuse the copy.
    expect(pushHealthReason({ enabled: true, permission: 'denied', resyncBlocked: true })).toBe(
      'denied',
    )
  })
})

describe('serverKeyMatches', () => {
  const expected = new Uint8Array([1, 2, 3, 4])

  it('treats an uninspectable key (Safari returns null) as a match', () => {
    expect(serverKeyMatches(null, expected)).toBe(true)
    expect(serverKeyMatches(undefined, expected)).toBe(true)
  })

  it('matches identical bytes', () => {
    expect(serverKeyMatches(new Uint8Array([1, 2, 3, 4]).buffer, expected)).toBe(true)
  })

  it('rejects a different length or differing bytes', () => {
    expect(serverKeyMatches(new Uint8Array([1, 2, 3]).buffer, expected)).toBe(false)
    expect(serverKeyMatches(new Uint8Array([1, 2, 3, 5]).buffer, expected)).toBe(false)
  })
})

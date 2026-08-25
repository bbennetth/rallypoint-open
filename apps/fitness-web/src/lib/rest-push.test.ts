import { describe, expect, it } from 'vitest'
import {
  restNotificationTag,
  restPushStatusMessage,
  restPushTag,
  serverKeyMatches,
  shouldScheduleRestPush,
  testPushStatusMessage,
  urlBase64ToUint8Array,
} from './rest-push.js'

describe('shouldScheduleRestPush', () => {
  it('schedules only for notify-mode + granted permission + online + supported', () => {
    expect(shouldScheduleRestPush('notify', 'granted', true, true)).toBe(true)
    expect(shouldScheduleRestPush('sound', 'granted', true, true)).toBe(false)
    expect(shouldScheduleRestPush('off', 'granted', true, true)).toBe(false)
    expect(shouldScheduleRestPush('notify', 'default', true, true)).toBe(false)
    expect(shouldScheduleRestPush('notify', 'denied', true, true)).toBe(false)
    // Offline: the local alert covers it; never queue a late push.
    expect(shouldScheduleRestPush('notify', 'granted', false, true)).toBe(false)
    expect(shouldScheduleRestPush('notify', 'granted', true, false)).toBe(false)
  })
})

describe('rest push tags', () => {
  it('sanitizes the session id into a url-safe tag', () => {
    expect(restPushTag('ses_abc-123')).toBe('ses_abc-123')
    expect(restPushTag('ses/§weird id')).toBe('ses__weird_id')
  })

  it('OS notification tag matches the server dedupe key shape', () => {
    // The server stamps `rest:<tag>` (its queue dedupe key) on the push
    // payload's tag; the page's local notification must use the same
    // value so the two collapse into one banner.
    expect(restNotificationTag('ses_abc')).toBe('rest:ses_abc')
  })
})

describe('restPushStatusMessage', () => {
  it('is quiet on success', () => {
    expect(restPushStatusMessage(true, true)).toBeNull()
  })
  it('explains unsupported browsers', () => {
    expect(restPushStatusMessage(false, false)).toMatch(/installed app/i)
    // Unsupported wins even if subscribed is (nonsensically) true.
    expect(restPushStatusMessage(true, false)).toMatch(/installed app/i)
  })
  it('surfaces a failed subscribe without hiding the working fallbacks', () => {
    expect(restPushStatusMessage(false, true)).toMatch(/couldn’t be enabled/i)
    expect(restPushStatusMessage(false, true)).toMatch(/still work/i)
  })
})

describe('serverKeyMatches', () => {
  const expected = new Uint8Array([4, 10, 20, 30])

  it('matches identical bytes', () => {
    expect(serverKeyMatches(new Uint8Array([4, 10, 20, 30]).buffer, expected)).toBe(true)
  })

  it('rejects differing bytes of the same length', () => {
    expect(serverKeyMatches(new Uint8Array([4, 10, 20, 31]).buffer, expected)).toBe(false)
  })

  it('rejects a different-length key', () => {
    expect(serverKeyMatches(new Uint8Array([4, 10, 20]).buffer, expected)).toBe(false)
  })

  it('treats a null/undefined applicationServerKey as a match', () => {
    // Deliberate: Safari can report null for a valid subscription, so a
    // mismatch is unprovable — never force-resubscribe on null (the server
    // reaps genuinely dead subscriptions on send).
    expect(serverKeyMatches(null, expected)).toBe(true)
    expect(serverKeyMatches(undefined, expected)).toBe(true)
  })
})

describe('testPushStatusMessage', () => {
  it('maps the three backend outcomes', () => {
    expect(testPushStatusMessage({ ok: true, registered: false, delivered: false })).toMatch(
      /no devices registered/i,
    )
    expect(testPushStatusMessage({ ok: true, registered: true, delivered: true })).toMatch(/sent/i)
    expect(testPushStatusMessage({ ok: true, registered: true, delivered: false })).toMatch(
      /couldn’t reach/i,
    )
  })
})

describe('urlBase64ToUint8Array', () => {
  it('decodes base64url with padding restored', () => {
    // "hi~" → aGl-  (base64url uses - for +)
    const out = urlBase64ToUint8Array('aGk')
    expect([...out]).toEqual([104, 105])
  })
})

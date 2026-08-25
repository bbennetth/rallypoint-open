import { describe, it, expect } from 'vitest'
import {
  SYSTEM_USER_ID,
  browseEventAction,
  eventAttendDecisionHref,
  eventPreviewHref,
  isSystemEvent,
} from './browse-route.js'

describe('browseEventAction', () => {
  it('strangers (null role) get the Join action', () => {
    expect(browseEventAction({ slug: 'fest', viewer_role: null })).toEqual({ kind: 'join' })
  })

  it('viewers open the attending decision page', () => {
    expect(browseEventAction({ slug: 'fest', viewer_role: 'viewer' })).toEqual({
      kind: 'open',
      href: '/events/fest/attend',
    })
  })

  it('managers open the owner shell', () => {
    expect(browseEventAction({ slug: 'fest', viewer_role: 'owner' })).toEqual({
      kind: 'open',
      href: '/events/fest',
    })
    expect(browseEventAction({ slug: 'fest', viewer_role: 'editor' })).toEqual({
      kind: 'open',
      href: '/events/fest',
    })
  })

  it('encodes slugs in hrefs', () => {
    expect(eventAttendDecisionHref('a/b')).toBe('/events/a%2Fb/attend')
    expect(eventPreviewHref('a/b')).toBe('/browse/a%2Fb')
  })
})

describe('isSystemEvent', () => {
  it('matches only the system sentinel owner', () => {
    expect(isSystemEvent({ owner_user_id: SYSTEM_USER_ID })).toBe(true)
    expect(isSystemEvent({ owner_user_id: 'user_abc' })).toBe(false)
  })
})

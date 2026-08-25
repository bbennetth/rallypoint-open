import { describe, expect, it } from 'vitest'
import {
  attendeeHomeHref,
  canManageEvent,
  eventGroupsHref,
  eventHomeHref,
  eventOwnerHref,
  otherGroups,
} from './attendee-route.js'
import type { GroupDto } from './api.js'

// These three call sites used to inline the same ternary and one had
// drifted (PreviewPage always sent the viewer to the event shell, so an
// owner with a group previewed as "attending solo"). Pinning the rule
// here is what keeps them from disagreeing again.

describe('attendeeHomeHref', () => {
  it('sends a group member to their group shell', () => {
    expect(attendeeHomeHref({ slug: 'harvest-moon', my_group_id: 'grp_123' })).toBe('/groups/grp_123')
  })

  it('sends a group-less attendee to the event shell', () => {
    expect(attendeeHomeHref({ slug: 'harvest-moon', my_group_id: null })).toBe(
      '/events/harvest-moon/attending/now',
    )
  })

  it('escapes slugs and group ids', () => {
    expect(attendeeHomeHref({ slug: 'a/b', my_group_id: null })).toBe('/events/a%2Fb/attending/now')
    expect(attendeeHomeHref({ slug: 'a/b', my_group_id: 'grp/1' })).toBe('/groups/grp%2F1')
  })
})

describe('eventOwnerHref', () => {
  it('points at the owner tab shell', () => {
    expect(eventOwnerHref('harvest-moon')).toBe('/events/harvest-moon')
  })

  it('escapes the slug', () => {
    expect(eventOwnerHref('a b/c')).toBe('/events/a%20b%2Fc')
  })
})

describe('canManageEvent', () => {
  it('accepts the roles that get the owner tabs', () => {
    expect(canManageEvent('owner')).toBe(true)
    expect(canManageEvent('editor')).toBe(true)
  })

  it('rejects viewers', () => {
    expect(canManageEvent('viewer')).toBe(false)
  })
})

// The mobile default: on a phone an event opens the attendee experience
// for everyone, organizers included. Desktop keeps the owner tabs.
describe('eventHomeHref', () => {
  const live = { slug: 'harvest-moon', my_group_id: null, deleted_at: null }

  it.each(['owner', 'editor'] as const)('sends a %s to the owner tabs on desktop', (role) => {
    expect(eventHomeHref({ ...live, viewer_role: role }, { mobile: false })).toBe(
      '/events/harvest-moon',
    )
  })

  it.each(['owner', 'editor'] as const)('sends a %s to their group shell on mobile', (role) => {
    expect(
      eventHomeHref({ ...live, my_group_id: 'grp_123', viewer_role: role }, { mobile: true }),
    ).toBe('/groups/grp_123')
  })

  it('sends a group-less owner to the solo shell on mobile', () => {
    expect(eventHomeHref({ ...live, viewer_role: 'owner' }, { mobile: true })).toBe(
      '/events/harvest-moon/attending/now',
    )
  })

  it.each([true, false])('sends a viewer to the attendee shell (mobile=%s)', (mobile) => {
    expect(eventHomeHref({ ...live, viewer_role: 'viewer' }, { mobile })).toBe(
      '/events/harvest-moon/attending/now',
    )
    expect(
      eventHomeHref({ ...live, my_group_id: 'grp_123', viewer_role: 'viewer' }, { mobile }),
    ).toBe('/groups/grp_123')
  })

  // A soft-deleted event has no attendee experience worth opening —
  // you only reach one via "Show deleted events", to manage it.
  it.each(['owner', 'editor'] as const)(
    'keeps a deleted event on the owner tabs for a %s on mobile',
    (role) => {
      expect(
        eventHomeHref(
          {
            ...live,
            my_group_id: 'grp_123',
            viewer_role: role,
            deleted_at: '2026-08-01T00:00:00.000Z',
          },
          { mobile: true },
        ),
      ).toBe('/events/harvest-moon')
    },
  )

  it('still sends a viewer of a deleted event to the attendee shell', () => {
    expect(
      eventHomeHref(
        { ...live, viewer_role: 'viewer', deleted_at: '2026-08-01T00:00:00.000Z' },
        { mobile: true },
      ),
    ).toBe('/events/harvest-moon/attending/now')
  })

  it('escapes the slug on the owner arm', () => {
    expect(
      eventHomeHref({ ...live, slug: 'a/b', viewer_role: 'owner' }, { mobile: false }),
    ).toBe('/events/a%2Fb')
  })
})

describe('eventGroupsHref', () => {
  it('points at the event attendee shell Group tab', () => {
    expect(eventGroupsHref('harvest-moon')).toBe('/events/harvest-moon/attending/group')
  })

  it('escapes the slug', () => {
    expect(eventGroupsHref('a b/c')).toBe('/events/a%20b%2Fc/attending/group')
  })
})

function group(id: string, name = id): GroupDto {
  return {
    id,
    event_id: 'event_1',
    name,
    description: null,
    start_date: null,
    end_date: null,
    owner_user_id: 'user_1',
    viewer_role: 'member',
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
  }
}

describe('otherGroups', () => {
  it('drops the group being viewed and keeps the rest in order', () => {
    const groups = [group('grp_a'), group('grp_b'), group('grp_c')]
    expect(otherGroups(groups, 'grp_b').map((g) => g.id)).toEqual(['grp_a', 'grp_c'])
  })

  it('returns empty when the only group is the current one', () => {
    expect(otherGroups([group('grp_a')], 'grp_a')).toEqual([])
  })

  it('is a no-op for an unrelated current id', () => {
    const groups = [group('grp_a'), group('grp_b')]
    expect(otherGroups(groups, 'grp_zz').map((g) => g.id)).toEqual(['grp_a', 'grp_b'])
  })
})

import { describe, it, expect } from 'vitest'
import {
  buildMemoryRepos,
  MemoryEventRepo,
  MemoryEventMemberRepo,
  MemoryEventStageRepo,
  MemoryEventDayRepo,
  MemoryArtistRepo,
  MemoryEventArtistRepo,
  MemoryEventSetStarRepo,
  MemoryEventSessionRepo,
  MemoryEventSnapshotRepo,
  UniqueConstraintError,
} from './memory.js'
import type { CreateEventInput, CreateSessionInput, EventArtistRecord } from './types.js'

function evt(over: Partial<CreateEventInput> & { id: string; slug: string }): CreateEventInput {
  return {
    tenantId: 'rallypoint',
    ownerUserId: 'user_owner',
    name: 'Event',
    timezone: 'UTC',
    privacyMode: 'unlisted',
    ...over,
  }
}

describe('MemoryEventRepo create / slug collision', () => {
  it('rejects a duplicate (tenant, slug)', async () => {
    const repo = new MemoryEventRepo()
    await repo.create(evt({ id: 'event_1', slug: 'fest' }))
    await expect(repo.create(evt({ id: 'event_2', slug: 'fest' }))).rejects.toBeInstanceOf(
      UniqueConstraintError,
    )
  })
  it('allows the same slug under a different tenant', async () => {
    const repo = new MemoryEventRepo()
    await repo.create(evt({ id: 'event_1', slug: 'fest' }))
    await expect(
      repo.create(evt({ id: 'event_2', slug: 'fest', tenantId: 'other' })),
    ).resolves.toBeDefined()
  })
})

describe('MemoryEventRepo listForUser', () => {
  it('returns owned ∪ collaborated and filters soft-deleted by default', async () => {
    const members = new MemoryEventMemberRepo()
    const repo = new MemoryEventRepo(members)
    await repo.create(evt({ id: 'event_owned', slug: 'a', ownerUserId: 'user_me' }))
    await repo.create(evt({ id: 'event_collab', slug: 'b', ownerUserId: 'user_other' }))
    await repo.create(evt({ id: 'event_deleted', slug: 'c', ownerUserId: 'user_me' }))
    await members.add({ id: 'evm_1', eventId: 'event_collab', userId: 'user_me', role: 'editor' })
    await repo.softDelete('event_deleted', new Date())

    const page = await repo.listForUser('user_me', { includeDeleted: false, limit: 50 })
    const ids = page.items.map((e) => e.id).sort()
    expect(ids).toEqual(['event_collab', 'event_owned'])

    const withDeleted = await repo.listForUser('user_me', { includeDeleted: true, limit: 50 })
    expect(withDeleted.items.map((e) => e.id)).toContain('event_deleted')
  })

  it('paginates with a stable cursor', async () => {
    const repo = new MemoryEventRepo()
    for (let i = 0; i < 5; i++) {
      const e = await repo.create(evt({ id: `event_${i}`, slug: `s${i}`, ownerUserId: 'user_me' }))
      // Force distinct, increasing createdAt so ordering is deterministic.
      ;(e as { createdAt: Date }).createdAt = new Date(2026, 0, 1, 0, 0, i)
      await repo.patch(e.id, {}) // touch updatedAt, keep row
    }
    const first = await repo.listForUser('user_me', { includeDeleted: false, limit: 2 })
    expect(first.items).toHaveLength(2)
    expect(first.nextCursor).toBeTruthy()
    const second = await repo.listForUser('user_me', {
      includeDeleted: false,
      limit: 2,
      cursor: first.nextCursor,
    })
    expect(second.items).toHaveLength(2)
    const firstIds = new Set(first.items.map((e) => e.id))
    for (const e of second.items) expect(firstIds.has(e.id)).toBe(false)
  })
})

describe('MemoryEventRepo listGroupForUser', () => {
  it('returns owned ∪ member ∪ current-attendee group events, deduped, scope/soft-delete filtered', async () => {
    const repos = buildMemoryRepos()
    await repos.events.create(
      evt({ id: 'event_owned', slug: 'a', ownerUserId: 'user_me', scopeType: 'group' }),
    )
    await repos.events.create(
      evt({ id: 'event_member', slug: 'b', ownerUserId: 'user_other', scopeType: 'group' }),
    )
    await repos.events.create(
      evt({ id: 'event_attend', slug: 'c', ownerUserId: 'user_other', scopeType: 'group' }),
    )
    await repos.events.create(
      evt({ id: 'event_removed', slug: 'd', ownerUserId: 'user_other', scopeType: 'group' }),
    )
    await repos.events.create(
      evt({ id: 'event_personal', slug: 'e', ownerUserId: 'user_me', scopeType: 'personal' }),
    )
    await repos.events.create(
      evt({ id: 'event_deleted', slug: 'f', ownerUserId: 'user_me', scopeType: 'group' }),
    )
    await repos.events.softDelete('event_deleted', new Date())

    await repos.members.add({ id: 'm1', eventId: 'event_member', userId: 'user_me', role: 'editor' })
    await repos.attendees.upsert({ id: 'a1', eventId: 'event_attend', userId: 'user_me' })
    // Owner is ALSO an attendee of their own event → must dedup to one row.
    await repos.attendees.upsert({ id: 'a2', eventId: 'event_owned', userId: 'user_me' })
    // Removed attendee row must not surface.
    await repos.attendees.upsert({ id: 'a3', eventId: 'event_removed', userId: 'user_me' })
    await repos.attendees.softRemove('event_removed', 'user_me', new Date())

    const rows = await repos.events.listGroupForUser('user_me')
    const ids = rows.map((e) => e.id).sort()
    expect(ids).toEqual(['event_attend', 'event_member', 'event_owned'])
    // Exactly one row for the owned-and-attended event.
    expect(rows.filter((e) => e.id === 'event_owned')).toHaveLength(1)
  })
})

describe('MemoryEventRepo transferOwnership', () => {
  it('swaps owner and demotes the old owner to editor', async () => {
    const repos = buildMemoryRepos()
    await repos.events.create(evt({ id: 'event_1', slug: 'x', ownerUserId: 'user_old' }))
    await repos.members.add({
      id: 'evm_new',
      eventId: 'event_1',
      userId: 'user_new',
      role: 'editor',
    })
    await repos.events.transferOwnership({
      eventId: 'event_1',
      newOwnerUserId: 'user_new',
      oldOwnerUserId: 'user_old',
      oldOwnerMemberId: 'evm_old',
    })
    const e = await repos.events.findById('event_1')
    expect(e?.ownerUserId).toBe('user_new')
    // New owner's collaborator row is gone; old owner is now editor.
    expect(await repos.members.findByEventAndUser('event_1', 'user_new')).toBeNull()
    expect(await repos.members.findByEventAndUser('event_1', 'user_old')).toMatchObject({
      role: 'editor',
    })
  })
})

describe('MemoryEventStageRepo', () => {
  it('rejects a duplicate name within the same event but allows it across events', async () => {
    const repo = new MemoryEventStageRepo()
    await repo.create({ id: 'evs_1', eventId: 'event_a', name: 'Main' })
    await expect(
      repo.create({ id: 'evs_2', eventId: 'event_a', name: 'Main' }),
    ).rejects.toBeInstanceOf(UniqueConstraintError)
    await expect(
      repo.create({ id: 'evs_3', eventId: 'event_b', name: 'Main' }),
    ).resolves.toBeDefined()
  })

  it('rejects renaming onto an existing sibling name', async () => {
    const repo = new MemoryEventStageRepo()
    await repo.create({ id: 'evs_1', eventId: 'event_a', name: 'Main' })
    const second = await repo.create({ id: 'evs_2', eventId: 'event_a', name: 'Second' })
    await expect(repo.update(second.id, { name: 'Main' })).rejects.toBeInstanceOf(
      UniqueConstraintError,
    )
  })
})

describe('MemoryEventDayRepo', () => {
  it('rejects a duplicate label OR date within the same event', async () => {
    const repo = new MemoryEventDayRepo()
    await repo.create({ id: 'evd_1', eventId: 'event_a', dayLabel: 'Day 1', date: '2026-07-01' })
    await expect(
      repo.create({ id: 'evd_2', eventId: 'event_a', dayLabel: 'Day 1', date: '2026-07-02' }),
    ).rejects.toBeInstanceOf(UniqueConstraintError)
    await expect(
      repo.create({ id: 'evd_3', eventId: 'event_a', dayLabel: 'Day 2', date: '2026-07-01' }),
    ).rejects.toBeInstanceOf(UniqueConstraintError)
    await expect(
      repo.create({ id: 'evd_4', eventId: 'event_b', dayLabel: 'Day 1', date: '2026-07-01' }),
    ).resolves.toBeDefined()
  })

  it('listForEventsIn batches across events and short-circuits empty input', async () => {
    const repo = new MemoryEventDayRepo()
    await repo.create({ id: 'evd_a1', eventId: 'event_a', dayLabel: 'Day 1', date: '2026-07-01', sortOrder: 0 })
    await repo.create({ id: 'evd_a2', eventId: 'event_a', dayLabel: 'Day 2', date: '2026-07-02', sortOrder: 1 })
    await repo.create({ id: 'evd_b1', eventId: 'event_b', dayLabel: 'Day 1', date: '2026-08-01', sortOrder: 0 })
    await repo.create({ id: 'evd_c1', eventId: 'event_c', dayLabel: 'Day 1', date: '2026-09-01', sortOrder: 0 })

    // event_c excluded; event_a (2 rows) + event_b (1 row) included.
    const rows = await repo.listForEventsIn(['event_a', 'event_b'])
    expect(rows.map((r) => r.eventId).sort()).toEqual(['event_a', 'event_a', 'event_b'])

    expect(await repo.listForEventsIn([])).toEqual([]) // empty input → []
    expect(await repo.listForEventsIn(['event_zzz'])).toEqual([]) // unknown ids → []
  })
})

describe('MemoryArtistRepo', () => {
  it('dedupes case-insensitively and searches by substring', async () => {
    const repo = new MemoryArtistRepo()
    const created = await repo.create({ id: 'art_1', name: 'Aphex Twin' })
    await expect(repo.create({ id: 'art_2', name: 'APHEX TWIN' })).rejects.toBeInstanceOf(
      UniqueConstraintError,
    )
    expect((await repo.findByName('aphex twin'))?.id).toBe(created.id)
    expect((await repo.search('phex', 10)).map((a) => a.id)).toContain(created.id)
  })
})

describe('MemoryEventArtistRepo', () => {
  function slot(over: Partial<EventArtistRecord>): EventArtistRecord {
    return {
      eventId: 'event_a',
      artistId: 'art_1',
      dayId: 'evd_1',
      stageId: null,
      tier: null,
      genre: null,
      startTime: null,
      endTime: null,
      displayName: null,
      ...over,
    }
  }

  it('upserts on the composite key rather than duplicating', async () => {
    const repo = new MemoryEventArtistRepo()
    await repo.upsert(slot({ tier: 'headliner' }))
    await repo.upsert(slot({ tier: 'support' }))
    const items = await repo.listForEvent('event_a')
    expect(items).toHaveLength(1)
    expect(items[0]!.tier).toBe('support')
  })

  it('bulk-upserts and deletes by composite key', async () => {
    const repo = new MemoryEventArtistRepo()
    await repo.bulkUpsert([
      slot({ artistId: 'art_1' }),
      slot({ artistId: 'art_2' }),
    ])
    expect(await repo.listForEvent('event_a')).toHaveLength(2)
    expect(await repo.delete('event_a', 'art_1', 'evd_1')).toBe(true)
    expect(await repo.delete('event_a', 'art_1', 'evd_1')).toBe(false)
    expect(await repo.listForEvent('event_a')).toHaveLength(1)
  })

  it('replaceAll upserts snapshot rows and deletes only those absent', async () => {
    const repo = new MemoryEventArtistRepo()
    await repo.bulkUpsert([
      slot({ artistId: 'art_1' }),
      slot({ artistId: 'art_2' }),
      slot({ artistId: 'art_3' }),
    ])
    // Snapshot keeps art_1 (with a changed tier) and art_2; art_3 absent.
    const out = await repo.replaceAll('event_a', [
      slot({ artistId: 'art_1', tier: 'headliner' }),
      slot({ artistId: 'art_2' }),
    ])
    expect(out.map((r) => r.artistId).sort()).toEqual(['art_1', 'art_2'])
    expect((await repo.find('event_a', 'art_1', 'evd_1'))?.tier).toBe('headliner')
    expect(await repo.find('event_a', 'art_3', 'evd_1')).toBeNull()
  })

  it('cascades star rows when an artist slot is deleted (#201)', async () => {
    const artistRepo = new MemoryEventArtistRepo()
    const starRepo = new MemoryEventSetStarRepo()
    artistRepo.eventSetStars = starRepo

    const slotKey = { eventId: 'event_a', artistId: 'art_1', dayId: 'evd_1' }
    await artistRepo.upsert(slot(slotKey))
    await starRepo.star('user_x', slotKey)
    expect(await starRepo.isStarred('user_x', slotKey)).toBe(true)

    await artistRepo.delete('event_a', 'art_1', 'evd_1')

    expect(await starRepo.isStarred('user_x', slotKey)).toBe(false)
  })

  it('cascades stars via bulkApply delete (#201)', async () => {
    const artistRepo = new MemoryEventArtistRepo()
    const starRepo = new MemoryEventSetStarRepo()
    artistRepo.eventSetStars = starRepo

    const slotKey = { eventId: 'event_a', artistId: 'art_1', dayId: 'evd_1' }
    await artistRepo.upsert(slot(slotKey))
    await starRepo.star('user_x', slotKey)

    await artistRepo.bulkApply('event_a', {
      upserts: [],
      deletes: [{ artistId: 'art_1', dayId: 'evd_1' }],
    })

    expect(await starRepo.isStarred('user_x', slotKey)).toBe(false)
  })
})

describe('MemoryEventSessionRepo', () => {
  function sess(over: Partial<CreateSessionInput> & { id: string }): CreateSessionInput {
    return {
      eventId: 'event_a',
      title: 'A session',
      approvalStatus: 'pending',
      visibility: 'group',
      createdByUserId: 'user_owner',
      ...over,
    }
  }

  it('creates with defaults and round-trips by id', async () => {
    const repo = new MemoryEventSessionRepo()
    const created = await repo.create(sess({ id: 'evx_1' }))
    expect(created.approvalStatus).toBe('pending')
    expect(created.dayId).toBeNull()
    expect(created.approvedByUserId).toBeNull()
    const got = await repo.findById('evx_1')
    expect(got?.title).toBe('A session')
  })

  it('filters listForEvent by approvalStatus, dayId, and soft-delete', async () => {
    const repo = new MemoryEventSessionRepo()
    await repo.create(sess({ id: 'evx_1', approvalStatus: 'approved', dayId: 'evd_1' }))
    await repo.create(sess({ id: 'evx_2', approvalStatus: 'pending', dayId: 'evd_2' }))
    await repo.create(sess({ id: 'evx_3', approvalStatus: 'approved', dayId: 'evd_2' }))

    expect(await repo.listForEvent('event_a')).toHaveLength(3)
    expect(await repo.listForEvent('event_a', { approvalStatus: 'approved' })).toHaveLength(2)
    expect(await repo.listForEvent('event_a', { dayId: 'evd_2' })).toHaveLength(2)

    await repo.softDelete('evx_1', new Date())
    expect(await repo.listForEvent('event_a')).toHaveLength(2)
    expect(await repo.listForEvent('event_a', { includeDeleted: true })).toHaveLength(3)
  })

  it('setApproval stamps status + approver; patch leaves approval alone', async () => {
    const repo = new MemoryEventSessionRepo()
    await repo.create(sess({ id: 'evx_1' }))

    const approved = await repo.setApproval('evx_1', {
      status: 'approved',
      approvedByUserId: 'user_owner',
      approvedAt: new Date(),
    })
    expect(approved?.approvalStatus).toBe('approved')
    expect(approved?.approvedByUserId).toBe('user_owner')

    const patched = await repo.patch('evx_1', { title: 'Renamed' })
    expect(patched?.title).toBe('Renamed')
    // patch is not allowed to move approval state.
    expect(patched?.approvalStatus).toBe('approved')
  })

  it('restoreActive revives snapshot rows and soft-deletes the rest', async () => {
    const repo = new MemoryEventSessionRepo()
    const s1 = await repo.create(sess({ id: 'evx_1' }))
    await repo.create(sess({ id: 'evx_2' }))
    // Snapshot taken when only s1 existed (and was deleted afterward).
    await repo.softDelete('evx_1', new Date())

    const now = new Date()
    const active = await repo.restoreActive('event_a', [s1], now)
    // s1 revived (deleted_at cleared), s2 soft-deleted (absent from snapshot).
    expect(active.map((s) => s.id)).toEqual(['evx_1'])
    expect((await repo.findById('evx_1'))?.deletedAt).toBeNull()
    expect((await repo.findById('evx_2'))?.deletedAt).not.toBeNull()
  })
})

describe('MemoryEventSnapshotRepo', () => {
  it('lists newest-first by (event, kind) and prunes the overflow', async () => {
    const repo = new MemoryEventSnapshotRepo()
    for (let i = 0; i < 3; i++) {
      await repo.create({
        id: `esnap_${i}`,
        eventId: 'event_a',
        kind: 'lineup',
        data: [],
        reason: `r${i}`,
        itemCount: i,
        createdByUserId: 'user_owner',
      })
    }
    // A different kind is isolated.
    await repo.create({
      id: 'esnap_sess',
      eventId: 'event_a',
      kind: 'sessions',
      data: [],
      reason: 'sess',
      itemCount: 0,
      createdByUserId: 'user_owner',
    })

    const lineup = await repo.listForEvent('event_a', 'lineup')
    expect(lineup).toHaveLength(3)
    // Newest-first: esnap_2 created last.
    expect(lineup[0]!.id).toBe('esnap_2')
    expect(await repo.listForEvent('event_a', 'sessions')).toHaveLength(1)

    const pruned = await repo.prune('event_a', 'lineup', 1)
    expect(pruned).toBe(2)
    const after = await repo.listForEvent('event_a', 'lineup')
    expect(after).toHaveLength(1)
    expect(after[0]!.id).toBe('esnap_2')
  })

  it('findById returns the full record incl. data', async () => {
    const repo = new MemoryEventSnapshotRepo()
    await repo.create({
      id: 'esnap_x',
      eventId: 'event_a',
      kind: 'lineup',
      data: [{ artistId: 'art_1' }],
      reason: 'r',
      itemCount: 1,
      createdByUserId: 'user_owner',
    })
    const got = await repo.findById('esnap_x')
    expect(got?.data).toEqual([{ artistId: 'art_1' }])
    expect(await repo.findById('nope')).toBeNull()
  })
})

describe('MemoryGroupRepo delete cascade', () => {
  it('mirrors the FK cascade: deleting a group removes its rallies + attendees', async () => {
    const repos = buildMemoryRepos()
    await repos.groups.create({
      id: 'group_1',
      eventId: 'event_a',
      ownerUserId: 'user_owner',
      name: 'Group',
      description: null,
      joinCodeHash: 'hash_1',
      startDate: null,
      endDate: null,
    })
    const rally = await repos.rallies.create({
      id: 'rally_1',
      groupId: 'group_1',
      eventId: 'event_a',
      title: 'Meet at gate',
      createdBy: 'user_owner',
    })
    await repos.rallyAttendees.upsert({
      id: 'rta_1',
      rallyId: rally.id,
      userId: 'user_owner',
      status: 'going',
    })

    await repos.groups.delete('group_1')

    expect(await repos.rallies.listForGroup('group_1')).toHaveLength(0)
    expect(await repos.rallies.findById('rally_1')).toBeNull()
    expect(await repos.rallyAttendees.listForRally('rally_1')).toHaveLength(0)
  })

  it('mirrors the FK cascade for chat messages', async () => {
    const repos = buildMemoryRepos()
    await repos.groups.create({
      id: 'group_1',
      eventId: 'event_a',
      ownerUserId: 'user_owner',
      name: 'Group',
      description: null,
      joinCodeHash: 'hash_1',
      startDate: null,
      endDate: null,
    })
    await repos.chatMessages.create({
      id: 'msg_1',
      groupId: 'group_1',
      userId: 'user_owner',
      body: 'hi',
    })

    await repos.groups.delete('group_1')

    expect(await repos.chatMessages.listForGroup('group_1', { limit: 50 })).toHaveLength(0)
    expect(await repos.chatMessages.findById('msg_1')).toBeNull()
  })
})

describe('MemoryChatMessageRepo', () => {
  it('lists newest-first and pages backwards via the before cursor', async () => {
    const repos = buildMemoryRepos()
    for (const id of ['msg_1', 'msg_2', 'msg_3', 'msg_4', 'msg_5']) {
      await repos.chatMessages.create({ id, groupId: 'group_1', userId: 'user_owner', body: id })
    }
    // Different group is excluded.
    await repos.chatMessages.create({
      id: 'msg_other',
      groupId: 'group_2',
      userId: 'user_owner',
      body: 'x',
    })

    const first = await repos.chatMessages.listForGroup('group_1', { limit: 2 })
    expect(first.map((m) => m.id)).toEqual(['msg_5', 'msg_4'])

    const second = await repos.chatMessages.listForGroup('group_1', {
      limit: 2,
      before: first[first.length - 1]!.id,
    })
    expect(second.map((m) => m.id)).toEqual(['msg_3', 'msg_2'])

    const third = await repos.chatMessages.listForGroup('group_1', {
      limit: 2,
      before: second[second.length - 1]!.id,
    })
    expect(third.map((m) => m.id)).toEqual(['msg_1'])
  })
})

// ── #171 transactional repo methods (memory mirror) ─────────────────

describe('MemoryGroupRepo.createWithOwner', () => {
  it('writes group + owner member + attendee atomically (non-owner creator)', async () => {
    const repos = buildMemoryRepos()
    const group = await repos.groups.createWithOwner({
      group: {
        id: 'grp_1',
        eventId: 'event_a',
        ownerUserId: 'user_creator',
        name: 'Atomic',
        description: null,
        joinCodeHash: 'h1',
        startDate: null,
        endDate: null,
      },
      ownerMemberId: 'grm_1',
      attendeeId: 'eva_1',
    })
    expect(group.id).toBe('grp_1')
    const member = await repos.groupMembers.findByGroupAndUser('grp_1', 'user_creator')
    expect(member?.role).toBe('owner')
    const attendee = await repos.attendees.findByEventAndUser('event_a', 'user_creator')
    expect(attendee?.removedAt).toBeNull()
  })

  it('skips the attendee write when attendeeId is null (event-owner path)', async () => {
    const repos = buildMemoryRepos()
    await repos.groups.createWithOwner({
      group: {
        id: 'grp_2',
        eventId: 'event_b',
        ownerUserId: 'user_event_owner',
        name: 'Owner Owns',
        description: null,
        joinCodeHash: 'h2',
        startDate: null,
        endDate: null,
      },
      ownerMemberId: 'grm_2',
      attendeeId: null,
    })
    expect(await repos.attendees.findByEventAndUser('event_b', 'user_event_owner')).toBeNull()
  })

  it('throws UniqueConstraintError on duplicate name', async () => {
    const repos = buildMemoryRepos()
    await repos.groups.createWithOwner({
      group: {
        id: 'grp_3a',
        eventId: 'event_c',
        ownerUserId: 'user_first',
        name: 'Taken',
        description: null,
        joinCodeHash: 'h3a',
        startDate: null,
        endDate: null,
      },
      ownerMemberId: 'grm_3a',
      attendeeId: 'eva_3a',
    })
    await expect(
      repos.groups.createWithOwner({
        group: {
          id: 'grp_3b',
          eventId: 'event_c',
          ownerUserId: 'user_second',
          name: 'Taken',
          description: null,
          joinCodeHash: 'h3b',
          startDate: null,
          endDate: null,
        },
        ownerMemberId: 'grm_3b',
        attendeeId: 'eva_3b',
      }),
    ).rejects.toBeInstanceOf(UniqueConstraintError)
  })
})

describe('MemoryGroupRepo.joinWithAttendee', () => {
  async function seedGroup(repos: ReturnType<typeof buildMemoryRepos>) {
    await repos.groups.createWithOwner({
      group: {
        id: 'grp_j',
        eventId: 'event_j',
        ownerUserId: 'user_owner',
        name: 'Joinable',
        description: null,
        joinCodeHash: 'h_j',
        startDate: null,
        endDate: null,
      },
      ownerMemberId: 'grm_j_o',
      attendeeId: null, // owner of event is creator
    })
  }

  it('happy path adds member + attendee + consumes invite', async () => {
    const repos = buildMemoryRepos()
    await seedGroup(repos)
    const invite = await repos.groupInvites.create({
      id: 'gri_1',
      groupId: 'grp_j',
      codeHash: 'h_inv',
      invitedByUserId: 'user_owner',
      invitedEmail: null,
      expiresAt: new Date(Date.now() + 86_400_000),
    })

    const result = await repos.groups.joinWithAttendee({
      memberId: 'grm_j_1',
      groupId: 'grp_j',
      userId: 'user_joiner',
      inviteId: invite.id,
      attendeeId: 'eva_j_1',
      eventId: 'event_j',
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.readmitted).toBe(false)

    const member = await repos.groupMembers.findByGroupAndUser('grp_j', 'user_joiner')
    expect(member?.role).toBe('member')
    const attendee = await repos.attendees.findByEventAndUser('event_j', 'user_joiner')
    expect(attendee?.removedAt).toBeNull()
    const inviteRow = await repos.groupInvites.findByCodeHash('h_inv')
    expect(inviteRow?.consumedByUserId).toBe('user_joiner')
  })

  it('returns duplicate_active when the user is already an active member', async () => {
    const repos = buildMemoryRepos()
    await seedGroup(repos)
    await repos.groups.joinWithAttendee({
      memberId: 'grm_j_a',
      groupId: 'grp_j',
      userId: 'user_a',
      inviteId: null,
      attendeeId: 'eva_j_a',
      eventId: 'event_j',
    })
    const dup = await repos.groups.joinWithAttendee({
      memberId: 'grm_j_a2',
      groupId: 'grp_j',
      userId: 'user_a',
      inviteId: null,
      attendeeId: 'eva_j_a2',
      eventId: 'event_j',
    })
    expect(dup.ok).toBe(false)
    if (!dup.ok) expect(dup.reason).toBe('duplicate_active')
  })

  it('treats a soft-removed attendee as re-admission and clears removedAt', async () => {
    const repos = buildMemoryRepos()
    await seedGroup(repos)
    await repos.groups.joinWithAttendee({
      memberId: 'grm_j_r',
      groupId: 'grp_j',
      userId: 'user_r',
      inviteId: null,
      attendeeId: 'eva_j_r',
      eventId: 'event_j',
    })
    await repos.attendees.softRemove('event_j', 'user_r', new Date())
    expect(
      (await repos.attendees.findByEventAndUser('event_j', 'user_r'))?.removedAt,
    ).not.toBeNull()

    const rejoin = await repos.groups.joinWithAttendee({
      memberId: 'grm_j_r2', // unused on re-admission path
      groupId: 'grp_j',
      userId: 'user_r',
      inviteId: null,
      attendeeId: 'eva_j_r2',
      eventId: 'event_j',
    })
    expect(rejoin.ok).toBe(true)
    if (rejoin.ok) expect(rejoin.readmitted).toBe(true)
    // The original membership row is not duplicated.
    const members = await repos.groupMembers.listForGroup('grp_j')
    expect(members.filter((m) => m.userId === 'user_r')).toHaveLength(1)
    expect(
      (await repos.attendees.findByEventAndUser('event_j', 'user_r'))?.removedAt,
    ).toBeNull()
  })

})

describe('MemoryEventRepo.acceptInvite', () => {
  async function seedEvent(repos: ReturnType<typeof buildMemoryRepos>) {
    await repos.events.create({
      id: 'event_ai',
      tenantId: 'rallypoint',
      ownerUserId: 'user_owner',
      slug: 'ai',
      name: 'Atomic Invite',
      timezone: 'UTC',
      privacyMode: 'unlisted',
    })
    return repos.invites.create({
      id: 'evi_1',
      eventId: 'event_ai',
      codeHash: 'h_invite',
      invitedByUserId: 'user_owner',
      invitedEmail: null,
      role: 'editor',
      expiresAt: new Date(Date.now() + 86_400_000),
    })
  }

  it('happy path adds member + attendee + consumes invite', async () => {
    const repos = buildMemoryRepos()
    const invite = await seedEvent(repos)
    const res = await repos.events.acceptInvite({
      memberId: 'evm_1',
      attendeeId: 'eva_ai_1',
      eventId: 'event_ai',
      userId: 'user_guest',
      role: 'editor',
      inviteId: invite.id,
      skipMemberAdd: false,
    })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.readmitted).toBe(false)
    expect((await repos.members.findByEventAndUser('event_ai', 'user_guest'))?.role).toBe('editor')
    expect(
      (await repos.attendees.findByEventAndUser('event_ai', 'user_guest'))?.removedAt,
    ).toBeNull()
    expect((await repos.invites.findById(invite.id))?.consumedByUserId).toBe('user_guest')
  })

  it('re-admission via skipMemberAdd=true: clears removedAt without re-inserting member', async () => {
    const repos = buildMemoryRepos()
    const invite = await seedEvent(repos)
    // Seed an existing member row + a soft-removed attendee row.
    await repos.members.add({
      id: 'evm_pre',
      eventId: 'event_ai',
      userId: 'user_back',
      role: 'editor',
    })
    await repos.attendees.upsert({
      id: 'eva_pre',
      eventId: 'event_ai',
      userId: 'user_back',
    })
    await repos.attendees.softRemove('event_ai', 'user_back', new Date())

    const res = await repos.events.acceptInvite({
      memberId: 'evm_unused', // skipped
      attendeeId: 'eva_back',
      eventId: 'event_ai',
      userId: 'user_back',
      role: 'editor',
      inviteId: invite.id,
      skipMemberAdd: true,
    })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.readmitted).toBe(true)
    expect(
      (await repos.attendees.findByEventAndUser('event_ai', 'user_back'))?.removedAt,
    ).toBeNull()
    // Member row is the original, not duplicated.
    const m = await repos.members.findByEventAndUser('event_ai', 'user_back')
    expect(m?.id).toBe('evm_pre')
  })

  it('returns already_active_member on concurrent duplicate insert', async () => {
    const repos = buildMemoryRepos()
    const invite = await seedEvent(repos)
    // Pre-existing member (simulates the race where another tab won).
    await repos.members.add({
      id: 'evm_race',
      eventId: 'event_ai',
      userId: 'user_race',
      role: 'editor',
    })
    const res = await repos.events.acceptInvite({
      memberId: 'evm_race2',
      attendeeId: 'eva_race',
      eventId: 'event_ai',
      userId: 'user_race',
      role: 'editor',
      inviteId: invite.id,
      skipMemberAdd: false,
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('already_active_member')
  })
})

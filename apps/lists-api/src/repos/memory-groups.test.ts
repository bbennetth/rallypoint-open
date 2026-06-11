import { describe, it, expect } from 'vitest'
import { MemoryGroupRepo } from './memory.js'

// Unit tests for the MemoryGroupRepo idempotent-create behaviour added in
// #277. These run in the node pool (no D1 binding needed — the D1 integration
// test in groups.d1.test.ts covers the same invariant against real SQLite).

describe('MemoryGroupRepo.create — duplicate (createdBy, name) converges (#277)', () => {
  it('returns the winner group when a second create collides on (createdBy, name)', async () => {
    const repo = new MemoryGroupRepo()
    const actor = 'user_alice'

    const first = await repo.create({
      id: 'lgr_first',
      tenantId: 'rallypoint',
      name: 'My Tasks',
      createdBy: actor,
      ownerMemberId: 'lgm_first',
    })

    const second = await repo.create({
      id: 'lgr_second',
      tenantId: 'rallypoint',
      name: 'My Tasks',
      createdBy: actor,
      ownerMemberId: 'lgm_second',
    })

    // Both must return the SAME group — the first one (winner).
    expect(second.id).toBe(first.id)
    expect(second.name).toBe('My Tasks')
  })

  it('the second call does not insert a new group row', async () => {
    const repo = new MemoryGroupRepo()
    const actor = 'user_bob'

    await repo.create({
      id: 'lgr_bob_1',
      tenantId: 'rallypoint',
      name: 'My Tasks',
      createdBy: actor,
      ownerMemberId: 'lgm_bob_1',
    })
    await repo.create({
      id: 'lgr_bob_2',
      tenantId: 'rallypoint',
      name: 'My Tasks',
      createdBy: actor,
      ownerMemberId: 'lgm_bob_2',
    })

    // listForUser should return only ONE "My Tasks" group.
    const groups = await repo.listForUser(actor)
    const myTasks = groups.filter((g) => g.name === 'My Tasks')
    expect(myTasks).toHaveLength(1)
  })

  it('does not affect a different user creating the same name', async () => {
    const repo = new MemoryGroupRepo()

    const alice = await repo.create({
      id: 'lgr_alice',
      tenantId: 'rallypoint',
      name: 'My Tasks',
      createdBy: 'user_alice',
      ownerMemberId: 'lgm_alice',
    })
    const bob = await repo.create({
      id: 'lgr_bob',
      tenantId: 'rallypoint',
      name: 'My Tasks',
      createdBy: 'user_bob',
      ownerMemberId: 'lgm_bob',
    })

    // Different actors: both get their own group.
    expect(alice.id).not.toBe(bob.id)
  })

  it('allows the same name after the original group is soft-deleted', async () => {
    const repo = new MemoryGroupRepo()
    const actor = 'user_charlie'

    const original = await repo.create({
      id: 'lgr_orig',
      tenantId: 'rallypoint',
      name: 'My Tasks',
      createdBy: actor,
      ownerMemberId: 'lgm_orig',
    })

    await repo.softDelete(original.id, new Date())

    // Now create a new group with the same name — the old one is deleted so
    // there's no live collision.
    const revived = await repo.create({
      id: 'lgr_revived',
      tenantId: 'rallypoint',
      name: 'My Tasks',
      createdBy: actor,
      ownerMemberId: 'lgm_revived',
    })

    expect(revived.id).toBe('lgr_revived')
  })
})

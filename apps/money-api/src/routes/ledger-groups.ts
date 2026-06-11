import { Hono } from 'hono'
import { ulid } from 'ulid'
import {
  CreateLedgerGroupSchema,
  PatchLedgerGroupSchema,
} from '@rallypoint/money-shared'
import type { Context } from 'hono'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import type {
  LedgerGroupMemberRecord,
  LedgerGroupRecord,
} from '../repos/types.js'
import { readJsonBody } from './_body.js'
import { TENANT } from './_access.js'

function serializeGroup(g: LedgerGroupRecord): Record<string, unknown> {
  return {
    id: g.id,
    name: g.name,
    description: g.description,
    created_by: g.createdBy,
    created_at: g.createdAt.toISOString(),
    updated_at: g.updatedAt.toISOString(),
  }
}

function serializeMember(m: LedgerGroupMemberRecord): Record<string, unknown> {
  return {
    id: m.id,
    group_id: m.groupId,
    user_id: m.userId,
    role: m.role,
    joined_at: m.joinedAt.toISOString(),
  }
}

// Load a live group the caller belongs to. A group is invisible to
// non-members (404, not 403 — don't leak existence). When requireOwner
// is set, a non-owner gets a 403. Mirrors the Lists groups helper.
async function loadGroupForMember(
  c: Context<HonoApp>,
  groupId: string,
  requireOwner = false,
): Promise<{ group: LedgerGroupRecord; membership: LedgerGroupMemberRecord }> {
  const userId = c.var.session!.userId
  const group = await c.var.repos.ledgerGroups.findById(groupId)
  if (!group || group.deletedAt) throw errors.ledgerGroupNotFound()
  const membership = await c.var.repos.ledgerGroups.findMembership(groupId, userId)
  if (!membership) throw errors.ledgerGroupNotFound()
  if (requireOwner && membership.role !== 'owner') {
    throw errors.forbidden('Only the group owner can perform this action.')
  }
  return { group, membership }
}

export const ledgerGroupsRoutes = new Hono<HonoApp>()
  // --- create (creator auto-enrolled as owner) -----------------------
  .post('/api/v1/ui/ledger-groups', async (c) => {
    const userId = c.var.session!.userId
    const parsed = CreateLedgerGroupSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const body = parsed.data

    const group = await c.var.repos.ledgerGroups.create({
      id: `lgr_${ulid()}`,
      tenantId: TENANT,
      name: body.name,
      description: body.description ?? null,
      createdBy: userId,
      ownerMemberId: `lgm_${ulid()}`,
    })
    return c.json(serializeGroup(group), 201)
  })

  // --- list my groups ------------------------------------------------
  .get('/api/v1/ui/ledger-groups', async (c) => {
    const userId = c.var.session!.userId
    const rows = await c.var.repos.ledgerGroups.listForUser(userId)
    return c.json({ items: rows.map(serializeGroup) })
  })

  // --- detail (members only) -----------------------------------------
  .get('/api/v1/ui/ledger-groups/:groupId', async (c) => {
    const { group } = await loadGroupForMember(c, c.req.param('groupId'))
    return c.json(serializeGroup(group))
  })

  // --- members (members only) ----------------------------------------
  .get('/api/v1/ui/ledger-groups/:groupId/members', async (c) => {
    const { group } = await loadGroupForMember(c, c.req.param('groupId'))
    const members = await c.var.repos.ledgerGroups.listMembers(group.id)
    return c.json({ items: members.map(serializeMember) })
  })

  // --- patch (owner only) --------------------------------------------
  .patch('/api/v1/ui/ledger-groups/:groupId', async (c) => {
    const { group } = await loadGroupForMember(c, c.req.param('groupId'), true)
    const parsed = PatchLedgerGroupSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const updated = await c.var.repos.ledgerGroups.patch(group.id, parsed.data)
    if (!updated) throw errors.ledgerGroupNotFound()
    return c.json(serializeGroup(updated))
  })

  // --- soft-delete (owner only) --------------------------------------
  .delete('/api/v1/ui/ledger-groups/:groupId', async (c) => {
    const { group } = await loadGroupForMember(c, c.req.param('groupId'), true)
    await c.var.repos.ledgerGroups.softDelete(group.id, new Date())
    return c.body(null, 204)
  })

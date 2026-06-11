import { Hono } from 'hono'
import { ulid } from 'ulid'
import { CreateGroupSchema, UpdateGroupSchema } from '@rallypoint/lists-shared'
import type { Context } from 'hono'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import type { GroupMemberRecord, GroupRecord } from '../repos/types.js'
import { readJsonBody } from './_body.js'

const TENANT = 'rallypoint'

function serializeGroup(g: GroupRecord): Record<string, unknown> {
  return {
    id: g.id,
    name: g.name,
    description: g.description,
    created_by: g.createdBy,
    created_at: g.createdAt.toISOString(),
    updated_at: g.updatedAt.toISOString(),
  }
}

function serializeMember(m: GroupMemberRecord): Record<string, unknown> {
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
// is set, a member who is not the owner gets a 403.
async function loadGroupForMember(
  c: Context<HonoApp>,
  groupId: string,
  requireOwner = false,
): Promise<{ group: GroupRecord; membership: GroupMemberRecord }> {
  const userId = c.var.session!.userId
  const group = await c.var.repos.groups.findById(groupId)
  if (!group || group.deletedAt) throw errors.groupNotFound()
  const membership = await c.var.repos.groups.findMembership(groupId, userId)
  if (!membership) throw errors.groupNotFound()
  if (requireOwner && membership.role !== 'owner') {
    throw errors.forbidden('Only the group owner can perform this action.')
  }
  return { group, membership }
}

export const groupsRoutes = new Hono<HonoApp>()
  // --- create (creator auto-enrolled as owner) ---------------------
  .post('/api/v1/ui/groups', async (c) => {
    const userId = c.var.session!.userId
    const parsed = CreateGroupSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const body = parsed.data

    const group = await c.var.repos.groups.create({
      id: `lgr_${ulid()}`,
      tenantId: TENANT,
      name: body.name,
      description: body.description ?? null,
      createdBy: userId,
      ownerMemberId: `lgm_${ulid()}`,
    })
    return c.json(serializeGroup(group), 201)
  })

  // --- list my groups ----------------------------------------------
  .get('/api/v1/ui/groups', async (c) => {
    const userId = c.var.session!.userId
    const rows = await c.var.repos.groups.listForUser(userId)
    return c.json({ items: rows.map(serializeGroup) })
  })

  // --- get one (members only) --------------------------------------
  .get('/api/v1/ui/groups/:groupId', async (c) => {
    const { group } = await loadGroupForMember(c, c.req.param('groupId'))
    return c.json(serializeGroup(group))
  })

  // --- members (members only) --------------------------------------
  .get('/api/v1/ui/groups/:groupId/members', async (c) => {
    const { group } = await loadGroupForMember(c, c.req.param('groupId'))
    const members = await c.var.repos.groups.listMembers(group.id)
    return c.json({ items: members.map(serializeMember) })
  })

  // --- update (owner only) -----------------------------------------
  .patch('/api/v1/ui/groups/:groupId', async (c) => {
    const { group } = await loadGroupForMember(c, c.req.param('groupId'), true)
    const parsed = UpdateGroupSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const updated = await c.var.repos.groups.update(group.id, parsed.data)
    if (!updated) throw errors.groupNotFound()
    return c.json(serializeGroup(updated))
  })

  // --- soft-delete (owner only) ------------------------------------
  .delete('/api/v1/ui/groups/:groupId', async (c) => {
    const { group } = await loadGroupForMember(c, c.req.param('groupId'), true)
    await c.var.repos.groups.softDelete(group.id, new Date())
    return c.body(null, 204)
  })

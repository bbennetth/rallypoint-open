import { Hono } from 'hono'
import { ulid } from 'ulid'
import { PutMemberLocationSchema } from '@rallypoint/events-shared'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import type { GroupMemberLocationRecord } from '../repos/types.js'
import { readJsonBody } from './_body.js'
import { loadGroupForAction } from './_group-access.js'
import { publish } from '../realtime/publish.js'
import { groupChannel, envelope } from '../realtime/channels.js'

// Crew map pins (attendee Map tab). A member's "location" is a
// self-placed pin on the event's image map — a percentage position on
// one map layer, not GPS — visible to the whole group. One pin per
// member per group; placing again moves it, DELETE removes it. All
// routes gate on group membership ('member'); mutations act only on the
// caller's own row. Mutations publish pointer envelopes on the group
// channel so other members' maps refetch live.

function serializeLocation(
  l: GroupMemberLocationRecord,
  displayName: string | null,
): Record<string, unknown> {
  return {
    user_id: l.userId,
    display_name: displayName,
    layer: l.layer,
    x_pct: l.xPct,
    y_pct: l.yPct,
    updated_at: l.updatedAt.toISOString(),
  }
}

function publishLocation(
  c: Parameters<typeof loadGroupForAction>[0],
  groupId: string,
  operation: 'update' | 'delete',
): void {
  const userId = c.var.session!.userId
  publish(c, groupChannel(groupId), envelope('member_locations', operation, userId, userId))
}

export const memberLocationsRoutes = new Hono<HonoApp>()
  // --- list (group member+) -----------------------------------------
  .get('/api/v1/ui/groups/:id/locations', async (c) => {
    const { group } = await loadGroupForAction(c, c.req.param('id'), 'member')
    const rows = await c.var.repos.groupMemberLocations.listForGroup(group.id)
    const userIds = Array.from(new Set(rows.map((r) => r.userId)))
    const lookup = userIds.length
      ? await c.var.services.idClient.batchLookupUsers(userIds)
      : []
    const nameById = new Map(lookup.map((u) => [u.userId, u.displayName ?? null]))
    return c.json({
      items: rows.map((r) => serializeLocation(r, nameById.get(r.userId) ?? null)),
    })
  })

  // --- place/move own pin (group member+, self) ---------------------
  .put('/api/v1/ui/groups/:id/locations/me', async (c) => {
    const { group } = await loadGroupForAction(c, c.req.param('id'), 'member')
    const parsed = PutMemberLocationSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const row = await c.var.repos.groupMemberLocations.upsertForMember({
      id: `gml_${ulid()}`,
      groupId: group.id,
      userId: c.var.session!.userId,
      layer: parsed.data.layer,
      xPct: parsed.data.xPct,
      yPct: parsed.data.yPct,
    })
    publishLocation(c, group.id, 'update')
    return c.json(serializeLocation(row, null))
  })

  // --- remove own pin (group member+, self) -------------------------
  .delete('/api/v1/ui/groups/:id/locations/me', async (c) => {
    const { group } = await loadGroupForAction(c, c.req.param('id'), 'member')
    await c.var.repos.groupMemberLocations.deleteForMember(group.id, c.var.session!.userId)
    publishLocation(c, group.id, 'delete')
    return c.body(null, 204)
  })

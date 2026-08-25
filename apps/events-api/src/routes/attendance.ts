import { Hono } from 'hono'
import { ulid } from 'ulid'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import { loadForAction, recordActivity } from './_access.js'

// Self-service attendance: the caller joins/leaves an event they
// already have access to as a real attendee (event_attendees row).
// Primary consumers are the owner (and allowlisted admins on
// system-owned events, who resolve as role 'owner') joining their own
// event to get the full attendee experience — appearing in rosters,
// joining groups — rather than the read-only owner preview.

export const attendanceRoutes = new Hono<HonoApp>()
  // --- join (idempotent) -------------------------------------------
  .post('/api/v1/ui/events/:id/attendance', async (c) => {
    const userId = c.var.session!.userId
    const { event } = await loadForAction(c, c.req.param('id'), 'viewer')
    const attendee = await c.var.repos.attendees.upsert({
      id: `eva_${ulid()}`,
      eventId: event.id,
      userId,
    })
    await recordActivity(c, event.id, 'event.attendance_joined')
    return c.json({ attending: true, joined_at: attendee.joinedAt.toISOString() })
  })

  // --- self-leave (owner-role only) --------------------------------
  .delete('/api/v1/ui/events/:id/attendance', async (c) => {
    const userId = c.var.session!.userId
    const { event, role } = await loadForAction(c, c.req.param('id'), 'viewer')
    // Only an owner-role actor keeps access after their attendee row is
    // soft-removed (the owner short-circuit in actorRole). A
    // collaborator soft-removing their own row would lock themselves
    // out of the event entirely (Phase 0 revocation rule), so they
    // must go through the existing removal flow instead.
    if (role !== 'owner') {
      throw errors.conflict(
        'self_leave_owner_only',
        'Only the event owner can leave attendance while keeping access.',
      )
    }
    const attendee = await c.var.repos.attendees.findByEventAndUser(event.id, userId)
    if (!attendee || attendee.removedAt !== null) {
      throw errors.conflict('not_attending', 'You are not attending this event.')
    }
    await c.var.repos.attendees.softRemove(event.id, userId, new Date())
    await recordActivity(c, event.id, 'event.attendance_left')
    return c.json({ attending: false })
  })

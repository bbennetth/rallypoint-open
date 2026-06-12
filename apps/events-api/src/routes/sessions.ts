import { Hono } from 'hono'
import type { Context } from 'hono'
import { ulid } from 'ulid'
import {
  BulkSessionsSchema,
  CreateSessionSchema,
  PatchSessionSchema,
  type CreateSessionBody,
} from '@rallypoint/events-shared'
import type { HonoApp } from '../context.js'
import { ApiError, errors } from '../errors.js'
import type { CreateSessionInput, SessionRecord } from '../repos/types.js'
import { readJsonBody } from './_body.js'
import { loadForAction, recordActivity } from './_access.js'
import { assertFeatureEnabled } from './_features.js'
import { captureSnapshot } from './_snapshots.js'

function serializeSession(s: SessionRecord): Record<string, unknown> {
  return {
    id: s.id,
    event_id: s.eventId,
    title: s.title,
    description: s.description,
    location: s.location,
    day_id: s.dayId,
    stage_id: s.stageId,
    start_time: s.startTime,
    end_time: s.endTime,
    category: s.category,
    host: s.host,
    approval_status: s.approvalStatus,
    visibility: s.visibility,
    group_id: s.groupId,
    shared_with: s.sharedWith,
    created_by_user_id: s.createdByUserId,
    submitted_by_user_id: s.submittedByUserId,
    approved_by_user_id: s.approvedByUserId,
    approved_at: s.approvedAt ? s.approvedAt.toISOString() : null,
    created_at: s.createdAt.toISOString(),
    updated_at: s.updatedAt.toISOString(),
  }
}

function approvalRequired(): ApiError {
  return new ApiError({
    code: 'session_approval_required',
    message: 'Only the event owner can approve or reject sessions.',
    status: 403,
  })
}

// Confirm a session exists and belongs to this event; 404 otherwise so
// a foreign session id can't be probed through another event.
async function loadSession(
  c: Context<HonoApp>,
  eventId: string,
  sessionId: string,
): Promise<SessionRecord> {
  const session = await c.var.repos.eventSessions.findById(sessionId)
  if (!session || session.eventId !== eventId || session.deletedAt) {
    throw errors.notFound('Session not found.')
  }
  return session
}

// Reject a dayId that doesn't belong to this event (the FK only proves
// the day exists somewhere, not that it's THIS event's day).
async function assertDayInEvent(
  c: Context<HonoApp>,
  eventId: string,
  dayId: string | null | undefined,
): Promise<void> {
  if (dayId == null) return
  const day = await c.var.repos.days.findById(dayId)
  if (!day || day.eventId !== eventId) {
    throw new ApiError({
      code: 'day_not_in_event',
      message: 'Referenced day does not belong to this event.',
      status: 400,
    })
  }
}

// Reject a stageId that doesn't belong to this event (same probing
// concern as assertDayInEvent; mirrors the lineup bulk-apply check).
async function assertStageInEvent(
  c: Context<HonoApp>,
  eventId: string,
  stageId: string | null | undefined,
): Promise<void> {
  if (stageId == null) return
  const stage = await c.var.repos.stages.findById(stageId)
  if (!stage || stage.eventId !== eventId) {
    throw new ApiError({
      code: 'stage_not_in_event',
      message: 'Referenced stage does not belong to this event.',
      status: 400,
    })
  }
}

// Reject a groupId that doesn't belong to this event (the FK only proves
// the group exists somewhere, not that it's THIS event's group — without
// this an editor could attach a session to a group under another event).
async function assertGroupInEvent(
  c: Context<HonoApp>,
  eventId: string,
  groupId: string | null | undefined,
): Promise<void> {
  if (groupId == null) return
  const group = await c.var.repos.groups.findById(groupId)
  if (!group || group.eventId !== eventId) {
    throw new ApiError({
      code: 'group_not_in_event',
      message: 'Referenced group does not belong to this event.',
      status: 400,
    })
  }
}

export const sessionsRoutes = new Hono<HonoApp>()
  .get('/api/v1/ui/events/:id/sessions', async (c) => {
    const { event, role } = await loadForAction(c, c.req.param('id'), 'viewer')
    assertFeatureEnabled(event, role, 'sessions')
    const status = c.req.query('approval_status')
    const dayId = c.req.query('day_id')
    const items = await c.var.repos.eventSessions.listForEvent(event.id, {
      ...(status === 'approved' || status === 'pending' || status === 'rejected'
        ? { approvalStatus: status }
        : {}),
      ...(dayId ? { dayId } : {}),
    })
    return c.json({ items: items.map(serializeSession) })
  })
  .post('/api/v1/ui/events/:id/sessions', async (c) => {
    const { event, role } = await loadForAction(c, c.req.param('id'), 'editor')
    assertFeatureEnabled(event, role, 'sessions')
    const parsed = CreateSessionSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const body: CreateSessionBody = parsed.data
    await assertDayInEvent(c, event.id, body.dayId)
    await assertStageInEvent(c, event.id, body.stageId)
    await assertGroupInEvent(c, event.id, body.groupId)

    const userId = c.var.session!.userId
    // Owner-authored sessions are pre-approved; everyone else's enter
    // the approval queue as 'pending' for the owner to act on. Owner
    // creates carry the approver stamp in the same insert.
    const owner = role === 'owner'
    const saved = await c.var.repos.eventSessions.create({
      id: `evx_${ulid()}`,
      eventId: event.id,
      title: body.title,
      description: body.description ?? null,
      location: body.location ?? null,
      dayId: body.dayId ?? null,
      stageId: body.stageId ?? null,
      startTime: body.startTime ?? null,
      endTime: body.endTime ?? null,
      category: body.category ?? null,
      host: body.host ?? null,
      approvalStatus: owner ? 'approved' : 'pending',
      visibility: body.visibility ?? 'group',
      groupId: body.groupId ?? null,
      sharedWith: body.sharedWith ?? null,
      createdByUserId: userId,
      submittedByUserId: owner ? null : userId,
      approvedByUserId: owner ? userId : null,
      approvedAt: owner ? new Date() : null,
    })
    await recordActivity(c, event.id, 'event.session_created', {
      session_id: saved.id,
      approval_status: saved.approvalStatus,
    })
    return c.json(serializeSession(saved), 201)
  })
  .get('/api/v1/ui/events/:id/sessions/:sessionId', async (c) => {
    const { event, role } = await loadForAction(c, c.req.param('id'), 'viewer')
    assertFeatureEnabled(event, role, 'sessions')
    const session = await loadSession(c, event.id, c.req.param('sessionId'))
    return c.json(serializeSession(session))
  })
  .patch('/api/v1/ui/events/:id/sessions/:sessionId', async (c) => {
    const { event, role } = await loadForAction(c, c.req.param('id'), 'editor')
    assertFeatureEnabled(event, role, 'sessions')
    const session = await loadSession(c, event.id, c.req.param('sessionId'))
    const parsed = PatchSessionSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    if (parsed.data.dayId !== undefined) await assertDayInEvent(c, event.id, parsed.data.dayId)
    if (parsed.data.stageId !== undefined) await assertStageInEvent(c, event.id, parsed.data.stageId)
    if (parsed.data.groupId !== undefined) await assertGroupInEvent(c, event.id, parsed.data.groupId)
    const updated = await c.var.repos.eventSessions.patch(session.id, parsed.data)
    await recordActivity(c, event.id, 'event.session_updated', { session_id: session.id })
    return c.json(serializeSession(updated!))
  })
  .delete('/api/v1/ui/events/:id/sessions/:sessionId', async (c) => {
    const { event, role } = await loadForAction(c, c.req.param('id'), 'editor')
    assertFeatureEnabled(event, role, 'sessions')
    const session = await loadSession(c, event.id, c.req.param('sessionId'))
    await c.var.repos.eventSessions.softDelete(session.id, new Date())
    await recordActivity(c, event.id, 'event.session_deleted', { session_id: session.id })
    return c.body(null, 204)
  })
  // Re-enter the approval queue after a rejection. Any editor may
  // submit, but only a 'rejected' session is re-submittable — this can't
  // be used to unilaterally revert an owner's 'approved' decision. Clears
  // the stale approver stamp and records the (re)submitter.
  .post('/api/v1/ui/events/:id/sessions/:sessionId/submit', async (c) => {
    const { event, role } = await loadForAction(c, c.req.param('id'), 'editor')
    assertFeatureEnabled(event, role, 'sessions')
    const session = await loadSession(c, event.id, c.req.param('sessionId'))
    if (session.approvalStatus !== 'rejected') {
      throw errors.conflict(
        'session_not_rejected',
        'Only a rejected session can be re-submitted for approval.',
      )
    }
    const updated = await c.var.repos.eventSessions.setApproval(session.id, {
      status: 'pending',
      approvedByUserId: null,
      approvedAt: null,
      submittedByUserId: c.var.session!.userId,
    })
    await recordActivity(c, event.id, 'event.session_submitted', { session_id: session.id })
    return c.json(serializeSession(updated!))
  })
  .post('/api/v1/ui/events/:id/sessions/:sessionId/approve', async (c) => {
    const { event, role } = await loadForAction(c, c.req.param('id'), 'editor')
    assertFeatureEnabled(event, role, 'sessions')
    if (role !== 'owner') throw approvalRequired()
    const session = await loadSession(c, event.id, c.req.param('sessionId'))
    const updated = await c.var.repos.eventSessions.setApproval(session.id, {
      status: 'approved',
      approvedByUserId: c.var.session!.userId,
      approvedAt: new Date(),
    })
    await recordActivity(c, event.id, 'event.session_approved', { session_id: session.id })
    return c.json(serializeSession(updated!))
  })
  .post('/api/v1/ui/events/:id/sessions/:sessionId/reject', async (c) => {
    const { event, role } = await loadForAction(c, c.req.param('id'), 'editor')
    assertFeatureEnabled(event, role, 'sessions')
    if (role !== 'owner') throw approvalRequired()
    const session = await loadSession(c, event.id, c.req.param('sessionId'))
    const updated = await c.var.repos.eventSessions.setApproval(session.id, {
      status: 'rejected',
      approvedByUserId: c.var.session!.userId,
      approvedAt: new Date(),
    })
    await recordActivity(c, event.id, 'event.session_rejected', { session_id: session.id })
    return c.json(serializeSession(updated!))
  })
  // Transactional bulk create + update + delete. Applies the same
  // approval rules as the single-create endpoint: owner-created sessions
  // are pre-approved; editor-created sessions enter the queue as pending.
  // Cross-event day references are rejected (assertDayInEvent).
  .post('/api/v1/ui/events/:id/sessions/bulk', async (c) => {
    const { event, role } = await loadForAction(c, c.req.param('id'), 'editor')
    assertFeatureEnabled(event, role, 'sessions')
    const parsed = BulkSessionsSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const body = parsed.data

    const userId = c.var.session!.userId
    const owner = role === 'owner'
    const nowTs = new Date()

    // Validate all referenced day/group refs up front (before writing
    // anything), and confirm every update/delete target is a live
    // session OF THIS EVENT — loadSession 404s a foreign or deleted id,
    // so a session under another event can't be mutated by id here.
    for (const cr of body.creates ?? []) {
      await assertDayInEvent(c, event.id, cr.dayId)
      await assertStageInEvent(c, event.id, cr.stageId)
      await assertGroupInEvent(c, event.id, cr.groupId)
    }
    for (const up of body.updates ?? []) {
      await loadSession(c, event.id, up.id)
      if (up.patch.dayId !== undefined) await assertDayInEvent(c, event.id, up.patch.dayId)
      if (up.patch.stageId !== undefined) await assertStageInEvent(c, event.id, up.patch.stageId)
      if (up.patch.groupId !== undefined) await assertGroupInEvent(c, event.id, up.patch.groupId)
    }
    for (const id of body.deletes ?? []) {
      await loadSession(c, event.id, id)
    }

    // Build CreateSessionInput[] — apply approval logic per row. Owner
    // creates carry the approver stamp in the SAME insert (inside the
    // bulk txn) so an approved row is never momentarily un-stamped.
    const creates: CreateSessionInput[] = (body.creates ?? []).map((cr) => ({
      id: `evx_${ulid()}`,
      eventId: event.id,
      title: cr.title,
      description: cr.description ?? null,
      location: cr.location ?? null,
      dayId: cr.dayId ?? null,
      stageId: cr.stageId ?? null,
      startTime: cr.startTime ?? null,
      endTime: cr.endTime ?? null,
      category: cr.category ?? null,
      host: cr.host ?? null,
      approvalStatus: owner ? 'approved' : 'pending',
      visibility: cr.visibility ?? 'group',
      groupId: cr.groupId ?? null,
      sharedWith: cr.sharedWith ?? null,
      createdByUserId: userId,
      submittedByUserId: owner ? null : userId,
      approvedByUserId: owner ? userId : null,
      approvedAt: owner ? nowTs : null,
    }))

    // Capture a pre-apply version before any destructive op (updates or
    // deletes overwrite/remove existing rows). Pure-create applies lose
    // nothing, so they don't snapshot (#191 Phase 2).
    if ((body.updates ?? []).length > 0 || (body.deletes ?? []).length > 0) {
      await captureSnapshot(c, event.id, 'sessions', 'before bulk sessions edit', userId)
    }

    const { created, updated } = await c.var.repos.eventSessions.bulkApply({
      eventId: event.id,
      creates,
      updates: (body.updates ?? []).map((u) => ({ id: u.id, patch: u.patch })),
      deletes: body.deletes ?? [],
    })

    await recordActivity(c, event.id, 'event.sessions_bulk_updated', {
      created: created.length,
      updated: updated.length,
      deleted: (body.deletes ?? []).length,
    })

    const items = [...created, ...updated].map(serializeSession)
    return c.json({ items }, 200)
  })

import { Hono } from 'hono'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import type { SnapshotKind, SnapshotSummary } from '../repos/types.js'
import { loadForAction, recordActivity } from './_access.js'
import {
  captureSnapshot,
  deserializeLineupSnapshot,
  deserializeSessionsSnapshot,
} from './_snapshots.js'
import { publish } from '../realtime/publish.js'
import { eventChannel, envelope } from '../realtime/channels.js'

function serializeSnapshot(s: SnapshotSummary): Record<string, unknown> {
  return {
    id: s.id,
    event_id: s.eventId,
    kind: s.kind,
    reason: s.reason,
    item_count: s.itemCount,
    created_by_user_id: s.createdByUserId,
    created_at: s.createdAt.toISOString(),
  }
}

function parseKind(raw: string | undefined): SnapshotKind {
  if (raw === 'lineup' || raw === 'sessions') return raw
  throw errors.validation({ kind: 'must be "lineup" or "sessions"' })
}

// Version history for the bulk-editable Lineup and Sessions tabs
// (#191 Phase 2). History is an editor concern (it backs the restore
// affordance), so both endpoints require the editor role.
export const snapshotsRoutes = new Hono<HonoApp>()
  .get('/api/v1/ui/events/:id/snapshots', async (c) => {
    const { event } = await loadForAction(c, c.req.param('id'), 'editor')
    const kind = parseKind(c.req.query('kind'))
    const items = await c.var.repos.eventSnapshots.listForEvent(event.id, kind)
    return c.json({ items: items.map(serializeSnapshot) })
  })
  .post('/api/v1/ui/events/:id/snapshots/:snapshotId/restore', async (c) => {
    const { event } = await loadForAction(c, c.req.param('id'), 'editor')
    const snapshot = await c.var.repos.eventSnapshots.findById(c.req.param('snapshotId'))
    if (!snapshot || snapshot.eventId !== event.id) {
      throw errors.notFound('Snapshot not found.')
    }
    const userId = c.var.session!.userId

    // Capture the current state first so the restore itself is undoable.
    await captureSnapshot(c, event.id, snapshot.kind, 'before restore', userId)

    if (snapshot.kind === 'lineup') {
      const rows = deserializeLineupSnapshot(snapshot.data)
      await c.var.repos.eventArtists.replaceAll(event.id, rows)
      publish(
        c,
        eventChannel(event.id),
        envelope('event_artists', 'update', event.id, userId),
      )
    } else {
      const rows = deserializeSessionsSnapshot(snapshot.data)
      await c.var.repos.eventSessions.restoreActive(event.id, rows, new Date())
    }

    await recordActivity(c, event.id, 'event.snapshot_restored', {
      snapshot_id: snapshot.id,
      kind: snapshot.kind,
      item_count: snapshot.itemCount,
    })
    return c.json({ restored: snapshot.id, kind: snapshot.kind }, 200)
  })

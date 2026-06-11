import { ulid } from 'ulid'
import type { Context } from 'hono'
import type { HonoApp } from '../context.js'
import type {
  EventArtistRecord,
  SessionApprovalStatus,
  SessionRecord,
  SessionVisibility,
  SnapshotKind,
} from '../repos/types.js'

// Version history for the bulk-editable Lineup and Sessions tabs
// (#191 Phase 2). Before each destructive bulk apply we capture the
// current full set of rows into one event_snapshots row so a bad edit
// can be reverted. The jsonb `data` column round-trips through JSON, so
// Date fields come back as ISO strings on the PG path (and stay Date on
// the memory path) — the deserialize helpers below accept both.

// How many snapshots we retain per (event, kind). Older ones are pruned
// after each capture so the table can't grow unbounded.
export const SNAPSHOT_RETENTION = 20

// --- pure (de)serialize helpers — unit-tested in _snapshots.test.ts ---

// Lineup rows are pure strings (event_artists has no timestamp columns),
// so capture is the identity array and restore just re-validates shape.
export function deserializeLineupSnapshot(data: unknown): EventArtistRecord[] {
  if (!Array.isArray(data)) return []
  return data.map((raw) => {
    const r = raw as Record<string, unknown>
    return {
      eventId: String(r.eventId),
      artistId: String(r.artistId),
      dayId: String(r.dayId),
      stageId: (r.stageId as string | null) ?? null,
      tier: (r.tier as string | null) ?? null,
      genre: (r.genre as string | null) ?? null,
      startTime: (r.startTime as string | null) ?? null,
      endTime: (r.endTime as string | null) ?? null,
      displayName: (r.displayName as string | null) ?? null,
    }
  })
}

// Accept a Date (memory path) or an ISO string (pg jsonb path); null/
// undefined pass through as null.
function toDate(v: unknown): Date | null {
  if (v == null) return null
  if (v instanceof Date) return v
  return new Date(String(v))
}

export function deserializeSessionsSnapshot(data: unknown): SessionRecord[] {
  if (!Array.isArray(data)) return []
  return data.map((raw) => {
    const r = raw as Record<string, unknown>
    return {
      id: String(r.id),
      eventId: String(r.eventId),
      title: String(r.title),
      description: (r.description as string | null) ?? null,
      location: (r.location as string | null) ?? null,
      dayId: (r.dayId as string | null) ?? null,
      startTime: (r.startTime as string | null) ?? null,
      endTime: (r.endTime as string | null) ?? null,
      category: (r.category as string | null) ?? null,
      host: (r.host as string | null) ?? null,
      approvalStatus: r.approvalStatus as SessionApprovalStatus,
      visibility: r.visibility as SessionVisibility,
      groupId: (r.groupId as string | null) ?? null,
      sharedWith: (r.sharedWith as string[] | null) ?? null,
      createdByUserId: String(r.createdByUserId),
      submittedByUserId: (r.submittedByUserId as string | null) ?? null,
      approvedByUserId: (r.approvedByUserId as string | null) ?? null,
      approvedAt: toDate(r.approvedAt),
      createdAt: toDate(r.createdAt) ?? new Date(0),
      updatedAt: toDate(r.updatedAt) ?? new Date(0),
      deletedAt: toDate(r.deletedAt),
    }
  })
}

// --- capture (route-side, needs repo context) ------------------------

// Capture the current full row set for `kind` into a snapshot, then
// prune older snapshots past the retention window. Returns the created
// snapshot id (or null when there is nothing to snapshot — never the
// case in practice since we capture before every apply). Call this
// INSIDE the route, after loadForAction, BEFORE the mutation.
export async function captureSnapshot(
  c: Context<HonoApp>,
  eventId: string,
  kind: SnapshotKind,
  reason: string,
  userId: string,
): Promise<string> {
  const repos = c.var.repos
  const data =
    kind === 'lineup'
      ? await repos.eventArtists.listForEvent(eventId)
      : await repos.eventSessions.listForEvent(eventId)
  const id = `esnap_${ulid()}`
  await repos.eventSnapshots.create({
    id,
    eventId,
    kind,
    data,
    reason,
    itemCount: data.length,
    createdByUserId: userId,
  })
  await repos.eventSnapshots.prune(eventId, kind, SNAPSHOT_RETENTION)
  return id
}

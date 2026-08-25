import { z } from 'zod'
import { listBundleSchema } from '@rallypoint/lists-shared'

// Manifest for the Planner data export/import archive (backup–restore).
//
// The archive is a ZIP: `manifest.json` FIRST, then `blobs/<ticketRef>.<ext>`
// for personal-event ticket attachments. Manifest-first lets the importer plan
// before the blob bytes arrive.
//
// Planner owns NO domain data — everything here is composed from the Lists and
// Events SDKs, and the shapes come from those packages rather than being
// redefined locally. Per the SDK-first rule, the knowledge of what a list
// contains lives in lists-shared (`listBundleSchema`); this file only describes
// how Planner staples the pieces together.
//
// Deliberately NOT exported: sessions, push subscriptions and scheduled
// notifications. Push subscriptions are per-device and meaningless on another
// browser; scheduled notifications are DERIVED — the write proxies re-enqueue
// them as imported events and tasks land, so restoring them would double-book.

export const PLANNER_EXPORT_SCHEMA_VERSION = 1

const shortText = z.string().max(500)
const longText = z.string().max(20_000)

const ticketSchema = z.object({
  fileName: shortText,
  contentType: shortText,
  bytes: z.number().int().nonnegative(),
  /** Archive path of this ticket's bytes, e.g. `blobs/evt_x__t1.pdf`. */
  blob: z.string().max(256),
})

const eventSchema = z.object({
  /** Dedupe key — the source event's id, replayed into `createPersonalEvent`,
   *  which already dedupes on (owner, ref) for offline-create retries. */
  ref: shortText,
  name: shortText,
  description: longText.nullable().optional(),
  startAt: shortText.nullable().optional(),
  endAt: shortText.nullable().optional(),
  allDay: z.boolean().optional(),
  locationLabel: shortText.nullable().optional(),
  ticketPlatform: shortText.nullable().optional(),
  ticketAccountEmail: shortText.nullable().optional(),
  tickets: z.array(ticketSchema).max(50).default([]),
})

export const plannerManifestSchema = z.object({
  schemaVersion: z.literal(PLANNER_EXPORT_SCHEMA_VERSION),
  app: z.literal('planner'),
  exportedAt: z.number().int(),
  /** One bundle per list in the actor's personal scope — tasks, shopping,
   *  notes, diary, chores and brain-dump all live there. */
  lists: z.array(listBundleSchema).max(500).default([]),
  events: z.array(eventSchema).max(50_000).default([]),
})

export type PlannerManifest = z.infer<typeof plannerManifestSchema>
export type ExportedPlannerEvent = z.infer<typeof eventSchema>
export type ExportedPlannerTicket = z.infer<typeof ticketSchema>

/** Archive path of the manifest. The importer requires it as the FIRST entry. */
export const PLANNER_MANIFEST_ENTRY = 'manifest.json'

/** Cap on the uploaded archive — well above a realistic personal scope and
 *  below the Workers request-body ceiling. */
export const PLANNER_IMPORT_MAX_BYTES = 200 * 1024 * 1024

/** Cap on a single inflated entry — a zip-bomb guard, and the second half of
 *  the import's memory budget: an entry is fully decoded before its size can be
 *  measured against the buffered-bytes ceiling, so the transient peak is
 *  (buffered + this). Tickets are capped at 10 MB at upload, so 16 MB leaves
 *  room for a large manifest while keeping that peak far below an isolate's. */
export const PLANNER_IMPORT_MAX_ENTRY_BYTES = 16 * 1024 * 1024

/** Archive path for a ticket's bytes. Keyed by event ref + ticket index so it
 *  stays stable across a re-export and can't collide between events. */
export function ticketBlobPath(eventRef: string, index: number, fileName: string): string {
  const ext = fileName.includes('.') ? fileName.split('.').pop()! : 'bin'
  const safeExt = /^[a-zA-Z0-9]{1,8}$/.test(ext) ? ext.toLowerCase() : 'bin'
  // The ref is an id we minted, but sanitise anyway — this becomes a path.
  const safeRef = eventRef.replace(/[^a-zA-Z0-9_-]/g, '_')
  return `blobs/${safeRef}__${index}.${safeExt}`
}

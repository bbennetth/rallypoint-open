import { Hono } from 'hono'
import { ImportTally, streamUnzip } from '@rallypoint/api-kit'
import type { CreatePersonalEventInput } from '@rallypoint/events-client'
import type { HonoApp } from '../context.js'
import { ApiError, errors } from '../errors.js'
import { requireSession } from '../middleware/session.js'
import { resolvePersonalScope } from '../lib/personal-scope.js'
import {
  PLANNER_IMPORT_MAX_BYTES,
  PLANNER_IMPORT_MAX_ENTRY_BYTES,
  PLANNER_MANIFEST_ENTRY,
  plannerManifestSchema,
  type ExportedPlannerEvent,
  type PlannerManifest,
} from '../lib/export-manifest.js'

// Whole-account Planner data import (backup–restore).
//
//   POST /api/v1/ui/data-import   body: the exported ZIP
//
// Merge-with-dedupe, same contract as Health: lists reconcile by name, items
// and series by ref (the key the Lists create path already dedupes on), and
// personal events by ref through `createPersonalEvent`. Re-running the same
// archive therefore creates nothing, which is the recovery path for a partial
// import — there is no transaction spanning the SDK calls an import makes.
//
// All the domain work happens behind the SDKs. planner-api only decides the
// order and staples the results together.

const ARCHIVE_ERRORS: Record<string, string> = {
  zip_invalid: 'That file is not a readable ZIP archive.',
  zip_too_large: 'That archive is too large to import.',
  zip_entry_too_large: 'That archive contains an implausibly large file.',
  manifest_not_first:
    'That archive is missing its manifest, or the manifest is not the first entry.',
  manifest_invalid: 'The archive manifest is not valid JSON.',
}

// Ceiling on ticket bytes held while the archive streams. Comfortably under a
// Workers isolate's memory budget with room for the manifest and the SDK calls.
const MAX_BUFFERED_TICKET_BYTES = 48 * 1024 * 1024

function badArchive(code: keyof typeof ARCHIVE_ERRORS): ApiError {
  return new ApiError({ code, message: ARCHIVE_ERRORS[code]!, status: 400 })
}

export const dataImportRoutes = new Hono<HonoApp>().post(
  '/api/v1/ui/data-import',
  requireSession(),
  async (c) => {
    const actor = c.var.session!.userId
    const lists = c.var.services.listsClient
    const events = c.var.services.eventsClient

    const declaredLength = Number(c.req.header('content-length') ?? '')
    if (Number.isFinite(declaredLength) && declaredLength > PLANNER_IMPORT_MAX_BYTES) {
      throw badArchive('zip_too_large')
    }
    const body = c.req.raw.body
    if (!body) throw badArchive('zip_invalid')

    // The manifest arrives first; ticket blobs stream past afterwards and are
    // held until the events they belong to have been created.
    const state: {
      manifest: PlannerManifest | null
      /** Blob paths the manifest references, computed ONCE when the manifest
       *  lands — recomputing per entry would be O(entries × tickets). */
      claimed: Set<string>
      blobs: Map<string, Uint8Array>
      bufferedBytes: number
      unclaimed: number
      dropped: number
    } = {
      manifest: null,
      claimed: new Set(),
      blobs: new Map(),
      bufferedBytes: 0,
      unclaimed: 0,
      dropped: 0,
    }

    try {
      await streamUnzip(body as unknown as ReadableStream<Uint8Array>, {
        maxTotalBytes: PLANNER_IMPORT_MAX_BYTES,
        maxEntryBytes: PLANNER_IMPORT_MAX_ENTRY_BYTES,
        onEntry: (entry) => {
          if (!state.manifest) {
            if (entry.name !== PLANNER_MANIFEST_ENTRY) throw badArchive('manifest_not_first')
            state.manifest = parseManifest(entry.bytes)
            state.claimed = claimedBlobs(state.manifest)
            return
          }
          if (entry.name === PLANNER_MANIFEST_ENTRY) return
          if (!state.claimed.has(entry.name)) {
            // A blob the manifest never referenced. Ignored rather than fatal.
            state.unclaimed++
            return
          }
          // Tickets are re-uploaded only after their event exists, so unlike
          // the Health import (which streams each photo straight to R2) they
          // are held in memory. The per-entry cap alone is not enough — a
          // handful of near-cap entries would still exceed an isolate's
          // memory — so the total held is bounded too. Past the bound the
          // attachment is dropped and reported, never silently lost.
          if (state.bufferedBytes + entry.bytes.length > MAX_BUFFERED_TICKET_BYTES) {
            state.dropped++
            return
          }
          state.bufferedBytes += entry.bytes.length
          state.blobs.set(entry.name, entry.bytes)
        },
      })
    } catch (err) {
      if (err instanceof ApiError) throw err
      const code = err instanceof Error ? err.message : ''
      if (code in ARCHIVE_ERRORS) throw badArchive(code)
      throw err
    }

    const manifest = state.manifest
    if (!manifest) throw badArchive('manifest_not_first')

    const tally = new ImportTally()

    // --- lists --------------------------------------------------------
    // resolvePersonalScope provisions the personal group on first use, so an
    // import into a brand-new account works without any prior visit.
    const scopeId = await resolvePersonalScope(lists, actor)
    for (const bundle of manifest.lists) {
      try {
        const result = await lists.importListBundle(
          { scopeType: 'list_group', scopeId },
          bundle,
          actor,
        )
        tally.created('lists', result.listCreated ? 1 : 0)
        tally.skipped('lists', result.listCreated ? 0 : 1)
        tally.created('listItems', result.items.created)
        tally.skipped('listItems', result.items.skipped)
        tally.created('recurring', result.series.created)
        tally.skipped('recurring', result.series.skipped)
        // The remaining sections the Lists SDK reports. Folded in so the
        // summary accounts for everything the run actually wrote, rather than
        // silently under-reporting custom fields, statuses, labels and notes.
        tally.created('customFields', result.fieldDefs.created)
        tally.skipped('customFields', result.fieldDefs.skipped)
        tally.created('statuses', result.statuses.created)
        tally.skipped('statuses', result.statuses.skipped)
        tally.created('labels', result.labels.created)
        tally.skipped('labels', result.labels.skipped)
        tally.created('comments', result.comments.created)
        tally.skipped('comments', result.comments.skipped)
        for (const w of result.warnings) {
          tally.warn({ entity: 'lists', code: w.code, message: w.message, ...(w.ref ? { ref: w.ref } : {}) })
        }
      } catch (err) {
        c.var.logger.warn({ actor, list: bundle.name, error: String(err) }, 'planner_import_list_failed')
        tally.warn({
          entity: 'lists',
          code: 'list_failed',
          message: `"${bundle.name}" could not be restored.`,
        })
      }
    }

    // --- personal events + tickets -------------------------------------
    // PersonalEventDto carries no `ref`, so "was this already imported?" is
    // answered by whether createPersonalEvent — which is ref-idempotent and
    // replays the existing row — hands back an id that predates this run.
    const preExistingEventIds = new Set(
      (await events.listPersonalEvents({ actor })).map((e) => e.id),
    )
    for (const ev of manifest.events) {
      try {
        await importEvent(events, actor, ev, state.blobs, tally, preExistingEventIds)
      } catch (err) {
        c.var.logger.warn({ actor, event: ev.ref, error: String(err) }, 'planner_import_event_failed')
        tally.warn({
          entity: 'events',
          ref: ev.ref,
          code: 'event_failed',
          message: `"${ev.name}" could not be restored.`,
        })
      }
    }

    if (state.unclaimed) {
      c.var.logger.info({ actor, count: state.unclaimed }, 'planner_import_unclaimed_blobs')
    }
    if (state.dropped) {
      tally.warn({
        entity: 'eventTickets',
        code: 'attachments_too_large',
        message: `${state.dropped} attachment${state.dropped === 1 ? '' : 's'} were too large to restore in one go. Everything else was imported.`,
      })
    }

    return c.json(tally.summary(), 200)
  },
)

function parseManifest(bytes: Uint8Array): PlannerManifest {
  let json: unknown
  try {
    json = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw badArchive('manifest_invalid')
  }
  const parsed = plannerManifestSchema.safeParse(json)
  if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
  return parsed.data
}

/** Blob paths the manifest actually references, so an archive can't make us
 *  buffer entries nothing will ever use. */
function claimedBlobs(manifest: PlannerManifest): Set<string> {
  const out = new Set<string>()
  for (const ev of manifest.events) for (const t of ev.tickets) out.add(t.blob)
  return out
}

async function importEvent(
  events: ImportEventsClient,
  actor: string,
  ev: ExportedPlannerEvent,
  blobs: ReadonlyMap<string, Uint8Array>,
  tally: ImportTally,
  preExistingEventIds: ReadonlySet<string>,
): Promise<void> {
  // createPersonalEvent dedupes on (owner, ref) and replays the existing row,
  // so replaying the source id as the ref is what makes a second import a
  // no-op. It is always safe to call.
  const created = await events.createPersonalEvent({
    actor,
    name: ev.name,
    ref: ev.ref,
    ...(ev.description != null ? { description: ev.description } : {}),
    ...(ev.startAt != null ? { startAt: ev.startAt } : {}),
    ...(ev.endAt != null ? { endAt: ev.endAt } : {}),
    ...(ev.allDay != null ? { allDay: ev.allDay } : {}),
    ...(ev.locationLabel != null ? { locationLabel: ev.locationLabel } : {}),
    ...(ev.ticketPlatform != null ? { ticketPlatform: ev.ticketPlatform } : {}),
    ...(ev.ticketAccountEmail != null ? { ticketAccountEmail: ev.ticketAccountEmail } : {}),
  })

  if (preExistingEventIds.has(created.id)) tally.skipped('events')
  else tally.created('events')

  if (!ev.tickets.length) return

  // Tickets have no ref column, so they reconcile on the natural key an
  // attachment actually has: name + type + size. Without this a second import
  // would stack a duplicate copy of every attachment onto the same event.
  //
  // A content hash would be exact, but the already-stored side would have to
  // be downloaded to compute one. Two DIFFERENT attachments on the SAME event
  // sharing a filename, type and byte length would collapse into one — narrow
  // enough to accept given the cost of the alternative.
  const existingTickets = await events.listTickets({ actor, eventId: created.id }).catch(() => [])
  const seen = new Set(
    existingTickets.map((t) => `${t.fileName ?? ''}::${t.contentType}::${t.bytes}`),
  )

  for (const ticket of ev.tickets) {
    const key = `${ticket.fileName}::${ticket.contentType}::${ticket.bytes}`
    if (seen.has(key)) {
      tally.skipped('eventTickets')
      continue
    }
    const bytes = blobs.get(ticket.blob)
    if (!bytes || bytes.length === 0) {
      tally.warn({
        entity: 'eventTickets',
        ref: ev.ref,
        code: 'missing_blob',
        message: `The archive was missing the attachment "${ticket.fileName}".`,
      })
      continue
    }
    await events.uploadTicket({
      actor,
      eventId: created.id,
      file: new Blob([bytes], { type: ticket.contentType }),
      contentType: ticket.contentType,
      fileName: ticket.fileName,
    })
    seen.add(key)
    tally.created('eventTickets')
  }
}

/** The slice of the Events SDK an import needs. Narrowed so the import logic
 *  is testable against a small fake rather than the whole client. */
export interface ImportEventsClient {
  listPersonalEvents(opts: { actor: string }): Promise<{ id: string }[]>
  createPersonalEvent(
    opts: { actor: string } & CreatePersonalEventInput,
  ): Promise<{ id: string }>
  listTickets(opts: {
    actor: string
    eventId: string
  }): Promise<{ fileName: string | null; contentType: string; bytes: number }[]>
  uploadTicket(opts: {
    actor: string
    eventId: string
    file: Blob
    contentType: string
    fileName?: string | undefined
  }): Promise<unknown>
}

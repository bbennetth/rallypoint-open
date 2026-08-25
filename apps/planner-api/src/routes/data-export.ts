import { Hono } from 'hono'
import { createZipStream } from '@rallypoint/api-kit'
import type { ListBundle } from '@rallypoint/lists-shared'
import type { HonoApp } from '../context.js'
import { requireSession } from '../middleware/session.js'
import { listPersonalLists } from '../lib/personal-scope.js'
import {
  PLANNER_EXPORT_SCHEMA_VERSION,
  PLANNER_MANIFEST_ENTRY,
  ticketBlobPath,
  type ExportedPlannerEvent,
  type PlannerManifest,
} from '../lib/export-manifest.js'

// Whole-account Planner data export (backup–restore).
//
//   GET /api/v1/ui/data-export  →  application/zip
//
// Pure composition: every row comes from the Lists and Events SDKs, because
// planner-api owns no domain data. Lists go out as generic
// `exportListBundle` bundles; personal events and their ticket attachments
// come from the Events SDK.
//
// The response body streams — ticket bytes go events-api → zip → client one
// attachment at a time rather than buffering the archive.

export const dataExportRoutes = new Hono<HonoApp>().get(
  '/api/v1/ui/data-export',
  requireSession(),
  async (c) => {
    const actor = c.var.session!.userId
    const lists = c.var.services.listsClient
    const events = c.var.services.eventsClient

    const personalLists = await listPersonalLists(lists, actor)
    const bundles: ListBundle[] = []
    for (const list of personalLists) {
      // A list that vanished mid-export (or that the SDK refuses) is skipped
      // rather than failing the whole backup.
      const bundle = await lists.exportListBundle(list.id, actor).catch(() => null)
      if (bundle) bundles.push(bundle)
    }

    const personalEvents = await events.listPersonalEvents({ actor })
    const exportedEvents: ExportedPlannerEvent[] = []
    // eventId → the ticket rows to fetch, resolved before the manifest is
    // written so the manifest can only promise blobs that exist.
    const ticketFetches: { eventId: string; ticketId: string; blob: string }[] = []

    for (const ev of personalEvents) {
      const tickets = await events.listTickets({ actor, eventId: ev.id }).catch(() => [])
      const exportedTickets = tickets.map((t, i) => {
        // fileName is nullable on the DTO; fall back to a stable stand-in so
        // the archive entry still has a name the importer can match on.
        const fileName = t.fileName ?? `ticket-${i + 1}`
        const blob = ticketBlobPath(ev.id, i, fileName)
        ticketFetches.push({ eventId: ev.id, ticketId: t.id, blob })
        return { fileName, contentType: t.contentType, bytes: t.bytes, blob }
      })
      exportedEvents.push({
        ref: ev.id,
        name: ev.name,
        description: ev.description ?? null,
        startAt: ev.startAt ?? null,
        endAt: ev.endAt ?? null,
        allDay: ev.allDay ?? false,
        locationLabel: ev.locationLabel ?? null,
        ticketPlatform: ev.ticketPlatform ?? null,
        ticketAccountEmail: ev.ticketAccountEmail ?? null,
        tickets: exportedTickets,
      })
    }

    const manifest: PlannerManifest = {
      schemaVersion: PLANNER_EXPORT_SCHEMA_VERSION,
      app: 'planner',
      exportedAt: Date.now(),
      lists: bundles,
      events: exportedEvents,
    }

    const zip = createZipStream()
    // Produce into the stream while the response drains it. Not wrapped in
    // waitUntil: a Response whose body is still being written keeps the
    // request alive on its own, and executionCtx is unavailable under the
    // Hono test harness. Every failure is handled inside.
    void (async () => {
      try {
        await zip.addJson(PLANNER_MANIFEST_ENTRY, manifest)
        for (const t of ticketFetches) {
          const res = await events
            .downloadTicket({ actor, eventId: t.eventId, ticketId: t.ticketId })
            .catch(() => null)
          // The manifest already promised this entry, so write an empty one
          // rather than leave a dangling pointer.
          const bytes = res ? new Uint8Array(await res.arrayBuffer()) : new Uint8Array(0)
          await zip.addStored(t.blob, bytes)
        }
        await zip.finish()
      } catch (err) {
        c.var.logger.error({ actor, error: String(err) }, 'planner_data_export_failed')
        // Tear the stream down so the client gets a truncated archive its
        // unzip rejects, rather than a well-formed one missing data.
        await zip.abort(err).catch(() => undefined)
      }
    })()

    const date = new Date().toISOString().slice(0, 10)
    return new Response(zip.readable as unknown as BodyInit, {
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="planner-export-${date}.zip"`,
        'cache-control': 'no-store',
      },
    })
  },
)

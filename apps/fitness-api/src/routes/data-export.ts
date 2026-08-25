import { Hono } from 'hono'
import { createZipStream } from '@rallypoint/api-kit'
import { FITNESS_MANIFEST_ENTRY } from '@rallypoint/fitness-shared'
import type { ReadableStream as CfReadableStream } from '@cloudflare/workers-types'
import type { HonoApp } from '../context.js'
import { buildFitnessManifest, photoBlobPath } from '../lib/export-manifest.js'

// Whole-account data export (backup–restore).
//
//   GET /api/v1/ui/data-export  →  application/zip
//
// The archive is `manifest.json` followed by `blobs/<photoRef>.<ext>`. Nothing
// here is user-selectable: an export is everything the account owns, because a
// partial backup that silently omits a section is worse than no backup.
//
// The response body streams. Rows are read up front (they are small), but photo
// bytes go R2 → zip → client one object at a time, so an account with hundreds
// of photos never materialises its archive in Worker memory.

export const dataExportRoutes = new Hono<HonoApp>().get('/api/v1/ui/data-export', async (c) => {
  const userId = c.var.session!.userId
  const objectStore = c.var.services.objectStore
  const rows = await c.var.repos.dataTransfer.readAll(userId)

  // Which photos actually have bytes to ship. Checked before the manifest is
  // written because the manifest goes out first and has to tell the truth about
  // what follows it — a blob pointer with no entry behind it would strand the
  // importer. headObject is a metadata read, not a body read.
  const photoBlobRefs = new Set<string>()
  if (objectStore) {
    for (const photo of rows.progressPhotos) {
      const head = await objectStore.headObject(photo.objectKey).catch(() => null)
      if (head) photoBlobRefs.add(photo.ref ?? photo.id)
    }
  }

  const manifest = buildFitnessManifest(rows, { exportedAt: Date.now(), photoBlobRefs })
  const zip = createZipStream()

  // Produce into the stream while the response body drains it. Every write
  // awaits the writer, so a slow client throttles the R2 reads rather than
  // queueing the whole archive in memory.
  //
  // Deliberately NOT wrapped in waitUntil: returning a Response whose body is
  // still being written keeps the request alive until the stream closes, and
  // `c.executionCtx` is unavailable under Hono's app.request() test harness.
  // Every failure is handled inside, so the promise cannot reject unhandled.
  void (async () => {
    try {
      await zip.addJson(FITNESS_MANIFEST_ENTRY, manifest)
      if (objectStore) {
        for (const photo of rows.progressPhotos) {
          const ref = photo.ref ?? photo.id
          if (!photoBlobRefs.has(ref)) continue
          const object = await objectStore.get(photo.objectKey).catch(() => null)
          // The object was there for headObject and is gone now (or unreadable).
          // The manifest already promised this entry, so write an empty one
          // rather than leave a dangling pointer.
          const bytes = object
            ? new Uint8Array(await new Response(object.body as unknown as ReadableStream).arrayBuffer())
            : new Uint8Array(0)
          await zip.addStored(photoBlobPath(ref, photo.contentType), bytes)
        }
      }
      await zip.finish()
    } catch (err) {
      c.var.logger.error({ userId, error: String(err) }, 'data_export_failed')
      // Tear the stream down mid-flight: the client gets a truncated archive
      // its unzip will reject, which is the honest outcome. Headers are long
      // gone by now, so there is no status code left to change.
      await zip.abort(err).catch(() => undefined)
    }
  })()

  const date = new Date().toISOString().slice(0, 10)
  return new Response(zip.readable as unknown as CfReadableStream as BodyInit, {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="health-export-${date}.zip"`,
      // An export is a point-in-time snapshot of private data.
      'cache-control': 'no-store',
    },
  })
})

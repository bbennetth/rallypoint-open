import { Hono } from 'hono'
import { ulid } from 'ulid'
import { streamUnzip } from '@rallypoint/api-kit'
import {
  FITNESS_IMPORT_MAX_BYTES,
  FITNESS_IMPORT_MAX_ENTRY_BYTES,
  FITNESS_MANIFEST_ENTRY,
  fitnessManifestSchema,
  isProgressPhotoMimeType,
} from '@rallypoint/fitness-shared'
import type { Context } from 'hono'
import type { ObjectStore } from '@rallypoint/object-store'
import type { HonoApp } from '../context.js'
import { ApiError, errors } from '../errors.js'
import {
  catalogLookups,
  planFitnessImport,
  type ImportPlan,
  type PlannedPhoto,
} from '../lib/import-plan.js'
import { photoKeyFor } from '../lib/photo-keys.js'

// Whole-account data import (backup–restore).
//
//   POST /api/v1/ui/data-import   body: the exported ZIP
//
// Merge-with-dedupe: rows already present (by ref, or by the natural key their
// table already enforces) are skipped, so re-running the same archive is a
// no-op and a partial import is recovered by simply running it again. That
// matters because D1 has no transaction spanning the many batches an import
// issues — there is no all-or-nothing to fall back on.
//
// Structural failures (unreadable zip, manifest that fails validation,
// oversized body) reject before anything is written. Row-level failures (a
// catalog row that has since vanished, a blob that would not upload) are
// reported as warnings and the rest of the archive still lands.

type ImportContext = Context<HonoApp>

const ARCHIVE_ERRORS: Record<string, string> = {
  zip_invalid: 'That file is not a readable ZIP archive.',
  zip_too_large: 'That archive is too large to import.',
  zip_entry_too_large: 'That archive contains an implausibly large file.',
  manifest_not_first:
    'That archive is missing its manifest, or the manifest is not the first entry.',
  manifest_invalid: 'The archive manifest is not valid JSON.',
}

function badArchive(code: keyof typeof ARCHIVE_ERRORS): ApiError {
  return new ApiError({ code, message: ARCHIVE_ERRORS[code]!, status: 400 })
}

export const dataImportRoutes = new Hono<HonoApp>().post('/api/v1/ui/data-import', async (c) => {
  const userId = c.var.session!.userId
  const objectStore = c.var.services.objectStore

  const declaredLength = Number(c.req.header('content-length') ?? '')
  if (Number.isFinite(declaredLength) && declaredLength > FITNESS_IMPORT_MAX_BYTES) {
    throw badArchive('zip_too_large')
  }
  const body = c.req.raw.body
  if (!body) throw badArchive('zip_invalid')

  // Held in an object rather than a bare `let` so the streaming callback's
  // assignment is visible to the code after the stream drains.
  const state: {
    plan: ImportPlan | null
    pendingPhotos: Map<string, PlannedPhoto>
    photosWritten: number
    photoFailures: PlannedPhoto[]
    unclaimedBlobs: number
  } = { plan: null, pendingPhotos: new Map(), photosWritten: 0, photoFailures: [], unclaimedBlobs: 0 }

  try {
    await streamUnzip(body as unknown as ReadableStream<Uint8Array>, {
      maxTotalBytes: FITNESS_IMPORT_MAX_BYTES,
      maxEntryBytes: FITNESS_IMPORT_MAX_ENTRY_BYTES,
      onEntry: async (entry) => {
        // Manifest first: every later entry is matched against the plan it
        // produces, so an archive that leads with a blob is unusable.
        if (!state.plan) {
          if (entry.name !== FITNESS_MANIFEST_ENTRY) throw badArchive('manifest_not_first')
          state.plan = await planFromManifest(c, userId, entry.bytes)
          for (const photo of state.plan.photos) state.pendingPhotos.set(photo.blob, photo)
          return
        }
        if (entry.name === FITNESS_MANIFEST_ENTRY) return

        const photo = state.pendingPhotos.get(entry.name)
        if (!photo) {
          // A blob the manifest never claimed. Ignored rather than fatal — an
          // archive carrying an extra file is still importable.
          state.unclaimedBlobs++
          return
        }
        state.pendingPhotos.delete(entry.name)
        try {
          await writePhoto(c, userId, photo, entry.bytes, objectStore)
          state.photosWritten++
        } catch (err) {
          c.var.logger.warn({ userId, error: String(err) }, 'data_import_photo_failed')
          state.photoFailures.push(photo)
        }
      },
    })
  } catch (err) {
    if (err instanceof ApiError) throw err
    const code = err instanceof Error ? err.message : ''
    if (code in ARCHIVE_ERRORS) throw badArchive(code)
    throw err
  }

  const plan = state.plan
  if (!plan) throw badArchive('manifest_not_first')

  await c.var.repos.dataTransfer.insertAll(plan.rows)

  const summary = plan.summary()
  const photos = summary.counts['progressPhotos'] ?? { created: 0, skipped: 0 }
  photos.created += state.photosWritten
  summary.counts['progressPhotos'] = photos

  for (const failed of state.photoFailures) {
    summary.warnings.push({
      entity: 'progressPhotos',
      ref: failed.ref,
      code: 'photo_upload_failed',
      message: 'The image could not be stored, so the photo was skipped.',
    })
  }
  // Anything still pending was promised by the manifest and never arrived.
  for (const missing of state.pendingPhotos.values()) {
    summary.warnings.push({
      entity: 'progressPhotos',
      ref: missing.ref,
      code: 'missing_blob',
      message: 'The archive was missing this photo, so it was skipped.',
    })
  }
  if (state.unclaimedBlobs) {
    c.var.logger.info({ userId, count: state.unclaimedBlobs }, 'data_import_unclaimed_blobs')
  }

  return c.json(summary, 200)
})

async function planFromManifest(
  c: ImportContext,
  userId: string,
  bytes: Uint8Array,
): Promise<ImportPlan> {
  let json: unknown
  try {
    json = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw badArchive('manifest_invalid')
  }
  const parsed = fitnessManifestSchema.safeParse(json)
  if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
  const manifest = parsed.data

  // Resolve every catalog reference the manifest makes in a handful of batched
  // reads, so the planner itself stays pure and does no I/O.
  const lookups = catalogLookups(manifest)
  const repo = c.var.repos.dataTransfer
  const [existing, exerciseIds, muscleIds, foodItemIds, wodTemplateIds, foodIdsByUpc] =
    await Promise.all([
      repo.existingKeys(userId),
      repo.existingExerciseIds(lookups.exerciseIds),
      repo.existingMuscleIds(lookups.muscleIds),
      repo.existingFoodItemIds(lookups.foodItemIds),
      repo.existingWodTemplateIds(lookups.wodTemplateIds),
      repo.foodItemIdsByUpc(lookups.upcs),
    ])

  return planFitnessImport({
    userId,
    manifest,
    existing,
    catalog: { exerciseIds, muscleIds, foodItemIds, wodTemplateIds, foodIdsByUpc },
    newId: (prefix) => `${prefix}_${ulid()}`,
    now: new Date(),
  })
}

async function writePhoto(
  c: ImportContext,
  userId: string,
  photo: PlannedPhoto,
  bytes: Uint8Array,
  objectStore: ObjectStore | null | undefined,
): Promise<void> {
  if (!objectStore) throw new Error('object_store_unavailable')
  // The manifest is user-supplied; only the types the upload route accepts get
  // a key minted for them, so an import can't smuggle an arbitrary MIME type
  // into the bucket.
  if (!isProgressPhotoMimeType(photo.contentType)) throw new Error('unsupported_photo_type')

  const objectKey = photoKeyFor(userId, photo.newId, photo.contentType)
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer
  await objectStore.put(objectKey, buffer, { contentType: photo.contentType })
  try {
    // Same order the upload route uses: bytes first, row second, and reap the
    // object if the row fails — the row is the source of truth, so a stranded
    // object is the failure mode to avoid.
    await c.var.repos.dataTransfer.insertProgressPhoto({
      id: photo.newId,
      userId,
      setId: photo.setId,
      takenAt: photo.takenAt,
      pose: photo.pose,
      objectKey,
      contentType: photo.contentType,
      sizeBytes: bytes.length,
      note: photo.note,
      ref: photo.ref,
      createdAt: photo.createdAt ?? new Date(),
    })
  } catch (err) {
    await objectStore.deleteObject(objectKey).catch(() => undefined)
    throw err
  }
}

import { Hono } from 'hono'
import { ulid } from 'ulid'
import {
  KNOWN_POSES,
  PROGRESS_PHOTO_DEFAULT_LIMIT,
  PROGRESS_PHOTO_MAX_BYTES,
  isProgressPhotoMimeType,
  patchProgressPhotoSchema,
  progressPhotoUploadMetaSchema,
  validateProgressPhotoUpload,
  type ProgressPhotoDto,
} from '@rallypoint/fitness-shared'
import { matchesDeclaredType } from '@rallypoint/shared'
import { buildPage, paginationQuery } from '@rallypoint/api-kit'
import type { ObjectStore } from '@rallypoint/object-store'
import type { Context } from 'hono'
import type { HonoApp } from '../context.js'
import { ApiError, errors } from '../errors.js'
import type { ProgressPhotoRecord } from '../repos/types.js'
import { progressPhotoCursorCodec, type ProgressPhotoCursor } from '../lib/progress-photo-cursor.js'
import { photoKeyFor } from '../lib/photo-keys.js'
import { readJsonBody } from './_body.js'
import { parseDateRangeQuery } from './_query.js'

// clamp (not reject) preserves the pre-unification behavior: the old route
// ignored a non-positive/garbage `limit` and fell back to the default rather
// than 400ing a read. (An undecodable cursor is still a 400 — see below.)
const progressPhotosPageQuery = paginationQuery({
  defaultLimit: PROGRESS_PHOTO_DEFAULT_LIMIT,
  maxLimit: 200,
  mode: 'clamp',
})

// Body Stats progress pictures (cookie + CSRF + session gated in
// build-app). The browser POSTs the raw image bytes same-origin; the
// Worker validates type/size/magic-bytes inline and streams them into
// the private OBJECT_STORE bucket; serving streams the bytes back.
// No presigned URLs (money receipts / RPID avatar pattern). Every
// read/write is scoped to the actor's own rows.
//
//   POST   /api/v1/ui/progress-photos?pose=&takenAt=&note=  — raw image body
//   GET    /api/v1/ui/progress-photos?pose=&from=&to=&limit=&before=
//   GET    /api/v1/ui/progress-photos/poses                 — curated ∪ distinct
//   GET    /api/v1/ui/progress-photos/:id/image             — auth-gated stream
//   PATCH  /api/v1/ui/progress-photos/:id                   — pose/takenAt/note
//   DELETE /api/v1/ui/progress-photos/:id                   — row + best-effort reap

function unsupportedType(): ApiError {
  return new ApiError({
    code: 'unsupported_photo_type',
    message: 'The uploaded photo type is not allowed (JPEG, PNG, or WebP).',
    status: 400,
  })
}

// The OBJECT_STORE binding is optional (test bootstraps without R2);
// without it the photo surface is down, not the whole app.
function requireObjectStore(c: Context<HonoApp>): ObjectStore {
  const store = c.var.services.objectStore
  if (!store) {
    throw new ApiError({
      code: 'object_store_unavailable',
      message: 'Photo storage is not available.',
      status: 503,
    })
  }
  return store
}

// Strip any `; charset=…` parameter and lowercase — mirrors avatar.ts.
function declaredContentType(c: { req: { header(name: string): string | undefined } }): string {
  return (c.req.header('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
}

function toDto(r: ProgressPhotoRecord): ProgressPhotoDto {
  return {
    id: r.id,
    setId: r.setId,
    takenAt: r.takenAt.toISOString(),
    pose: r.pose,
    contentType: r.contentType,
    sizeBytes: r.sizeBytes,
    note: r.note,
    createdAt: r.createdAt.toISOString(),
  }
}

export const progressPhotosRoutes = new Hono<HonoApp>()
  // --- upload (single-request) ----------------------------------------
  // Raw image bytes in the body; pose/takenAt/note ride as query params
  // since there is no JSON envelope. takenAt defaults to now.
  .post('/api/v1/ui/progress-photos', async (c) => {
    const userId = c.var.session!.userId
    const objectStore = requireObjectStore(c)

    const url = new URL(c.req.url)
    const metaParsed = progressPhotoUploadMetaSchema.safeParse({
      pose: url.searchParams.get('pose') ?? undefined,
      takenAt: url.searchParams.get('takenAt') ?? undefined,
      note: url.searchParams.get('note') ?? undefined,
      setId: url.searchParams.get('setId') ?? undefined,
    })
    if (!metaParsed.success) throw errors.validation({ issues: metaParsed.error.issues })
    const meta = metaParsed.data

    const contentType = declaredContentType(c)
    if (!isProgressPhotoMimeType(contentType)) throw unsupportedType()

    // Reject a clearly oversize upload by declared length before buffering.
    const declaredLength = Number(c.req.header('content-length') ?? '')
    if (Number.isFinite(declaredLength) && declaredLength > PROGRESS_PHOTO_MAX_BYTES) {
      throw errors.imageTooLarge(PROGRESS_PHOTO_MAX_BYTES)
    }

    const bytes = await c.req.arrayBuffer()
    const check = validateProgressPhotoUpload({ contentType, contentLength: bytes.byteLength })
    if (!check.ok) {
      if (check.code === 'unsupported_photo_type') throw unsupportedType()
      throw errors.imageTooLarge(PROGRESS_PHOTO_MAX_BYTES)
    }

    // Magic-byte gate: reject polyglot files whose first bytes don't match
    // the declared Content-Type even if the MIME type itself is allowed.
    if (!matchesDeclaredType(new Uint8Array(bytes), contentType)) throw unsupportedType()

    const photoId = `fpp_${ulid()}`
    const objectKey = photoKeyFor(userId, photoId, contentType)
    await objectStore.put(objectKey, bytes, { contentType })

    let created: ProgressPhotoRecord
    try {
      // A multi-angle batch links its photos with a shared set id: the
      // first upload omits setId (we mint one, returned in the DTO) and
      // the rest pass it back. A lone upload is simply a set of one.
      const photoCreate: Parameters<typeof c.var.repos.progressPhotos.create>[0] = {
        id: photoId,
        userId,
        setId: meta.setId ?? `fps_${ulid()}`,
        takenAt: meta.takenAt ? new Date(meta.takenAt) : new Date(),
        pose: meta.pose,
        objectKey,
        contentType,
        sizeBytes: bytes.byteLength,
      }
      if (meta.note !== undefined) photoCreate.note = meta.note
      created = await c.var.repos.progressPhotos.create(photoCreate)
    } catch (err) {
      // The row is the source of truth — reap the just-written object so
      // a failed insert doesn't strand bytes in the bucket.
      await objectStore.deleteObject(objectKey).catch(() => undefined)
      throw err
    }

    return c.json(toDto(created), 201)
  })
  // --- list ------------------------------------------------------------
  .get('/api/v1/ui/progress-photos', async (c) => {
    const userId = c.var.session!.userId
    const url = new URL(c.req.url)

    const filter: Parameters<typeof c.var.repos.progressPhotos.listForActor>[1] =
      parseDateRangeQuery(url)
    const pose = url.searchParams.get('pose')
    if (pose) filter.pose = pose

    const parsed = progressPhotosPageQuery.safeParse({
      limit: url.searchParams.get('limit') ?? undefined,
      cursor: url.searchParams.get('cursor') ?? undefined,
    })
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const { limit } = parsed.data

    // "Load more" cursor. Prefer the opaque `cursor`; else accept the legacy
    // `before` (ISO takenAt) + `beforeId` param pair (both required together).
    // The id half tiebreaks equal-takenAt rows so same-second uploads aren't
    // skipped across a page boundary.
    let cursor: ProgressPhotoCursor | null = null
    if (parsed.data.cursor !== undefined) {
      cursor = progressPhotoCursorCodec.decode(parsed.data.cursor)
      if (cursor === null) {
        throw errors.validation({
          issues: [{ code: 'custom', path: ['cursor'], message: 'Invalid cursor.' }],
        })
      }
    } else {
      const beforeParam = url.searchParams.get('before')
      const beforeIdParam = url.searchParams.get('beforeId')
      if (beforeParam) {
        const d = new Date(beforeParam)
        if (isNaN(d.getTime()) || !beforeIdParam) {
          throw errors.validation({
            issues: [
              {
                code: 'custom',
                path: ['before'],
                message:
                  'Cursor params "before" (ISO-8601 date) and "beforeId" must be supplied together.',
              },
            ],
          })
        }
        cursor = { takenAt: d, id: beforeIdParam }
      }
    }
    if (cursor) filter.before = cursor
    // Over-fetch by one so a page that lands exactly on a limit boundary
    // doesn't emit a cursor to an empty next page.
    filter.limit = limit + 1

    const rows = await c.var.repos.progressPhotos.listForActor(userId, filter)
    const page = buildPage(rows, limit, progressPhotoCursorCodec, (r) => ({
      takenAt: r.takenAt,
      id: r.id,
    }))
    return c.json({
      items: page.items.map(toDto),
      next_cursor: page.nextCursor,
    })
  })
  // --- pose vocabulary (chip suggestions) ------------------------------
  // Curated defaults first (stable order), then the user's custom slugs.
  .get('/api/v1/ui/progress-photos/poses', async (c) => {
    const userId = c.var.session!.userId
    const distinct = await c.var.repos.progressPhotos.distinctPoses(userId)
    const curated = KNOWN_POSES.map((p) => p.id)
    const custom = distinct.filter((p) => !curated.includes(p))
    return c.json({ poses: [...curated, ...custom] })
  })
  // --- image serve ------------------------------------------------------
  // Auth-gated stream from the private bucket so the browser can
  // `<img src=…>` this route. The object is immutable per id, so a
  // longer private browser cache is safe.
  .get('/api/v1/ui/progress-photos/:id/image', async (c) => {
    const userId = c.var.session!.userId
    const objectStore = requireObjectStore(c)
    const photo = await c.var.repos.progressPhotos.getForActor(userId, c.req.param('id'))
    if (!photo) throw errors.notFound('Photo not found.')

    const obj = await objectStore.get(photo.objectKey)
    if (!obj) throw errors.notFound('Photo not found.')

    c.header('Content-Type', obj.contentType ?? photo.contentType)
    if (obj.contentLength !== null) c.header('Content-Length', String(obj.contentLength))
    c.header('Cache-Control', 'private, max-age=3600, immutable')
    return c.body(obj.body as unknown as ReadableStream)
  })
  // --- patch (metadata only — the bytes are immutable) ------------------
  .patch('/api/v1/ui/progress-photos/:id', async (c) => {
    const userId = c.var.session!.userId
    const parsed = patchProgressPhotoSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const body = parsed.data

    const fields: import('../repos/types.js').PatchProgressPhotoFields = {}
    if (body.pose !== undefined) fields.pose = body.pose
    if (body.takenAt !== undefined) fields.takenAt = new Date(body.takenAt)
    if ('note' in body) fields.note = body.note ?? null

    const updated = await c.var.repos.progressPhotos.update(userId, c.req.param('id'), fields)
    if (!updated) throw errors.notFound('Photo not found.')
    return c.json(toDto(updated))
  })
  // --- delete ------------------------------------------------------------
  // Row first (source of truth), then best-effort object reap — a
  // transient store outage doesn't block the user; orphans are
  // pruner-cleanable (same convention as money receipts).
  .delete('/api/v1/ui/progress-photos/:id', async (c) => {
    const userId = c.var.session!.userId
    const objectStore = requireObjectStore(c)
    const deleted = await c.var.repos.progressPhotos.delete(userId, c.req.param('id'))
    if (!deleted) throw errors.notFound('Photo not found.')

    try {
      await objectStore.deleteObject(deleted.objectKey)
    } catch (err) {
      c.var.logger.warn(
        { err, objectKey: deleted.objectKey },
        'progress photo object delete failed; row is gone, pruner will reclaim',
      )
    }
    return c.json({ ok: true })
  })

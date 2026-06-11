import { Hono } from 'hono'
import { ulid } from 'ulid'
import {
  AVATAR_MAX_BYTES,
  AVATAR_MIME_EXTENSIONS,
  isAvatarMimeType,
  validateAvatarUpload,
  matchesDeclaredType,
  type UserId,
} from '@rallypoint/shared'
import type { HonoApp } from '../context.js'
import { ApiError, errors } from '../errors.js'
import { requireSession } from '../middleware/session.js'
import { rateLimit } from '../middleware/rate-limit.js'
import { toUserInfo } from './auth/session.js'

// Avatar upload — native R2 binding (#409). The browser POSTs the image
// bytes same-origin to the Worker, which validates type/size inline and
// streams them into `env.OBJECT_STORE.put()`; serving streams the bytes
// back out. No presigned URLs, no cross-origin upload, no R2 keys — the
// bucket stays private.
//
//   POST   /api/v1/ui/me/avatar    — cookie+CSRF. Raw image body
//          (Content-Type: image/{png,jpeg,webp}). Validate, store,
//          persist avatar_key, reap the previous object.
//   DELETE /api/v1/ui/me/avatar    — cookie+CSRF. Clear avatar_key and
//          delete the object.
//   GET    /api/v1/avatars/:userId — PUBLIC (no session/CSRF). Stream the
//          stored bytes, or 404. CORP is relaxed to cross-origin in
//          build-app.ts so sibling web apps can <img> it.
//
// The publicly exposed picture URL is the stable serve route, computed in
// avatar-url.ts — the object key never leaves the server.

// Object keys are PII-free and reconstructed from trusted ids + a fresh
// ULID: avatars/<userId>/<ulid>.<ext>.
function avatarPrefix(userId: string): string {
  return `avatars/${userId}/`
}

function unsupportedType(): ApiError {
  return new ApiError({
    code: 'unsupported_image_type',
    message: 'The uploaded image type is not allowed.',
    status: 400,
  })
}

// Strip any `; charset=…` parameter and lowercase, so a browser-sent
// `image/png` matches regardless of decoration.
function declaredContentType(c: { req: { header(name: string): string | undefined } }): string {
  return (c.req.header('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
}

// Cookie + CSRF (global /api/v1/ui/* middleware) + session-gated avatar
// mutations. Shares the me-mutate rate-limit bucket budget via its own
// route id.
export const avatarUiRoutes = new Hono<HonoApp>()
  .use(
    '/api/v1/ui/me/avatar',
    rateLimit({ route: 'me-avatar', perIp: { limit: 20, windowSeconds: 10 * 60 } }),
  )
  // Single-request upload: validate the declared type, read the bytes
  // (capped), validate the actual size, store under a fresh key, persist
  // avatar_key, then best-effort reap the previous object.
  .post('/api/v1/ui/me/avatar', requireSession('cookie'), async (c) => {
    const userId = c.var.session!.userId
    const contentType = declaredContentType(c)
    if (!isAvatarMimeType(contentType)) throw unsupportedType()

    // Reject an oversize upload by its declared length before buffering,
    // when the header is present. The actual size is re-checked below.
    const declaredLength = Number(c.req.header('content-length') ?? '')
    if (Number.isFinite(declaredLength) && declaredLength > AVATAR_MAX_BYTES) {
      throw errors.validation({ field: 'contentLength' })
    }

    const bytes = await c.req.arrayBuffer()
    const check = validateAvatarUpload({ contentType, contentLength: bytes.byteLength })
    if (!check.ok) {
      if (check.code === 'unsupported_image_type') throw unsupportedType()
      throw errors.validation({ field: 'contentLength' })
    }

    // Magic-byte gate: reject polyglot files whose first bytes don't match
    // the declared Content-Type even if the MIME type itself is allowed.
    if (!matchesDeclaredType(new Uint8Array(bytes), contentType)) throw unsupportedType()

    const ext = AVATAR_MIME_EXTENSIONS[contentType]
    const objectKey = `${avatarPrefix(userId)}${ulid()}.${ext}`
    await c.var.services.objectStore.put(objectKey, bytes, { contentType })

    const existing = await c.var.repos.users.findById(userId as UserId)
    if (!existing) throw errors.sessionRequired()
    const previousKey = existing.avatarKey

    await c.var.repos.users.updateProfile(userId as UserId, { avatarKey: objectKey })

    // Reap the superseded object after the row points at the new one
    // (a missing-key delete is a no-op, so a missed reap is still cleanable).
    if (previousKey && previousKey !== objectKey) {
      await c.var.services.objectStore.deleteObject(previousKey).catch(() => undefined)
    }

    const fresh = await c.var.repos.users.findById(userId as UserId)
    if (!fresh) throw errors.sessionRequired()
    return c.json(toUserInfo(fresh, c.var.env.PUBLIC_BASE_URL), 200)
  })
  // Clear the avatar: drop avatar_key, best-effort reap the object.
  .delete('/api/v1/ui/me/avatar', requireSession('cookie'), async (c) => {
    const userId = c.var.session!.userId
    const existing = await c.var.repos.users.findById(userId as UserId)
    if (!existing) throw errors.sessionRequired()

    if (existing.avatarKey) {
      await c.var.repos.users.updateProfile(userId as UserId, { avatarKey: null })
      await c.var.services.objectStore.deleteObject(existing.avatarKey).catch(() => undefined)
    }

    const fresh = await c.var.repos.users.findById(userId as UserId)
    if (!fresh) throw errors.sessionRequired()
    return c.json(toUserInfo(fresh, c.var.env.PUBLIC_BASE_URL), 200)
  })

// Public avatar serve. Mounted OUTSIDE /api/v1/ui/* so it carries no
// session/CSRF requirement: any client just <img src=…>'s this URL. The
// Worker streams the stored bytes from the private bucket (no redirect).
// Returns 404 when the user has no avatar (low-sensitivity existence
// disclosure, flagged in the PR body).
export const avatarServeRoutes = new Hono<HonoApp>().get(
  '/api/v1/avatars/:userId',
  async (c) => {
    const userId = c.req.param('userId') as UserId
    const user = await c.var.repos.users.findById(userId)
    if (!user || !user.avatarKey) {
      throw new ApiError({ code: 'not_found', message: 'Avatar not found.', status: 404 })
    }
    const obj = await c.var.services.objectStore.get(user.avatarKey)
    if (!obj) {
      throw new ApiError({ code: 'not_found', message: 'Avatar not found.', status: 404 })
    }
    c.header('Content-Type', obj.contentType ?? 'application/octet-stream')
    if (obj.contentLength !== null) c.header('Content-Length', String(obj.contentLength))
    // Avatars are immutable per key (fresh ULID each upload); allow short
    // shared caching of the bytes.
    c.header('Cache-Control', 'public, max-age=300')
    return c.body(obj.body as unknown as ReadableStream)
  },
)

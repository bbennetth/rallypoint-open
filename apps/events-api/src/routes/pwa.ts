import { Hono } from 'hono'
import { ulid } from 'ulid'
import {
  APP_ICON_MAX_BYTES,
  APP_ICON_MIME_TYPES,
  PublicPageConfigSchema,
  isEventScopedObjectKey,
  validateAppIconUpload,
} from '@rallypoint/events-shared'
import {
  buildEventManifest,
  parseStartSurface,
  readAccentColor,
  readIconKey,
} from '../lib/pwa-manifest.js'
import { matchesDeclaredType } from '@rallypoint/shared'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import { loadForAction, recordActivity } from './_access.js'

// Per-event PWA install surface. Two public routes (manifest + icon)
// and two editor routes (upload + delete icon).
//
// WHY THE PUBLIC ROUTES DON'T USE THE public_page_config GATE that
// sdk-events.ts applies: the installed app targets the ATTENDEE
// surface, which exists for private and invite-only events too. Gating
// on `public_page_config.enabled` would mean only events with a public
// landing page could be installed — exactly backwards for a festival
// companion app. Instead the capability is the event id itself
// (`event_<ulid>`, unguessable), the same model the existing
// background-image serve route uses. What a holder of the id learns is
// the event name, accent colour, and icon — the same things they'd see
// on the attendee page they were invited to.
//
// Browsers fetch manifests and their icons WITHOUT credentials, so
// these cannot be session-gated: an authenticated route would break
// installation and show a broken icon on the home screen.

// Manifests must not be cached hard: an owner renaming the event or
// swapping the icon should be picked up on next launch. Same reasoning
// as the no-store on the OG-templated shell in public-html.ts.
const MANIFEST_CACHE_CONTROL = 'no-store'

// The icon object key changes on every replace, so the bytes at a given
// key are immutable and can be cached aggressively.
const ICON_CACHE_CONTROL = 'public, max-age=86400, stale-while-revalidate=604800'

const ICON_TYPE_MESSAGE = 'App icon must be a PNG.'

function iconObjectKey(eventId: string): string {
  return `events/${eventId}/app-icon/${ulid()}.png`
}

// Icon key is read via the shared structural reader (lib/pwa-manifest),
// NOT the zod parse used below for the accent colour: the icon backs the
// installed app, so one malformed unrelated config field must not strip
// every installed home-screen icon for the event. `readIconKey` also
// skips the `enabled` gate — the installed app is independent of whether
// a public landing page is switched on.
const storedIconKey = readIconKey
const storedAccentColor = readAccentColor

// Merge a theme patch into the persisted config, preserving every other
// field. The config may be absent entirely (event never had a public
// page); `enabled` defaults to false so writing an icon does NOT
// silently publish the event's landing page.
function withIconKey(raw: unknown, iconKey: string | null): unknown {
  const parsed = PublicPageConfigSchema.safeParse(raw)
  const current = parsed.success ? parsed.data : { enabled: false }
  const theme = { ...(current.theme ?? {}) }
  if (iconKey === null) delete theme.icon_image_key
  else theme.icon_image_key = iconKey
  return { ...current, theme }
}

export const pwaRoutes = new Hono<HonoApp>()
  // --- per-event web app manifest (public) ---------------------------
  // GET /api/v1/sdk/events/:eventId/manifest.webmanifest?start=solo
  //                                                     ?start=group:<id>
  .get('/api/v1/sdk/events/:eventId/manifest.webmanifest', async (c) => {
    const eventId = c.req.param('eventId')
    const event = await c.var.repos.events.findById(eventId)
    if (!event || event.deletedAt) throw errors.notFound('Event not found.')

    let surface = parseStartSurface(c.req.query('start'))
    // Never emit a group path we haven't confirmed belongs to this
    // event: the group id arrives as caller input, and start_url lands
    // in the installed app. An unknown or foreign group degrades to the
    // solo surface rather than 404 — the install still works.
    if (surface.kind === 'group') {
      const group = await c.var.repos.groups.findById(surface.groupId)
      if (!group || group.eventId !== event.id) surface = { kind: 'solo' }
    }

    const origin = new URL(c.req.url).origin
    // Same event-scope check as the serve route below, so the manifest
    // never advertises an icon URL the serve route will refuse.
    const manifestIconKey = storedIconKey(event.publicPageConfig)
    const iconUrl =
      manifestIconKey && isEventScopedObjectKey(manifestIconKey, event.id)
        ? `${origin}/api/v1/sdk/events/${event.id}/app-icon`
        : null

    const manifest = buildEventManifest({
      eventId: event.id,
      slug: event.slug,
      name: event.name,
      accentColor: storedAccentColor(event.publicPageConfig),
      iconUrl,
      surface,
    })

    c.header('Content-Type', 'application/manifest+json; charset=utf-8')
    c.header('Cache-Control', MANIFEST_CACHE_CONTROL)
    return c.body(JSON.stringify(manifest))
  })

  // --- per-event app icon bytes (public) -----------------------------
  // Streams from the private R2 bucket through the Worker, same shape
  // as the background-image route in sdk-events.ts.
  .get('/api/v1/sdk/events/:eventId/app-icon', async (c) => {
    const event = await c.var.repos.events.findById(c.req.param('eventId'))
    if (!event || event.deletedAt) throw errors.notFound('Event not found.')
    const key = storedIconKey(event.publicPageConfig)
    if (!key) throw errors.notFound('No app icon.')
    // Uploads generate `events/<eventId>/app-icon/…` keys, but the key
    // can also arrive client-supplied via the events PATCH route —
    // refuse anything outside this event's namespace or this public
    // route becomes an arbitrary R2 read (audit 1.1).
    if (!isEventScopedObjectKey(key, event.id)) {
      throw errors.notFound('No app icon.')
    }
    const obj = await c.var.services.objectStore.get(key)
    if (!obj) throw errors.notFound('App icon not found.')
    c.header('Content-Type', obj.contentType ?? 'image/png')
    if (obj.contentLength !== null) c.header('Content-Length', String(obj.contentLength))
    c.header('Cache-Control', ICON_CACHE_CONTROL)
    return c.body(obj.body as unknown as ReadableStream)
  })

  // --- upload the app icon (editor) ----------------------------------
  // Single-request multipart upload, same shape as the map upload in
  // routes/maps.ts: the Worker validates type/size inline and streams
  // the bytes into R2 via the binding. No presign, no cross-origin PUT.
  .post('/api/v1/ui/events/:id/app-icon', async (c) => {
    const { event } = await loadForAction(c, c.req.param('id'), 'editor')

    // Reject an over-cap body by its declared length before buffering the
    // whole multipart payload. file.size is still validated precisely
    // after the parse below. 16 KB of headroom covers the multipart
    // envelope (boundaries + the small text fields).
    const declaredLength = Number(c.req.header('content-length') ?? '')
    if (Number.isFinite(declaredLength) && declaredLength > APP_ICON_MAX_BYTES + 16 * 1024) {
      throw errors.imageTooLarge({ field: 'contentLength' })
    }

    const formData = await c.req.formData()
    // Same FormData type-merge quirk as maps.ts: the global FormData
    // declaration drops File from get()'s return type. Widen it back.
    const file = formData.get('file') as File | string | null
    if (!(file instanceof File)) {
      throw errors.validation({ issues: [{ path: ['file'], message: 'file is required.' }] })
    }

    const contentType = (file.type ?? '').split(';')[0]!.trim().toLowerCase()
    if (!(APP_ICON_MIME_TYPES as readonly string[]).includes(contentType)) {
      throw errors.unsupportedImageType(ICON_TYPE_MESSAGE)
    }

    const check = validateAppIconUpload({ contentType, contentLength: file.size })
    if (!check.ok) {
      if (check.code === 'unsupported_image_type') throw errors.unsupportedImageType(ICON_TYPE_MESSAGE)
      throw errors.imageTooLarge({ field: 'contentLength' })
    }

    const bytes = await file.arrayBuffer()
    // Magic-byte gate: reject a polyglot whose leading bytes don't match
    // the declared type even when that type is on the allowlist.
    if (!matchesDeclaredType(new Uint8Array(bytes), contentType)) {
      throw errors.unsupportedImageType(ICON_TYPE_MESSAGE)
    }

    const previousKey = storedIconKey(event.publicPageConfig)
    const objectKey = iconObjectKey(event.id)
    await c.var.services.objectStore.put(objectKey, bytes, { contentType })

    try {
      await c.var.repos.events.patch(event.id, {
        publicPageConfig: withIconKey(event.publicPageConfig, objectKey),
      })
    } catch (err) {
      // Bytes are in R2 but nothing references them — reap the orphan so
      // the pruner (which only walks referenced keys) can't miss it.
      await c.var.services.objectStore.deleteObject(objectKey).catch(() => undefined)
      throw err
    }

    // Best-effort cleanup of the replaced object. A failure here leaks
    // one object; it must not fail the request now that the new key is
    // the persisted one.
    if (previousKey && previousKey !== objectKey) {
      await c.var.services.objectStore.deleteObject(previousKey).catch(() => undefined)
    }

    await recordActivity(c, event.id, 'event.app_icon_uploaded', { bytes: file.size })
    const origin = new URL(c.req.url).origin
    return c.json({ icon_url: `${origin}/api/v1/sdk/events/${event.id}/app-icon` }, 201)
  })

  // --- remove the app icon (editor) ----------------------------------
  // Idempotent: clearing an already-absent icon is a 204, not a 404.
  .delete('/api/v1/ui/events/:id/app-icon', async (c) => {
    const { event } = await loadForAction(c, c.req.param('id'), 'editor')
    const key = storedIconKey(event.publicPageConfig)
    if (key) {
      await c.var.repos.events.patch(event.id, {
        publicPageConfig: withIconKey(event.publicPageConfig, null),
      })
      await c.var.services.objectStore.deleteObject(key).catch(() => undefined)
      await recordActivity(c, event.id, 'event.app_icon_deleted', {})
    }
    return c.body(null, 204)
  })

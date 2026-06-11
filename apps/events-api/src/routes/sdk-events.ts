import { Hono } from 'hono'
import type { Context } from 'hono'
import {
  PublicPageConfigSchema,
  type PublicPageConfig,
} from '@rallypoint/events-shared'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import type {
  ArtistRecord,
  DayRecord,
  EventArtistRecord,
  EventRecord,
  MapRecord,
  SessionRecord,
  StageRecord,
} from '../repos/types.js'

// The /api/v1/sdk/events surface is **truly public** (no auth, no key,
// no origin allowlist, no CSRF). It populates the public event landing
// page rendered by events-web at /e/:slug. Caller authorization is
// not required — the gating is *content-side*: returns 404 unless the
// event's `public_page_config.enabled === true` AND `privacy_mode ≠
// 'private'`.
//
// Returns flat camelCase DTOs (consistent with the other SDK surfaces).
// Cache-Control on every 200 so CDNs can fan-out reads. Realtime
// invalidation on the editor PATCH still covers in-app live viewers.

const TENANT = 'rallypoint'

const CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=300'

function applyHidden(
  hidden: readonly string[],
  key: 'description' | 'dates' | 'location_label',
): boolean {
  return hidden.includes(key)
}

// Resolve and validate the persisted jsonb. Owners can technically
// store anything via direct DB writes; on the SDK surface we re-parse
// so a malformed config returns 404 (i.e. acts as if disabled) rather
// than 500 or leaking a partial render.
function resolveConfig(raw: unknown): PublicPageConfig | null {
  const parsed = PublicPageConfigSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

// Gate the event: returns the parsed config if the page should render.
// Throws `eventNotFound` for missing/deleted/private/disabled so the
// route returns 404 — never leak whether the event exists or is just
// invite-only / disabled.
function gate(event: EventRecord | null): PublicPageConfig {
  if (!event || event.deletedAt) throw errors.eventNotFound()
  if (event.privacyMode === 'private') throw errors.eventNotFound()
  const config = resolveConfig(event.publicPageConfig)
  if (!config || !config.enabled) throw errors.eventNotFound()
  return config
}

function setCacheHeaders(c: Context<HonoApp>): void {
  c.header('Cache-Control', CACHE_CONTROL)
}

interface SerializeOpts {
  event: EventRecord
  config: PublicPageConfig
  mapPresigns: Record<string, string> // layer → serve-route URL
  backgroundImageUrl: string | null
}

function serializePublicEventDto(opts: SerializeOpts): Record<string, unknown> {
  const { event, config, mapPresigns, backgroundImageUrl } = opts
  const hidden = config.hidden_fields ?? []

  const sections = (config.sections ?? []).map((s) => {
    if (s.kind === 'map') {
      return {
        kind: 'map' as const,
        layer: s.layer,
        imageUrl: mapPresigns[s.layer] ?? null,
      }
    }
    if (s.kind === 'rsvp_link') {
      return { kind: 'rsvp_link' as const, url: s.url }
    }
    if (s.kind === 'lineup') {
      return s.limit_to_tier
        ? { kind: 'lineup' as const, limitToTier: s.limit_to_tier }
        : { kind: 'lineup' as const }
    }
    if (s.kind === 'sessions') {
      return s.day_id
        ? { kind: 'sessions' as const, dayId: s.day_id }
        : { kind: 'sessions' as const }
    }
    return { kind: s.kind }
  })

  return {
    id: event.id,
    slug: event.slug,
    name: event.name,
    description: applyHidden(hidden, 'description') ? null : event.description,
    startDate: applyHidden(hidden, 'dates') ? null : event.startDate,
    endDate: applyHidden(hidden, 'dates') ? null : event.endDate,
    timezone: event.timezone,
    locationLabel: applyHidden(hidden, 'location_label') ? null : event.locationLabel,
    theme: {
      accentColor: config.theme?.accent_color ?? null,
      backgroundImageUrl,
    },
    sections,
    privacyMode: event.privacyMode,
  }
}

function serializeArtistDto(a: ArtistRecord): Record<string, unknown> {
  return {
    id: a.id,
    name: a.name,
    spotify: a.spotify,
    soundcloud: a.soundcloud,
    appleMusic: a.appleMusic,
    youtubeMusic: a.youtubeMusic,
    instagram: a.instagram,
  }
}

function serializeStageDto(s: StageRecord): Record<string, unknown> {
  return {
    id: s.id,
    eventId: s.eventId,
    name: s.name,
    sortOrder: s.sortOrder,
  }
}

function serializeDayDto(d: DayRecord): Record<string, unknown> {
  return {
    id: d.id,
    eventId: d.eventId,
    dayLabel: d.dayLabel,
    date: d.date,
    // The day's own optional window ('HH:MM' or null; both null = all-day).
    startTime: d.startTime,
    endTime: d.endTime,
    sortOrder: d.sortOrder,
  }
}

function serializeEventArtistDto(ea: EventArtistRecord): Record<string, unknown> {
  return {
    eventId: ea.eventId,
    artistId: ea.artistId,
    dayId: ea.dayId,
    stageId: ea.stageId,
    tier: ea.tier,
    genre: ea.genre,
    startTime: ea.startTime,
    endTime: ea.endTime,
    displayName: ea.displayName,
  }
}

function serializeSessionDto(s: SessionRecord): Record<string, unknown> {
  return {
    id: s.id,
    eventId: s.eventId,
    title: s.title,
    description: s.description,
    dayId: s.dayId,
    startTime: s.startTime,
    endTime: s.endTime,
    category: s.category,
    location: s.location,
    host: s.host,
  }
}

export const sdkEventsRoutes = new Hono<HonoApp>()
  // --- public event page data ----------------------------------------
  // The CSR client at /e/:slug calls this on mount. One round-trip
  // returns the event shell + theme + section spec; lineup/sessions
  // are fetched lazily by section.
  .get('/api/v1/sdk/events/:slug', async (c) => {
    const event = await c.var.repos.events.findBySlug(TENANT, c.req.param('slug'))
    const config = gate(event)
    setCacheHeaders(c)

    // Resolve background image (theme override) + per-layer map images
    // that any {kind:'map'} sections will render. Images are served through
    // the Worker (R2 binding, #409) via public serve routes on this API —
    // no presigned URLs. The JSON field names are kept stable so existing
    // SDK consumers need no client-side changes.
    const origin = new URL(c.req.url).origin
    let backgroundImageUrl: string | null = null
    if (config.theme?.background_image_key) {
      // Public background-image serve route (below) applies the same
      // public-page-config gate before streaming bytes from R2.
      backgroundImageUrl = `${origin}/api/v1/sdk/events/${event!.id}/background-image`
    }

    const mapPresigns: Record<string, string> = {}
    const mapSections = (config.sections ?? []).filter(
      (s): s is Extract<typeof s, { kind: 'map' }> => s.kind === 'map',
    )
    if (mapSections.length > 0) {
      const maps = await c.var.repos.maps.listForEvent(event!.id)
      const byLayer: Record<string, MapRecord> = {}
      for (const m of maps) byLayer[m.layer] = m
      for (const section of mapSections) {
        const m = byLayer[section.layer]
        if (m) {
          // Public map image serve route (below) applies the same gate.
          mapPresigns[section.layer] = `${origin}/api/v1/sdk/events/${event!.id}/maps/${m.id}/image`
        }
      }
    }

    return c.json(
      serializePublicEventDto({
        event: event!,
        config,
        mapPresigns,
        backgroundImageUrl,
      }),
    )
  })

  // --- public event lineup -------------------------------------------
  // Returns the flat shape (stages + days + artists + eventArtists)
  // and the client cross-joins. `limit_to_tier` from the section spec
  // is honoured by the client in V1.
  .get('/api/v1/sdk/events/:slug/lineup', async (c) => {
    const event = await c.var.repos.events.findBySlug(TENANT, c.req.param('slug'))
    gate(event)
    setCacheHeaders(c)

    const [stages, days, eventArtists] = await Promise.all([
      c.var.repos.stages.listForEvent(event!.id),
      c.var.repos.days.listForEvent(event!.id),
      c.var.repos.eventArtists.listForEvent(event!.id),
    ])
    // Look up the unique artist ids referenced. Small N in practice
    // (one event's lineup) so per-id fetch is fine.
    const artistIds = Array.from(new Set(eventArtists.map((ea) => ea.artistId)))
    const artists: ArtistRecord[] = []
    for (const id of artistIds) {
      const a = await c.var.repos.artists.findById(id)
      if (a) artists.push(a)
    }

    return c.json({
      stages: stages.map(serializeStageDto),
      days: days.map(serializeDayDto),
      artists: artists.map(serializeArtistDto),
      eventArtists: eventArtists.map(serializeEventArtistDto),
    })
  })

  // --- public event sessions -----------------------------------------
  // Approved sessions only. Optional ?day_id= narrows the feed.
  .get('/api/v1/sdk/events/:slug/sessions', async (c) => {
    const event = await c.var.repos.events.findBySlug(TENANT, c.req.param('slug'))
    gate(event)
    setCacheHeaders(c)

    const dayId = c.req.query('day_id')
    const sessions = await c.var.repos.eventSessions.listForEvent(event!.id, {
      approvalStatus: 'approved',
      ...(dayId !== undefined ? { dayId } : {}),
    })
    return c.json({ items: sessions.map(serializeSessionDto) })
  })

  // --- public image serve routes (#409) ------------------------------
  // These are TRUE public routes (no auth, no key) gated only by the
  // public-page-config check (same as `gate()` above). They allow the
  // events-web SPA and social-media crawlers to fetch map/background
  // images directly from the private R2 bucket through the Worker.
  //
  // Keyed by event id (not slug) so public-html.ts can build the URL
  // without an extra slug→id lookup. The gate() call re-validates
  // public-page-config so images disappear as soon as the page is
  // disabled — the same guarantee the SDK JSON route has.

  // Stream a specific map image for a public event.
  .get('/api/v1/sdk/events/:eventId/maps/:mapId/image', async (c) => {
    const event = await c.var.repos.events.findById(c.req.param('eventId'))
    gate(event)
    const mapId = c.req.param('mapId')
    const map = await c.var.repos.maps.findById(mapId)
    if (!map || map.eventId !== event!.id) {
      throw errors.notFound('Map not found.')
    }
    const obj = await c.var.services.objectStore.get(map.objectKey)
    if (!obj) throw errors.notFound('Map image not found.')
    c.header('Content-Type', obj.contentType ?? 'application/octet-stream')
    if (obj.contentLength !== null) c.header('Content-Length', String(obj.contentLength))
    c.header('Cache-Control', CACHE_CONTROL)
    return c.body(obj.body as unknown as ReadableStream)
  })

  // Stream the theme background image for a public event. The object
  // key is stored in `public_page_config.theme.background_image_key`.
  .get('/api/v1/sdk/events/:eventId/background-image', async (c) => {
    const event = await c.var.repos.events.findById(c.req.param('eventId'))
    const config = gate(event)
    const key = config.theme?.background_image_key
    if (!key) throw errors.notFound('No background image.')
    const obj = await c.var.services.objectStore.get(key)
    if (!obj) throw errors.notFound('Background image not found.')
    c.header('Content-Type', obj.contentType ?? 'application/octet-stream')
    if (obj.contentLength !== null) c.header('Content-Length', String(obj.contentLength))
    c.header('Cache-Control', CACHE_CONTROL)
    return c.body(obj.body as unknown as ReadableStream)
  })

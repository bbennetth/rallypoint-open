import { Hono } from 'hono'
import type { Context } from 'hono'
import { ulid } from 'ulid'
import {
  CreatePoiSchema,
  CreateZoneSchema,
  PatchPoiSchema,
  PatchZoneSchema,
  MAP_MIME_EXTENSIONS,
  MAP_MIME_TYPES,
  validateMapDimensions,
  validateMapUpload,
  type MapMimeType,
} from '@rallypoint/events-shared'
import { matchesDeclaredType } from '@rallypoint/shared'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import { UniqueConstraintError } from '../repos/errors.js'
import type { MapRecord, PoiRecord, ZoneRecord } from '../repos/types.js'
import { readJsonBody } from './_body.js'
import { loadForAction, recordActivity } from './_access.js'
import { publish } from '../realtime/publish.js'
import { eventChannel, envelope } from '../realtime/channels.js'

// Object keys are opaque + PII-free: event-maps/<eventId>/<mapId>.<ext>.
// Reconstructed server-side from trusted ids + the declared mime's
// extension — never accepted from the client (design §3.8).
function objectKeyFor(eventId: string, mapId: string, contentType: MapMimeType): string {
  return `event-maps/${eventId}/${mapId}.${MAP_MIME_EXTENSIONS[contentType]}`
}

// Editor response includes object_key so the editor client can pass it
// back in bind requests and debug uploads. Viewer response omits it —
// the bucket is private and the key itself isn't needed client-side
// for rendering (images are served via the /image redirect, not direct
// object storage access). Avoids bucket-path enumeration from the
// viewer-gated GET /maps endpoint.
function serializeMap(m: MapRecord, opts: { includeObjectKey: boolean } = { includeObjectKey: true }): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: m.id,
    event_id: m.eventId,
    layer: m.layer,
    content_type: m.contentType,
    bytes: m.bytes,
    width_px: m.widthPx,
    height_px: m.heightPx,
    uploaded_by_user_id: m.uploadedByUserId,
    uploaded_at: m.uploadedAt.toISOString(),
  }
  if (opts.includeObjectKey) {
    base.object_key = m.objectKey
  }
  return base
}

function serializePoi(p: PoiRecord): Record<string, unknown> {
  return {
    id: p.id,
    event_id: p.eventId,
    map_id: p.mapId,
    category_id: p.categoryId,
    name: p.name,
    description: p.description,
    x_pct: p.xPct,
    y_pct: p.yPct,
    lat: p.lat,
    lng: p.lng,
    sort_order: p.sortOrder,
    created_at: p.createdAt.toISOString(),
    updated_at: p.updatedAt.toISOString(),
  }
}

function serializeZone(z: ZoneRecord): Record<string, unknown> {
  return { id: z.id, event_id: z.eventId, map_id: z.mapId, polygon: z.polygon }
}

// Fire-and-forget invalidation on the event channel: maps, POIs, and no-go
// zones all render on the event map, so any change tells subscribers to
// refetch. authorId suppresses the actor's own echo.
// (Phase 4: was mapChannel; collapsed into eventChannel.)
function publishMap(
  c: Context<HonoApp>,
  eventId: string,
  resource: string,
  operation: 'create' | 'update' | 'delete',
  id: string,
): void {
  publish(c, eventChannel(eventId), envelope(resource, operation, id, c.var.session!.userId))
}

export const mapsRoutes = new Hono<HonoApp>()
  // --- maps --------------------------------------------------------
  // Single-request upload (#409). The browser POSTs multipart/form-data
  // same-origin to the Worker; the Worker validates type/size/dimensions
  // inline and streams the bytes into `env.OBJECT_STORE` via the R2
  // binding. No presigned URL, no cross-origin PUT, no two-step
  // presign+bind. Fields: `file` (the image binary), `layer`, `widthPx`,
  // `heightPx`. The file field carries the declared Content-Type.
  .post('/api/v1/ui/events/:id/maps', async (c) => {
    const { event } = await loadForAction(c, c.req.param('id'), 'editor')

    const formData = await c.req.formData()
    const file = formData.get('file')
    const layer = formData.get('layer')
    const widthPxRaw = formData.get('widthPx')
    const heightPxRaw = formData.get('heightPx')

    if (!(file instanceof File)) throw errors.validation({ issues: [{ path: ['file'], message: 'file is required.' }] })
    if (typeof layer !== 'string' || !['site', 'camp', 'full'].includes(layer)) {
      throw errors.validation({ issues: [{ path: ['layer'], message: 'layer must be site, camp, or full.' }] })
    }
    const widthPx = Number(widthPxRaw)
    const heightPx = Number(heightPxRaw)
    if (!Number.isInteger(widthPx) || widthPx <= 0) {
      throw errors.validation({ issues: [{ path: ['widthPx'], message: 'widthPx must be a positive integer.' }] })
    }
    if (!Number.isInteger(heightPx) || heightPx <= 0) {
      throw errors.validation({ issues: [{ path: ['heightPx'], message: 'heightPx must be a positive integer.' }] })
    }

    // Strip charset decoration and lowercase the MIME type.
    const contentType = (file.type ?? '').split(';')[0]!.trim().toLowerCase() as MapMimeType
    if (!(MAP_MIME_TYPES as readonly string[]).includes(contentType)) {
      throw errors.unsupportedImageType()
    }

    const check = validateMapUpload({ contentType, contentLength: file.size })
    if (!check.ok) {
      if (check.code === 'unsupported_image_type') throw errors.unsupportedImageType()
      throw errors.imageTooLarge({ field: 'contentLength' })
    }

    const dims = validateMapDimensions({ widthPx, heightPx })
    if (!dims.ok) {
      if (dims.code === 'image_too_small') throw errors.imageTooSmall({ dimension: dims.dimension })
      throw errors.imageTooLarge({ dimension: dims.dimension })
    }

    const bytes = await file.arrayBuffer()

    // Magic-byte gate: reject polyglot files whose first bytes don't match
    // the declared Content-Type even if the MIME type itself is allowed.
    if (!matchesDeclaredType(new Uint8Array(bytes), contentType)) {
      throw errors.unsupportedImageType()
    }

    const mapId = `emp_${ulid()}`
    const objectKey = objectKeyFor(event.id, mapId, contentType)
    await c.var.services.objectStore.put(objectKey, bytes, { contentType })

    try {
      const map = await c.var.repos.maps.create({
        id: mapId,
        eventId: event.id,
        layer,
        objectKey,
        contentType,
        bytes: file.size,
        widthPx,
        heightPx,
        uploadedByUserId: c.var.session!.userId,
      })
      await recordActivity(c, event.id, 'event.map_uploaded', { map_id: map.id, layer: map.layer })
      publishMap(c, event.id, 'maps', 'create', map.id)
      return c.json(serializeMap(map), 201)
    } catch (err) {
      // The bytes are already in R2 but no row will reference them — reap
      // the orphan so a (layer)-clash retry doesn't leak objects the
      // pruner (which only walks existing rows) would never find.
      await c.var.services.objectStore.deleteObject(objectKey).catch(() => undefined)
      if (err instanceof UniqueConstraintError) {
        throw errors.conflict('map_layer_taken', 'A map for that layer already exists.')
      }
      throw err
    }
  })
  .get('/api/v1/ui/events/:id/maps', async (c) => {
    const { event } = await loadForAction(c, c.req.param('id'), 'viewer')
    const maps = await c.var.repos.maps.listForEvent(event.id)
    return c.json({ items: maps.map((m) => serializeMap(m, { includeObjectKey: false })) })
  })
  // Stream the stored image bytes through the Worker (#409). The bucket
  // is private — bytes never leave except through this authenticated route.
  // Sets Content-Type, Content-Length, and a short immutable-ish cache
  // (map keys are stable per-row; a replacement creates a new row + key).
  .get('/api/v1/ui/events/:id/maps/:mapId/image', async (c) => {
    const { event } = await loadForAction(c, c.req.param('id'), 'viewer')
    const map = await c.var.repos.maps.findById(c.req.param('mapId'))
    if (!map || map.eventId !== event.id) throw errors.notFound('Map not found.')
    const obj = await c.var.services.objectStore.get(map.objectKey)
    if (!obj) throw errors.notFound('Map image not found.')
    c.header('Content-Type', obj.contentType ?? 'application/octet-stream')
    if (obj.contentLength !== null) c.header('Content-Length', String(obj.contentLength))
    // Viewer-gated content — keep it out of shared/CDN caches so a cached
    // 200 can't be served to a later unauthenticated request.
    c.header('Cache-Control', 'private, max-age=300')
    return c.body(obj.body as unknown as ReadableStream)
  })
  .delete('/api/v1/ui/events/:id/maps/:mapId', async (c) => {
    const { event } = await loadForAction(c, c.req.param('id'), 'editor')
    const map = await c.var.repos.maps.findById(c.req.param('mapId'))
    if (!map || map.eventId !== event.id) throw errors.notFound('Map not found.')
    // Reap bytes before the row (design §5.1.1 order). A 404 is a no-op,
    // so a failed earlier delete that left the row is still cleanable.
    await c.var.services.objectStore.deleteObject(map.objectKey)
    // POIs SET NULL, zones CASCADE via FK.
    await c.var.repos.maps.delete(map.id)
    await recordActivity(c, event.id, 'event.map_deleted', { map_id: map.id })
    publishMap(c, event.id, 'maps', 'delete', map.id)
    return c.body(null, 204)
  })

  // --- POIs --------------------------------------------------------
  .post('/api/v1/ui/events/:id/pois', async (c) => {
    const { event } = await loadForAction(c, c.req.param('id'), 'editor')
    const parsed = CreatePoiSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    await assertMapInEvent(c, event.id, parsed.data.mapId ?? null)
    const poi = await c.var.repos.pois.create({
      id: `evp_${ulid()}`,
      eventId: event.id,
      mapId: parsed.data.mapId ?? null,
      categoryId: parsed.data.categoryId,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      xPct: parsed.data.xPct,
      yPct: parsed.data.yPct,
      lat: parsed.data.lat ?? null,
      lng: parsed.data.lng ?? null,
      sortOrder: parsed.data.sortOrder,
    })
    await recordActivity(c, event.id, 'event.poi_created', { poi_id: poi.id })
    publishMap(c, event.id, 'pois', 'create', poi.id)
    return c.json(serializePoi(poi), 201)
  })
  .get('/api/v1/ui/events/:id/pois', async (c) => {
    const { event } = await loadForAction(c, c.req.param('id'), 'viewer')
    const pois = await c.var.repos.pois.listForEvent(event.id)
    return c.json({ items: pois.map(serializePoi) })
  })
  .patch('/api/v1/ui/events/:id/pois/:poiId', async (c) => {
    const { event } = await loadForAction(c, c.req.param('id'), 'editor')
    const poi = await c.var.repos.pois.findById(c.req.param('poiId'))
    if (!poi || poi.eventId !== event.id) throw errors.notFound('POI not found.')
    const parsed = PatchPoiSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    if (parsed.data.mapId !== undefined) {
      await assertMapInEvent(c, event.id, parsed.data.mapId)
    }
    const updated = await c.var.repos.pois.update(poi.id, parsed.data)
    if (!updated) throw errors.notFound('POI not found.')
    await recordActivity(c, event.id, 'event.poi_updated', { poi_id: poi.id })
    publishMap(c, event.id, 'pois', 'update', poi.id)
    return c.json(serializePoi(updated))
  })
  .delete('/api/v1/ui/events/:id/pois/:poiId', async (c) => {
    const { event } = await loadForAction(c, c.req.param('id'), 'editor')
    const poi = await c.var.repos.pois.findById(c.req.param('poiId'))
    if (!poi || poi.eventId !== event.id) throw errors.notFound('POI not found.')
    await c.var.repos.pois.delete(poi.id)
    await recordActivity(c, event.id, 'event.poi_deleted', { poi_id: poi.id })
    publishMap(c, event.id, 'pois', 'delete', poi.id)
    return c.body(null, 204)
  })

  // --- no-go zones -------------------------------------------------
  .post('/api/v1/ui/events/:id/zones', async (c) => {
    const { event } = await loadForAction(c, c.req.param('id'), 'editor')
    const parsed = CreateZoneSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const map = await c.var.repos.maps.findById(parsed.data.mapId)
    if (!map || map.eventId !== event.id) {
      throw errors.notFound('Referenced map does not belong to this event.')
    }
    const zone = await c.var.repos.noGoZones.create({
      id: `evz_${ulid()}`,
      eventId: event.id,
      mapId: parsed.data.mapId,
      polygon: parsed.data.polygon,
    })
    await recordActivity(c, event.id, 'event.zone_created', { zone_id: zone.id })
    publishMap(c, event.id, 'no_go_zones', 'create', zone.id)
    return c.json(serializeZone(zone), 201)
  })
  .get('/api/v1/ui/events/:id/zones', async (c) => {
    const { event } = await loadForAction(c, c.req.param('id'), 'viewer')
    const zones = await c.var.repos.noGoZones.listForEvent(event.id)
    return c.json({ items: zones.map(serializeZone) })
  })
  .patch('/api/v1/ui/events/:id/zones/:zoneId', async (c) => {
    const { event } = await loadForAction(c, c.req.param('id'), 'editor')
    const zone = await c.var.repos.noGoZones.findById(c.req.param('zoneId'))
    if (!zone || zone.eventId !== event.id) throw errors.notFound('Zone not found.')
    const parsed = PatchZoneSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const updated = await c.var.repos.noGoZones.update(zone.id, parsed.data)
    if (!updated) throw errors.notFound('Zone not found.')
    await recordActivity(c, event.id, 'event.zone_updated', { zone_id: zone.id })
    publishMap(c, event.id, 'no_go_zones', 'update', zone.id)
    return c.json(serializeZone(updated))
  })
  .delete('/api/v1/ui/events/:id/zones/:zoneId', async (c) => {
    const { event } = await loadForAction(c, c.req.param('id'), 'editor')
    const zone = await c.var.repos.noGoZones.findById(c.req.param('zoneId'))
    if (!zone || zone.eventId !== event.id) throw errors.notFound('Zone not found.')
    await c.var.repos.noGoZones.delete(zone.id)
    await recordActivity(c, event.id, 'event.zone_deleted', { zone_id: zone.id })
    publishMap(c, event.id, 'no_go_zones', 'delete', zone.id)
    return c.body(null, 204)
  })

// A POI may float (null map_id) but if it names a map, that map must
// belong to THIS event — the FK enforces existence, not event scope.
async function assertMapInEvent(
  c: Context<HonoApp>,
  eventId: string,
  mapId: string | null,
): Promise<void> {
  if (mapId === null) return
  const map = await c.var.repos.maps.findById(mapId)
  if (!map || map.eventId !== eventId) {
    throw errors.notFound('Referenced map does not belong to this event.')
  }
}

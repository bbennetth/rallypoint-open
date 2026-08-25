import { Hono } from 'hono'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import { loadGroupForAction } from './_group-access.js'
import { serializeMap, serializePoi, serializeZone } from './maps.js'

// Group-scoped mirror reads of the event map surface (attendee Map tab).
//
// Why they exist: joining a group by code writes group_members +
// event_attendees but NOT event_members, so a code-joined member fails
// the viewer gate on every GET /events/:id/{maps,pois,zones}. These
// routes gate on group membership ('member' via loadGroupForAction —
// which also applies the attendee-revocation rule) and read the parent
// event's map data through group.eventId. Same serializers as the event
// routes; object_key is always omitted (viewer shape). Established
// pattern: GET /groups/:id/attendees in groups.ts.
//
// Reads only — all map mutations stay owner/editor-gated on the event
// routes (maps.ts).

export const groupMapsRoutes = new Hono<HonoApp>()
  .get('/api/v1/ui/groups/:id/maps', async (c) => {
    const { group } = await loadGroupForAction(c, c.req.param('id'), 'member')
    const maps = await c.var.repos.maps.listForEvent(group.eventId)
    return c.json({ items: maps.map((m) => serializeMap(m, { includeObjectKey: false })) })
  })
  // Streams the stored image bytes, mirroring GET /events/:id/maps/:mapId/image.
  .get('/api/v1/ui/groups/:id/maps/:mapId/image', async (c) => {
    const { group } = await loadGroupForAction(c, c.req.param('id'), 'member')
    const map = await c.var.repos.maps.findById(c.req.param('mapId'))
    if (!map || map.eventId !== group.eventId) throw errors.notFound('Map not found.')
    const obj = await c.var.services.objectStore.get(map.objectKey)
    if (!obj) throw errors.notFound('Map image not found.')
    c.header('Content-Type', obj.contentType ?? 'application/octet-stream')
    if (obj.contentLength !== null) c.header('Content-Length', String(obj.contentLength))
    // Member-gated content — keep it out of shared/CDN caches so a cached
    // 200 can't be served to a later unauthenticated request.
    c.header('Cache-Control', 'private, max-age=300')
    return c.body(obj.body as unknown as ReadableStream)
  })
  .get('/api/v1/ui/groups/:id/pois', async (c) => {
    const { group } = await loadGroupForAction(c, c.req.param('id'), 'member')
    const pois = await c.var.repos.pois.listForEvent(group.eventId)
    return c.json({ items: pois.map(serializePoi) })
  })
  .get('/api/v1/ui/groups/:id/zones', async (c) => {
    const { group } = await loadGroupForAction(c, c.req.param('id'), 'member')
    const zones = await c.var.repos.noGoZones.listForEvent(group.eventId)
    return c.json({ items: zones.map(serializeZone) })
  })

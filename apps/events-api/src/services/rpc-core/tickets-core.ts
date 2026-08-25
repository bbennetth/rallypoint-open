import { ulid } from 'ulid'
import {
  TICKET_MIME_EXTENSIONS,
  TICKET_MIME_TYPES,
  validateTicketUpload,
  type TicketMimeType,
} from '@rallypoint/events-shared'
import { matchesDeclaredType } from '@rallypoint/shared'
import type { EventRecord, PersonalTicketRecord } from '../../repos/types.js'
import type { EventsRpcDeps } from './deps.js'

// Cross-Worker RPC core for personal-event ticket attachments
// (apps/events-api/src/routes/sdk-personal-tickets.ts). The ownership
// gate is the same opaque 404 as personal-events: a missing /
// soft-deleted / wrong-scope / different-owner event collapses to
// `not_found`, an unsupported mime / oversize file to `bad_file`, and
// a missing ticket row to `ticket_not_found`. The HTTP handler maps
// each branch to its 4xx; the RPC consumer branches on `kind`.

// Each ticket method narrows to only the branches it can actually
// produce — review #1 P3: the catch-all `TicketResult<T>` produced dead
// branches in the HTTP wrapper (`if (kind === 'ticket_not_found')` for
// a fn that never returned it). Per-method types keep the wrappers
// honest and the RPC consumer's switch exhaustive.
export type TicketOk<T> = { kind: 'ok'; data: T }
export type EventNotFound = { kind: 'not_found' }
export type TicketNotFound = { kind: 'ticket_not_found' }
export type BadFile = { kind: 'bad_file'; reason: 'missing' | 'unsupported_type' | 'oversize' }

export type CreatePersonalTicketResult = TicketOk<PersonalTicketDto> | EventNotFound | BadFile
export type ListPersonalTicketsResult = TicketOk<PersonalTicketDto[]> | EventNotFound
export type DownloadPersonalTicketResult = TicketOk<PersonalTicketDownload> | EventNotFound | TicketNotFound

// Back-compat union used by the RPC class wrapper that re-exports below;
// individual fns narrow to one of the per-method types above.
export type TicketResult<T> = TicketOk<T> | EventNotFound | TicketNotFound | BadFile

export interface PersonalTicketDto {
  id: string
  eventId: string
  contentType: string
  bytes: number
  fileName: string | null
  uploadedByUserId: string
  uploadedAt: string
}

export interface CreatePersonalTicketInput {
  contentType: string
  bytes: ArrayBuffer | Uint8Array
  fileName?: string | null | undefined
}

export interface PersonalTicketDownload {
  contentType: string
  contentLength: number | null
  body: ArrayBuffer
}

function objectKeyFor(eventId: string, ticketId: string, mime: TicketMimeType): string {
  return `personal-tickets/${eventId}/${ticketId}.${TICKET_MIME_EXTENSIONS[mime]}`
}

function serializeTicketDto(t: PersonalTicketRecord): PersonalTicketDto {
  return {
    id: t.id,
    eventId: t.eventId,
    contentType: t.contentType,
    bytes: t.bytes,
    fileName: t.fileName,
    uploadedByUserId: t.uploadedByUserId,
    uploadedAt: t.uploadedAt.toISOString(),
  }
}

// Opaque ownership check (same as personal-events).
export async function loadOwnedPersonalEventForTickets(
  actor: string,
  eventId: string,
  deps: EventsRpcDeps,
): Promise<EventRecord | null> {
  const event = await deps.repos.events.findById(eventId)
  if (
    !event ||
    event.deletedAt !== null ||
    event.scopeType !== 'personal' ||
    event.ownerUserId !== actor
  ) {
    return null
  }
  return event
}

export async function createPersonalTicketCore(
  actor: string,
  eventId: string,
  input: CreatePersonalTicketInput,
  deps: EventsRpcDeps,
): Promise<CreatePersonalTicketResult> {
  const event = await loadOwnedPersonalEventForTickets(actor, eventId, deps)
  if (!event) return { kind: 'not_found' }

  const contentType = input.contentType.split(';')[0]!.trim().toLowerCase() as TicketMimeType
  if (!(TICKET_MIME_TYPES as readonly string[]).includes(contentType)) {
    return { kind: 'bad_file', reason: 'unsupported_type' }
  }
  const bytesView = input.bytes instanceof ArrayBuffer ? new Uint8Array(input.bytes) : input.bytes
  const size = bytesView.byteLength
  const check = validateTicketUpload({ contentType, contentLength: size })
  if (!check.ok) return { kind: 'bad_file', reason: 'oversize' }

  // Magic-byte gate: reject a file whose leading bytes don't match its
  // declared Content-Type, even when the MIME type is on the allowlist —
  // the same check the HTTP upload routes run (routes/maps.ts,
  // routes/pwa.ts). Without it a ticket declared application/pdf could
  // carry HTML/script bytes and be served back with that content type.
  if (!matchesDeclaredType(bytesView, contentType)) {
    return { kind: 'bad_file', reason: 'unsupported_type' }
  }

  const ticketId = `pkt_${ulid()}`
  const objectKey = objectKeyFor(eventId, ticketId, contentType)
  await deps.services.objectStore.put(objectKey, bytesView, { contentType })

  const fileName =
    typeof input.fileName === 'string' && input.fileName.trim().length > 0
      ? input.fileName.trim()
      : null

  let ticket: PersonalTicketRecord
  try {
    ticket = await deps.repos.personalTickets.create({
      id: ticketId,
      eventId,
      objectKey,
      contentType,
      bytes: size,
      fileName,
      uploadedByUserId: actor,
    })
  } catch (err) {
    await deps.services.objectStore.deleteObject(objectKey).catch(() => undefined)
    throw err
  }

  return { kind: 'ok', data: serializeTicketDto(ticket) }
}

export async function listPersonalTicketsCore(
  actor: string,
  eventId: string,
  deps: EventsRpcDeps,
): Promise<ListPersonalTicketsResult> {
  const event = await loadOwnedPersonalEventForTickets(actor, eventId, deps)
  if (!event) return { kind: 'not_found' }
  const tickets = await deps.repos.personalTickets.listForEvent(eventId)
  return { kind: 'ok', data: tickets.map(serializeTicketDto) }
}

export async function downloadPersonalTicketCore(
  actor: string,
  eventId: string,
  ticketId: string,
  deps: EventsRpcDeps,
): Promise<DownloadPersonalTicketResult> {
  const event = await loadOwnedPersonalEventForTickets(actor, eventId, deps)
  if (!event) return { kind: 'not_found' }

  const ticket = await deps.repos.personalTickets.findById(ticketId)
  if (!ticket || ticket.eventId !== eventId) {
    return { kind: 'ticket_not_found' }
  }

  const obj = await deps.services.objectStore.get(ticket.objectKey)
  if (!obj) return { kind: 'ticket_not_found' }
  // Collect the stream into a single ArrayBuffer. Tickets are capped at
  // 10 MB by the upload validator, so this is bounded and safe to ferry
  // over RPC without streaming machinery on the consumer side.
  const reader = (obj.body as ReadableStream<Uint8Array>).getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      chunks.push(value)
      total += value.byteLength
    }
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return {
    kind: 'ok',
    data: {
      contentType: obj.contentType ?? 'application/octet-stream',
      contentLength: obj.contentLength,
      body: merged.buffer.slice(merged.byteOffset, merged.byteOffset + merged.byteLength),
    },
  }
}

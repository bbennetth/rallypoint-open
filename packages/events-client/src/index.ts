// @rallypoint/events-client — typed client SDK for the Rallypoint Events
// public SDK API surface (`/api/v1/sdk/events/**`). Consumed by third
// parties and first-party consumers (e.g. festival-planner-v2) that
// render public event pages, lineups, and schedules.
//
// Unlike the lists / money SDK namespaces, the events `/sdk/` surface is
// **truly public**: no auth, no API key, no cookies — gating is
// content-side (a 404 unless the event's public page is enabled and the
// event is not private). See apps/events-api/src/routes/sdk-events.ts and
// docs/design/api-namespaces-cors.md. `apiKey` is therefore optional and
// only attaches an Authorization header when supplied (forward-compat for
// any future authenticated surface).

// --- wire DTOs -------------------------------------------------------
// Flat camelCase, mirroring the serialize*Dto helpers in
// apps/events-api/src/routes/sdk-events.ts. Kept inline (no dependency
// on @rallypoint/events-shared) so the client stays decoupled from
// server internals; the shapes are pinned by this package's own tests.

export interface EventThemeDto {
  accentColor: string | null
  backgroundImageUrl: string | null
}

// Section spec for the public page. Discriminated on `kind`. Unknown
// kinds are passed through as `{ kind }` so a server-side addition
// doesn't break older clients.
export type EventSectionDto =
  | { kind: 'map'; layer: string; imageUrl: string | null }
  | { kind: 'rsvp_link'; url: string }
  | { kind: 'lineup'; limitToTier?: string }
  | { kind: 'sessions'; dayId?: string }
  | { kind: string }

export interface PublicEventDto {
  id: string
  slug: string
  name: string
  description: string | null
  startDate: string | null
  endDate: string | null
  timezone: string
  locationLabel: string | null
  theme: EventThemeDto
  sections: EventSectionDto[]
  privacyMode: string
}

export interface StageDto {
  id: string
  eventId: string
  name: string
  sortOrder: number
}

export interface DayDto {
  id: string
  eventId: string
  dayLabel: string
  date: string
  // The day's own optional window ('HH:MM' or null; both null = all-day).
  startTime: string | null
  endTime: string | null
  sortOrder: number
}

export interface ArtistDto {
  id: string
  name: string
  spotify: string | null
  soundcloud: string | null
  appleMusic: string | null
  youtubeMusic: string | null
  instagram: string | null
}

export interface EventArtistDto {
  eventId: string
  artistId: string
  dayId: string
  stageId: string | null
  tier: string | null
  genre: string | null
  startTime: string | null
  endTime: string | null
  displayName: string | null
}

// Flat shape (stages + days + artists + eventArtists); the caller
// cross-joins on the ids.
export interface LineupResponse {
  stages: StageDto[]
  days: DayDto[]
  artists: ArtistDto[]
  eventArtists: EventArtistDto[]
}

export interface SessionDto {
  id: string
  eventId: string
  title: string
  description: string | null
  dayId: string | null
  stageId: string | null
  startTime: string | null
  endTime: string | null
  category: string | null
  location: string | null
  host: string | null
}

export interface SessionsResponse {
  items: SessionDto[]
}

// --- personal ticket DTOs (Slice 3) ----------------------------------
// Ticket-file attachments for personal events. objectKey is never surfaced.

export interface PersonalTicketDto {
  id: string
  eventId: string
  contentType: string
  bytes: number
  fileName: string | null
  uploadedByUserId: string
  uploadedAt: string
}

// --- personal events DTOs (Slice 2) ----------------------------------
// Authenticated Planner BFF surface. Flat camelCase, no tenantId/deletedAt.

export interface PersonalEventDto {
  id: string
  scopeType: string
  ownerUserId: string
  slug: string
  name: string
  description: string | null
  startAt: string | null
  endAt: string | null
  timezone: string
  locationLabel: string | null
  privacyMode: string
  /** Number of tickets attached to this personal event. */
  ticketCount: number
  /** Platform where the ticket was purchased (e.g. 'ticketmaster'), or null. */
  ticketPlatform: string | null
  /** Account email used to purchase the ticket, or null. */
  ticketAccountEmail: string | null
  createdAt: string
  updatedAt: string
}

export interface CreatePersonalEventInput {
  name: string
  description?: string | undefined
  startAt?: string | undefined
  endAt?: string | undefined
  locationLabel?: string | null | undefined
  ticketPlatform?: string | undefined
  ticketAccountEmail?: string | undefined
}

// Sparse patch of an owned personal event. Omitted = leave alone; `null`
// clears a nullable field (startAt/endAt/description/locationLabel/ticketPlatform/ticketAccountEmail).
export interface PatchPersonalEventInput {
  name?: string | undefined
  description?: string | null | undefined
  startAt?: string | null | undefined
  endAt?: string | null | undefined
  locationLabel?: string | null | undefined
  ticketPlatform?: string | null | undefined
  ticketAccountEmail?: string | null | undefined
}

// --- user (group) events DTOs (RPP) ---------------------------------
// Authenticated read surface for the group events a user reaches as
// owner / collaborator / attendee. Planner folds these into upcoming /
// my-day, one item per day. `owned` is server-stamped (owner_user_id ===
// actor) — it gates the "edit in RP Events" pencil and is never trusted
// from the client.

export interface UserEventDayDto {
  date: string
  dayLabel: string
  // The day's own optional window ('HH:MM' or null; both null = all-day).
  startTime: string | null
  endTime: string | null
}

export interface UserEventDto {
  eventId: string
  slug: string
  name: string
  scopeType: string
  owned: boolean
  startDate: string | null
  endDate: string | null
  days: UserEventDayDto[]
}

export interface EventsClientConfig {
  // Base origin of events-api, e.g. https://events.rallypt.app or
  // http://localhost:8081. No trailing slash required.
  baseUrl: string
  // Optional bearer key. The public `/sdk/events` surface needs none;
  // supply one for the authenticated /sdk/personal-events surface.
  apiKey?: string
  // Optional fetch override (tests / non-browser runtimes).
  fetch?: typeof fetch
}

// Thrown for any non-2xx response; carries the parsed error envelope
// (docs/design/error-shape.md) when present.
export class EventsClientError extends Error {
  readonly status: number
  readonly code: string
  readonly details?: unknown
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'EventsClientError'
    this.status = status
    this.code = code
    this.details = details
  }
}

export interface EventsClient {
  // Public event shell + theme + section spec. 404s (EventsClientError,
  // status 404) when the page is disabled / private / missing.
  getEvent(slug: string): Promise<PublicEventDto>
  // Flat lineup (stages, days, artists, eventArtists) for the event.
  getLineup(slug: string): Promise<LineupResponse>
  // Approved sessions for the event; narrow to a single day with
  // `opts.dayId`.
  getSessions(slug: string, opts?: { dayId?: string }): Promise<SessionsResponse>

  // --- Authenticated personal-events surface (Slice 2) ----------------
  // All three require `apiKey` in the client config (PLANNER_API_KEY) and
  // an `actor` (user_<ulid>) that the calling BFF has already authorized.

  // Create a personal event for the actor. Returns 201 PersonalEventDto.
  createPersonalEvent(
    opts: { actor: string } & CreatePersonalEventInput,
  ): Promise<PersonalEventDto>
  // List the actor's personal events. Optional ISO instant window.
  listPersonalEvents(opts: {
    actor: string
    from?: string | undefined
    to?: string | undefined
  }): Promise<PersonalEventDto[]>
  // Get one personal event by id. 404s if missing, deleted, wrong scope,
  // or owned by a different actor.
  getPersonalEvent(opts: { actor: string; id: string }): Promise<PersonalEventDto>
  // Patch an owned personal event. 404s like getPersonalEvent.
  patchPersonalEvent(
    opts: { actor: string; id: string } & PatchPersonalEventInput,
  ): Promise<PersonalEventDto>
  // Soft-delete an owned personal event. 404s like getPersonalEvent.
  deletePersonalEvent(opts: { actor: string; id: string }): Promise<void>

  // --- User group-events surface (RPP) --------------------------------
  // List the group (festival) events the actor reaches as owner,
  // collaborator, or current attendee. `owned` is server-stamped.
  // Requires `apiKey` (PLANNER_API_KEY) and an `actor` the BFF authorized.
  listUserEvents(opts: { actor: string }): Promise<UserEventDto[]>

  // --- Planner-pref surface (RPP) -------------------------------------
  // Toggle whether a group event shows in the Planner for the actor.
  // Requires `apiKey` (PLANNER_API_KEY) and an `actor` the BFF authorized.
  // show=false clears the flag; the upsert is idempotent.
  setGroupEventPlannerPref(opts: {
    actor: string
    eventId: string
    show: boolean
  }): Promise<void>
  // List group events the actor has flagged show_in_planner=true.
  // Re-checks access at read time: events the actor lost access to
  // silently drop out of the response.
  listPlannerGroupEvents(opts: { actor: string }): Promise<UserEventDto[]>

  // --- Ticket-file attachments (Slice 3, migrated to R2 bindings #409) ---
  // Single-step upload: POST multipart/form-data (file + optional fileName)
  // to the Worker, which validates inline and stores in R2. No presign step.
  uploadTicket(opts: {
    actor: string
    eventId: string
    file: Blob
    contentType: string
    fileName?: string | undefined
  }): Promise<PersonalTicketDto>
  // List all ticket attachments for an owned personal event.
  listTickets(opts: { actor: string; eventId: string }): Promise<PersonalTicketDto[]>
  // Stream the ticket bytes from the Worker (R2 binding). Returns the raw
  // Response so the caller can pipe the body as needed. Throws on non-2xx.
  downloadTicket(opts: {
    actor: string
    eventId: string
    ticketId: string
  }): Promise<Response>
}

export function createEventsClient(config: EventsClientConfig): EventsClient {
  const base = config.baseUrl.replace(/\/$/, '')
  const doFetch = config.fetch ?? globalThis.fetch

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: {
        ...(config.apiKey === undefined ? {} : { authorization: `Bearer ${config.apiKey}` }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...extraHeaders,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await res.text()
    const json: unknown = text ? JSON.parse(text) : {}
    if (!res.ok) {
      const env = (json as { error?: { code?: string; message?: string; details?: unknown } })
        .error
      throw new EventsClientError(
        res.status,
        env?.code ?? 'unknown_error',
        env?.message ?? `Request failed with status ${res.status}`,
        env?.details,
      )
    }
    return json as T
  }

  return {
    getEvent(slug) {
      return request<PublicEventDto>('GET', `/api/v1/sdk/events/${encodeURIComponent(slug)}`)
    },
    getLineup(slug) {
      return request<LineupResponse>(
        'GET',
        `/api/v1/sdk/events/${encodeURIComponent(slug)}/lineup`,
      )
    },
    getSessions(slug, opts) {
      const suffix =
        opts?.dayId !== undefined
          ? `?${new URLSearchParams({ day_id: opts.dayId }).toString()}`
          : ''
      return request<SessionsResponse>(
        'GET',
        `/api/v1/sdk/events/${encodeURIComponent(slug)}/sessions${suffix}`,
      )
    },

    // --- personal events (Slice 2) -----------------------------------

    createPersonalEvent({ actor, name, description, startAt, endAt, locationLabel, ticketPlatform, ticketAccountEmail }) {
      return request<PersonalEventDto>(
        'POST',
        '/api/v1/sdk/personal-events',
        { name, description, startAt, endAt, locationLabel, ticketPlatform, ticketAccountEmail },
        { 'x-actor': actor },
      )
    },

    listPersonalEvents({ actor, from, to }) {
      const qs = new URLSearchParams()
      if (from !== undefined) qs.set('from', from)
      if (to !== undefined) qs.set('to', to)
      const suffix = qs.toString() ? `?${qs.toString()}` : ''
      return request<PersonalEventDto[]>(
        'GET',
        `/api/v1/sdk/personal-events${suffix}`,
        undefined,
        { 'x-actor': actor },
      )
    },

    getPersonalEvent({ actor, id }) {
      return request<PersonalEventDto>(
        'GET',
        `/api/v1/sdk/personal-events/${encodeURIComponent(id)}`,
        undefined,
        { 'x-actor': actor },
      )
    },

    patchPersonalEvent({ actor, id, ...patch }) {
      return request<PersonalEventDto>(
        'PATCH',
        `/api/v1/sdk/personal-events/${encodeURIComponent(id)}`,
        patch,
        { 'x-actor': actor },
      )
    },

    async deletePersonalEvent({ actor, id }) {
      await request<void>(
        'DELETE',
        `/api/v1/sdk/personal-events/${encodeURIComponent(id)}`,
        undefined,
        { 'x-actor': actor },
      )
    },

    // --- user group-events (RPP) -------------------------------------

    listUserEvents({ actor }) {
      return request<UserEventDto[]>(
        'GET',
        '/api/v1/sdk/user-events',
        undefined,
        { 'x-actor': actor },
      )
    },

    // --- planner prefs for group events (RPP) ------------------------

    async setGroupEventPlannerPref({ actor, eventId, show }) {
      await request<void>(
        'PUT',
        `/api/v1/sdk/events/${encodeURIComponent(eventId)}/planner-pref`,
        { show },
        { 'x-actor': actor },
      )
    },

    listPlannerGroupEvents({ actor }) {
      return request<UserEventDto[]>(
        'GET',
        '/api/v1/sdk/planner-events',
        undefined,
        { 'x-actor': actor },
      )
    },

    // --- ticket attachments (Slice 3, R2 bindings #409) ---------------

    async uploadTicket({ actor, eventId, file, contentType, fileName }) {
      const formData = new FormData()
      formData.append('file', new File([file], fileName ?? 'ticket', { type: contentType }))
      if (fileName !== undefined) formData.append('fileName', fileName)
      const res = await doFetch(
        `${base}/api/v1/sdk/personal-events/${encodeURIComponent(eventId)}/tickets`,
        {
          method: 'POST',
          headers: {
            ...(config.apiKey === undefined ? {} : { authorization: `Bearer ${config.apiKey}` }),
            'x-actor': actor,
          },
          body: formData,
        },
      )
      const text = await res.text()
      const json: unknown = text ? JSON.parse(text) : {}
      if (!res.ok) {
        const err = (json as { error?: { code?: string; message?: string; details?: unknown } }).error
        throw new EventsClientError(
          res.status,
          err?.code ?? 'upload_failed',
          err?.message ?? `Upload failed (${res.status}).`,
          err?.details,
        )
      }
      return json as PersonalTicketDto
    },

    async listTickets({ actor, eventId }) {
      const res = await request<{ items: PersonalTicketDto[] }>(
        'GET',
        `/api/v1/sdk/personal-events/${encodeURIComponent(eventId)}/tickets`,
        undefined,
        { 'x-actor': actor },
      )
      return res.items
    },

    async downloadTicket({ actor, eventId, ticketId }) {
      const res = await doFetch(
        `${base}/api/v1/sdk/personal-events/${encodeURIComponent(eventId)}/tickets/${encodeURIComponent(ticketId)}/download`,
        {
          method: 'GET',
          headers: {
            ...(config.apiKey === undefined ? {} : { authorization: `Bearer ${config.apiKey}` }),
            'x-actor': actor,
          },
        },
      )
      if (!res.ok) {
        let code = 'download_failed'
        let message = `Download failed (${res.status}).`
        try {
          const json = (await res.clone().json()) as { error?: { code?: string; message?: string } }
          if (json.error?.code) code = json.error.code
          if (json.error?.message) message = json.error.message
        } catch { /* ignore */ }
        throw new EventsClientError(res.status, code, message)
      }
      return res
    },
  }
}

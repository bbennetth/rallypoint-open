import { describe, it, expect, vi } from 'vitest'
import {
  createEventsClient,
  EventsClientError,
  type ForecastResponse,
  type PublicEventDto,
  type LineupResponse,
  type PersonalEventDto,
  type PersonalTicketDto,
  type UserEventDto,
} from './index.js'

// Unit tests for the typed client using a fake fetch. Cover the happy
// path (correct method/path), the public-surface contract (no auth
// header unless a key is supplied), query construction, and the error
// envelope (parsed into EventsClientError).

function makeFakeFetch(handler: (req: Request) => Promise<Response> | Response) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const req = new Request(url, init)
    return handler(req)
  })
}

const SAMPLE_EVENT: PublicEventDto = {
  id: 'evt_1',
  slug: 'sunset-fest',
  name: 'Sunset Fest',
  description: 'A festival',
  startDate: '2026-07-01',
  endDate: '2026-07-03',
  timezone: 'America/Los_Angeles',
  locationLabel: 'The Beach',
  theme: { accentColor: '#ff8800', backgroundImageUrl: null },
  sections: [{ kind: 'lineup' }, { kind: 'map', layer: 'site', imageUrl: null }],
  privacyMode: 'public',
}

describe('createEventsClient', () => {
  it('GETs the event and does NOT send an auth header when no apiKey is set', async () => {
    const fakeFetch = makeFakeFetch((req) => {
      expect(req.method).toBe('GET')
      expect(req.url).toBe('https://events.example/api/v1/sdk/events/sunset-fest')
      expect(req.headers.get('authorization')).toBeNull()
      return new Response(JSON.stringify(SAMPLE_EVENT), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const client = createEventsClient({
      baseUrl: 'https://events.example',
      fetch: fakeFetch as unknown as typeof fetch,
    })

    const event = await client.getEvent('sunset-fest')
    expect(event.id).toBe('evt_1')
    expect(event.sections).toHaveLength(2)
  })

  it('sends a bearer header when an apiKey IS supplied (forward-compat)', async () => {
    const fakeFetch = makeFakeFetch((req) => {
      expect(req.headers.get('authorization')).toBe('Bearer secret')
      return new Response(JSON.stringify(SAMPLE_EVENT), { status: 200 })
    })
    const client = createEventsClient({
      baseUrl: 'https://events.example',
      apiKey: 'secret',
      fetch: fakeFetch as unknown as typeof fetch,
    })
    await client.getEvent('sunset-fest')
  })

  it('strips a trailing slash from baseUrl and URL-encodes the slug', async () => {
    const fakeFetch = makeFakeFetch((req) => {
      expect(req.url).toBe('https://events.example/api/v1/sdk/events/a%2Fb')
      return new Response(JSON.stringify(SAMPLE_EVENT), { status: 200 })
    })
    const client = createEventsClient({
      baseUrl: 'https://events.example/',
      fetch: fakeFetch as unknown as typeof fetch,
    })
    await client.getEvent('a/b')
  })

  it('parses the flat lineup response', async () => {
    const payload: LineupResponse = {
      stages: [{ id: 's1', eventId: 'evt_1', name: 'Main', sortOrder: 0 }],
      days: [{ id: 'd1', eventId: 'evt_1', dayLabel: 'Fri', date: '2026-07-01', startTime: null, endTime: null, sortOrder: 0 }],
      artists: [
        {
          id: 'art_1',
          name: 'Four Tet',
          spotify: null,
          soundcloud: null,
          appleMusic: null,
          youtubeMusic: null,
          instagram: null,
        },
      ],
      eventArtists: [
        {
          eventId: 'evt_1',
          artistId: 'art_1',
          dayId: 'd1',
          stageId: 's1',
          tier: 'headliner',
          genre: null,
          startTime: '20:00:00',
          endTime: '22:00:00',
          displayName: null,
        },
      ],
    }
    const fakeFetch = makeFakeFetch((req) => {
      expect(req.url).toBe('https://events.example/api/v1/sdk/events/sunset-fest/lineup')
      return new Response(JSON.stringify(payload), { status: 200 })
    })
    const client = createEventsClient({
      baseUrl: 'https://events.example',
      fetch: fakeFetch as unknown as typeof fetch,
    })
    const lineup = await client.getLineup('sunset-fest')
    expect(lineup.stages[0]!.sortOrder).toBe(0)
    expect(lineup.days[0]!.date).toBe('2026-07-01')
    expect(lineup.artists[0]!.name).toBe('Four Tet')
    expect(lineup.eventArtists[0]!.tier).toBe('headliner')
  })

  it('getSessions omits the day_id query when no dayId is given', async () => {
    const fakeFetch = makeFakeFetch((req) => {
      expect(req.url).toBe('https://events.example/api/v1/sdk/events/sunset-fest/sessions')
      return new Response(JSON.stringify({ items: [] }), { status: 200 })
    })
    const client = createEventsClient({
      baseUrl: 'https://events.example',
      fetch: fakeFetch as unknown as typeof fetch,
    })
    await client.getSessions('sunset-fest')
  })

  it('getSessions passes day_id as a query param when provided', async () => {
    const fakeFetch = makeFakeFetch((req) => {
      expect(req.url).toBe(
        'https://events.example/api/v1/sdk/events/sunset-fest/sessions?day_id=d1',
      )
      return new Response(
        JSON.stringify({
          items: [
            {
              id: 'ses_1',
              eventId: 'evt_1',
              title: 'Yoga',
              description: null,
              dayId: 'd1',
              startTime: '09:00:00',
              endTime: '10:00:00',
              category: 'wellness',
              location: 'Tent',
              host: null,
            },
          ],
        }),
        { status: 200 },
      )
    })
    const client = createEventsClient({
      baseUrl: 'https://events.example',
      fetch: fakeFetch as unknown as typeof fetch,
    })
    const res = await client.getSessions('sunset-fest', { dayId: 'd1' })
    expect(res.items[0]!.title).toBe('Yoga')
    expect(res.items[0]!.dayId).toBe('d1')
    expect(res.items[0]!.category).toBe('wellness')
  })

  it('getSessions surfaces the error envelope on non-2xx', async () => {
    const fakeFetch = makeFakeFetch(
      () =>
        new Response(JSON.stringify({ error: { code: 'event_not_found', message: 'Gone.' } }), {
          status: 404,
        }),
    )
    const client = createEventsClient({
      baseUrl: 'https://events.example',
      fetch: fakeFetch as unknown as typeof fetch,
    })
    await expect(client.getSessions('missing')).rejects.toMatchObject({
      name: 'EventsClientError',
      status: 404,
      code: 'event_not_found',
    })
  })

  it('throws EventsClientError carrying the envelope on non-2xx', async () => {
    const fakeFetch = makeFakeFetch(
      () =>
        new Response(
          JSON.stringify({ error: { code: 'event_not_found', message: 'Not found.' } }),
          { status: 404, headers: { 'content-type': 'application/json' } },
        ),
    )
    const client = createEventsClient({
      baseUrl: 'https://events.example',
      fetch: fakeFetch as unknown as typeof fetch,
    })
    await expect(client.getEvent('missing')).rejects.toMatchObject({
      name: 'EventsClientError',
      status: 404,
      code: 'event_not_found',
      message: 'Not found.',
    })
  })

  it('exposes a default error code when the envelope is missing', async () => {
    const fakeFetch = makeFakeFetch(() => new Response('', { status: 500 }))
    const client = createEventsClient({
      baseUrl: 'https://events.example',
      fetch: fakeFetch as unknown as typeof fetch,
    })
    try {
      await client.getLineup('x')
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(EventsClientError)
      expect((err as EventsClientError).status).toBe(500)
      expect((err as EventsClientError).code).toBe('unknown_error')
    }
  })
})

// --- personal events methods (Slice 2) --------------------------------

const SAMPLE_PERSONAL: PersonalEventDto = {
  id: 'event_abc',
  scopeType: 'personal',
  ownerUserId: 'user_xyz',
  slug: 'personal-abc123',
  name: 'Morning run',
  description: null,
  startAt: '2026-06-03T06:00:00.000Z',
  endAt: '2026-06-03T07:00:00.000Z',
  timezone: 'UTC',
  locationLabel: null,
  privacyMode: 'private',
  createdAt: '2026-06-03T00:00:00.000Z',
  updatedAt: '2026-06-03T00:00:00.000Z',
}

describe('createEventsClient — personal events', () => {
  const API_KEY = 'test-planner-key'
  const ACTOR = 'user_xyz'

  it('createPersonalEvent POSTs with Authorization + x-actor + JSON body', async () => {
    const fakeFetch = makeFakeFetch((req) => {
      expect(req.method).toBe('POST')
      expect(req.url).toBe('https://events.example/api/v1/sdk/personal-events')
      expect(req.headers.get('authorization')).toBe(`Bearer ${API_KEY}`)
      expect(req.headers.get('x-actor')).toBe(ACTOR)
      expect(req.headers.get('content-type')).toBe('application/json')
      return new Response(JSON.stringify(SAMPLE_PERSONAL), { status: 201 })
    })
    const client = createEventsClient({
      baseUrl: 'https://events.example',
      apiKey: API_KEY,
      fetch: fakeFetch as unknown as typeof fetch,
    })
    const result = await client.createPersonalEvent({ actor: ACTOR, name: 'Morning run' })
    expect(result.id).toBe('event_abc')
    expect(result.scopeType).toBe('personal')
  })

  it('listPersonalEvents GETs with Authorization + x-actor (no query when no window)', async () => {
    const fakeFetch = makeFakeFetch((req) => {
      expect(req.method).toBe('GET')
      expect(req.url).toBe('https://events.example/api/v1/sdk/personal-events')
      expect(req.headers.get('authorization')).toBe(`Bearer ${API_KEY}`)
      expect(req.headers.get('x-actor')).toBe(ACTOR)
      return new Response(JSON.stringify([SAMPLE_PERSONAL]), { status: 200 })
    })
    const client = createEventsClient({
      baseUrl: 'https://events.example',
      apiKey: API_KEY,
      fetch: fakeFetch as unknown as typeof fetch,
    })
    const list = await client.listPersonalEvents({ actor: ACTOR })
    expect(list).toHaveLength(1)
    expect(list[0]!.name).toBe('Morning run')
  })

  it('listPersonalEvents passes from + to query params when supplied', async () => {
    const fakeFetch = makeFakeFetch((req) => {
      const url = new URL(req.url)
      expect(url.searchParams.get('from')).toBe('2026-06-01T00:00:00Z')
      expect(url.searchParams.get('to')).toBe('2026-06-30T00:00:00Z')
      return new Response(JSON.stringify([]), { status: 200 })
    })
    const client = createEventsClient({
      baseUrl: 'https://events.example',
      apiKey: API_KEY,
      fetch: fakeFetch as unknown as typeof fetch,
    })
    await client.listPersonalEvents({
      actor: ACTOR,
      from: '2026-06-01T00:00:00Z',
      to: '2026-06-30T00:00:00Z',
    })
  })

  it('getPersonalEvent GETs the correct path with Authorization + x-actor', async () => {
    const fakeFetch = makeFakeFetch((req) => {
      expect(req.method).toBe('GET')
      expect(req.url).toBe('https://events.example/api/v1/sdk/personal-events/event_abc')
      expect(req.headers.get('authorization')).toBe(`Bearer ${API_KEY}`)
      expect(req.headers.get('x-actor')).toBe(ACTOR)
      return new Response(JSON.stringify(SAMPLE_PERSONAL), { status: 200 })
    })
    const client = createEventsClient({
      baseUrl: 'https://events.example',
      apiKey: API_KEY,
      fetch: fakeFetch as unknown as typeof fetch,
    })
    const result = await client.getPersonalEvent({ actor: ACTOR, id: 'event_abc' })
    expect(result.id).toBe('event_abc')
  })

  it('getPersonalEvent throws EventsClientError on 404', async () => {
    const fakeFetch = makeFakeFetch(
      () =>
        new Response(
          JSON.stringify({ error: { code: 'not_found', message: 'Personal event not found.' } }),
          { status: 404 },
        ),
    )
    const client = createEventsClient({
      baseUrl: 'https://events.example',
      apiKey: API_KEY,
      fetch: fakeFetch as unknown as typeof fetch,
    })
    await expect(client.getPersonalEvent({ actor: ACTOR, id: 'event_missing' })).rejects.toMatchObject({
      name: 'EventsClientError',
      status: 404,
      code: 'not_found',
    })
  })
})

// --- user (group) events ------------------------------------------------

const SAMPLE_USER_EVENT: UserEventDto = {
  eventId: 'event_grp',
  slug: 'sunset-fest',
  name: 'Sunset Fest',
  scopeType: 'group',
  owned: true,
  startDate: '2026-06-04',
  endDate: '2026-06-05',
  days: [
    { date: '2026-06-04', dayLabel: 'Day 1', startTime: '10:00', endTime: '18:00' },
    { date: '2026-06-05', dayLabel: 'Day 2', startTime: null, endTime: null },
  ],
}

describe('createEventsClient — user (group) events', () => {
  const API_KEY = 'test-planner-key'
  const ACTOR = 'user_xyz'

  it('listUserEvents GETs /sdk/user-events with Authorization + x-actor', async () => {
    const fakeFetch = makeFakeFetch((req) => {
      expect(req.method).toBe('GET')
      expect(req.url).toBe('https://events.example/api/v1/sdk/user-events')
      expect(req.headers.get('authorization')).toBe(`Bearer ${API_KEY}`)
      expect(req.headers.get('x-actor')).toBe(ACTOR)
      return new Response(JSON.stringify([SAMPLE_USER_EVENT]), { status: 200 })
    })
    const client = createEventsClient({
      baseUrl: 'https://events.example',
      apiKey: API_KEY,
      fetch: fakeFetch as unknown as typeof fetch,
    })
    const list = await client.listUserEvents({ actor: ACTOR })
    expect(list).toHaveLength(1)
    expect(list[0]!.owned).toBe(true)
    expect(list[0]!.days).toHaveLength(2)
    expect(list[0]!.days[1]!.startTime).toBeNull()
  })
})

// --- ticket attachment methods (Slice 3) --------------------------------

const SAMPLE_TICKET: PersonalTicketDto = {
  id: 'pkt_abc',
  eventId: 'event_abc',
  contentType: 'application/pdf',
  bytes: 102400,
  fileName: 'ticket.pdf',
  uploadedByUserId: 'user_xyz',
  uploadedAt: '2026-06-03T08:00:00.000Z',
}

describe('createEventsClient — ticket attachments (R2 bindings #409)', () => {
  const API_KEY = 'test-planner-key'
  const ACTOR = 'user_xyz'
  const EVENT_ID = 'event_abc'
  const TICKET_ID = 'pkt_abc'

  it('uploadTicket POSTs multipart/form-data to the tickets path', async () => {
    const fakeFetch = makeFakeFetch(async (req) => {
      expect(req.method).toBe('POST')
      expect(req.url).toBe(
        `https://events.example/api/v1/sdk/personal-events/${EVENT_ID}/tickets`,
      )
      expect(req.headers.get('authorization')).toBe(`Bearer ${API_KEY}`)
      expect(req.headers.get('x-actor')).toBe(ACTOR)
      // Body must be multipart (not JSON).
      expect(req.headers.get('content-type')).toContain('multipart/form-data')
      const form = await req.formData()
      expect(form.get('fileName')).toBe('ticket.pdf')
      return new Response(JSON.stringify(SAMPLE_TICKET), { status: 201 })
    })
    const client = createEventsClient({
      baseUrl: 'https://events.example',
      apiKey: API_KEY,
      fetch: fakeFetch as unknown as typeof fetch,
    })
    const result = await client.uploadTicket({
      actor: ACTOR,
      eventId: EVENT_ID,
      file: new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])], { type: 'application/pdf' }),
      contentType: 'application/pdf',
      fileName: 'ticket.pdf',
    })
    expect(result.id).toBe(TICKET_ID)
    expect(result.bytes).toBe(102400)
    expect(result.fileName).toBe('ticket.pdf')
  })

  it('listTickets GETs the tickets path and unwraps items', async () => {
    const fakeFetch = makeFakeFetch((req) => {
      expect(req.method).toBe('GET')
      expect(req.url).toBe(
        `https://events.example/api/v1/sdk/personal-events/${EVENT_ID}/tickets`,
      )
      expect(req.headers.get('authorization')).toBe(`Bearer ${API_KEY}`)
      expect(req.headers.get('x-actor')).toBe(ACTOR)
      return new Response(JSON.stringify({ items: [SAMPLE_TICKET] }), { status: 200 })
    })
    const client = createEventsClient({
      baseUrl: 'https://events.example',
      apiKey: API_KEY,
      fetch: fakeFetch as unknown as typeof fetch,
    })
    const list = await client.listTickets({ actor: ACTOR, eventId: EVENT_ID })
    expect(list).toHaveLength(1)
    expect(list[0]!.id).toBe(TICKET_ID)
  })

  it('downloadTicket GETs the download path and returns the raw Response', async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46])
    const fakeFetch = makeFakeFetch((req) => {
      expect(req.method).toBe('GET')
      expect(req.url).toBe(
        `https://events.example/api/v1/sdk/personal-events/${EVENT_ID}/tickets/${TICKET_ID}/download`,
      )
      expect(req.headers.get('authorization')).toBe(`Bearer ${API_KEY}`)
      expect(req.headers.get('x-actor')).toBe(ACTOR)
      return new Response(pdfBytes, {
        status: 200,
        headers: { 'Content-Type': 'application/pdf' },
      })
    })
    const client = createEventsClient({
      baseUrl: 'https://events.example',
      apiKey: API_KEY,
      fetch: fakeFetch as unknown as typeof fetch,
    })
    const res = await client.downloadTicket({
      actor: ACTOR,
      eventId: EVENT_ID,
      ticketId: TICKET_ID,
    })
    expect(res.ok).toBe(true)
    expect(res.headers.get('Content-Type')).toBe('application/pdf')
    const body = new Uint8Array(await res.arrayBuffer())
    expect(body[0]).toBe(0x25)
  })
})

// --- coordinate forecast (Open-Meteo proxy) -----------------------------

describe('createEventsClient — coordinate forecast', () => {
  it('GETs /sdk/weather with lat/lng/tz/date and carries the optional hourly series', async () => {
    const payload: ForecastResponse = {
      forecast: {
        units: { temperature: 'C', precipitation: 'mm', windSpeed: 'km/h' },
        current: { temperature: 18, apparentTemperature: 17, windSpeed: 9, weatherCode: 2, isDay: true },
        daily: [
          {
            date: '2026-06-17',
            temperatureMax: 24,
            temperatureMin: 12,
            precipitationSum: 0,
            precipitationProbabilityMax: 40,
            windSpeedMax: 14,
            uvIndexMax: 7,
            weatherCode: 61,
            sunrise: '2026-06-17T05:30',
            sunset: '2026-06-17T20:45',
          },
        ],
        hourly: [
          { time: '2026-06-17T12:00', temperature: 23, uvIndex: 7, weatherCode: 2, isDay: true, precipitationProbability: 10 },
        ],
      },
      airQuality: null,
    }
    const fakeFetch = makeFakeFetch((req) => {
      const url = new URL(req.url)
      expect(url.pathname).toBe('/api/v1/sdk/weather')
      expect(url.searchParams.get('lat')).toBe('51.5')
      expect(url.searchParams.get('lng')).toBe('-0.12')
      expect(url.searchParams.get('tz')).toBe('Europe/London')
      expect(url.searchParams.get('date')).toBe('2026-06-17')
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const client = createEventsClient({
      baseUrl: 'https://events.example',
      apiKey: 'k',
      fetch: fakeFetch as unknown as typeof fetch,
    })
    const res = await client.getForecast({ lat: 51.5, lng: -0.12, tz: 'Europe/London', date: '2026-06-17' })
    expect(res.forecast?.daily[0]!.uvIndexMax).toBe(7)
    expect(res.forecast?.hourly).toHaveLength(1)
    expect(res.forecast?.hourly?.[0]!.uvIndex).toBe(7)
  })
})

import type { Service } from '@cloudflare/workers-types'
import type { EventsRPC } from '@rallypoint/events-api'
import { EventsClientError } from '@rallypoint/events-client'
import type {
  EventsClient,
  PersonalEventDto,
  PersonalTicketDto,
  UserEventDto,
  HolidayDto,
  ForecastResponse,
  PublicEventDto,
  LineupResponse,
  SessionsResponse,
} from '@rallypoint/events-client'
import type { RpcReturn } from './_rpc.js'

// planner-api → events-api `Service<EventsRPC>` proxy. Implements the
// existing `EventsClient` interface (preserves call sites) but
// dispatches each method to the binding's RPC method. Discriminated
// returns are unwrapped to either the data or an `EventsClientError`.
// The three PUBLIC methods (getEvent / getLineup / getSessions) live on
// id-api/events-api's `fetch` handler — they are not exposed as RPC
// methods — but planner-api does not call them, so the adapter
// surfaces them as `unsupported_in_rpc_adapter` no-ops.

function notFound(message: string): EventsClientError {
  return new EventsClientError(404, 'not_found', message)
}

function unsupported(name: string): never {
  throw new EventsClientError(
    501,
    'unsupported_in_rpc_adapter',
    `EventsClient.${name} is not exposed over RPC — call the public HTTP route directly.`,
  )
}

export function createEventsClientFromBinding(binding: Service<EventsRPC>): EventsClient {
  return {
    async getEvent(_slug: string): Promise<PublicEventDto> {
      return unsupported('getEvent')
    },
    async getLineup(_slug: string): Promise<LineupResponse> {
      return unsupported('getLineup')
    },
    async getSessions(_slug: string, _opts?: { dayId?: string }): Promise<SessionsResponse> {
      return unsupported('getSessions')
    },

    async createPersonalEvent(opts) {
      const { actor, ...input } = opts
      const dto = (await binding.createPersonalEvent(actor, input as never)) as RpcReturn<
        EventsRPC['createPersonalEvent']
      >
      return dto as unknown as PersonalEventDto
    },
    async listPersonalEvents(opts): Promise<PersonalEventDto[]> {
      const dtos = (await binding.listPersonalEvents(opts.actor, {
        ...(opts.from !== undefined ? { from: opts.from } : {}),
        ...(opts.to !== undefined ? { to: opts.to } : {}),
      })) as RpcReturn<EventsRPC['listPersonalEvents']>
      return dtos as unknown as PersonalEventDto[]
    },
    async getPersonalEvent(opts): Promise<PersonalEventDto> {
      const r = (await binding.getPersonalEvent(opts.actor, opts.id)) as RpcReturn<
        EventsRPC['getPersonalEvent']
      >
      if (r.kind === 'not_found') throw notFound('Personal event not found.')
      return r.data as unknown as PersonalEventDto
    },
    async patchPersonalEvent(opts): Promise<PersonalEventDto> {
      const { actor, id, ...patch } = opts
      const r = (await binding.patchPersonalEvent(actor, id, patch as never)) as RpcReturn<
        EventsRPC['patchPersonalEvent']
      >
      if (r.kind === 'not_found') throw notFound('Personal event not found.')
      return r.data as unknown as PersonalEventDto
    },
    async deletePersonalEvent(opts): Promise<void> {
      const r = (await binding.deletePersonalEvent(opts.actor, opts.id)) as RpcReturn<
        EventsRPC['deletePersonalEvent']
      >
      if (r.kind === 'not_found') throw notFound('Personal event not found.')
    },

    async listUserEvents(opts): Promise<UserEventDto[]> {
      const dtos = (await binding.listUserEvents(opts.actor)) as RpcReturn<
        EventsRPC['listUserEvents']
      >
      return dtos as unknown as UserEventDto[]
    },

    async setGroupEventPlannerPref(opts): Promise<void> {
      const r = (await binding.setPlannerPref(opts.actor, opts.eventId, opts.show)) as RpcReturn<
        EventsRPC['setPlannerPref']
      >
      if (r.kind === 'not_found') throw notFound('Event not found.')
    },
    async listPlannerGroupEvents(opts): Promise<UserEventDto[]> {
      const dtos = (await binding.getPlannerEvents(opts.actor)) as RpcReturn<
        EventsRPC['getPlannerEvents']
      >
      return dtos as unknown as UserEventDto[]
    },

    async listHolidays(params): Promise<HolidayDto[]> {
      const dtos = (await binding.listHolidays(params.from, params.to)) as RpcReturn<
        EventsRPC['listHolidays']
      >
      return dtos as unknown as HolidayDto[]
    },

    async getForecast(opts): Promise<ForecastResponse> {
      const r = (await binding.getCoordinateWeather({
        lat: opts.lat,
        lng: opts.lng,
        tz: opts.tz,
        ...(opts.date !== undefined ? { date: opts.date } : {}),
      })) as RpcReturn<EventsRPC['getCoordinateWeather']>
      if (r.kind === 'bad_latlng') {
        throw new EventsClientError(422, 'bad_latlng', 'lat/lng out of range')
      }
      if (r.kind === 'bad_tz') {
        throw new EventsClientError(422, 'bad_tz', 'invalid timezone')
      }
      if (r.kind === 'bad_date') {
        throw new EventsClientError(422, 'bad_date', 'invalid date')
      }
      return r.data as unknown as ForecastResponse
    },

    async uploadTicket(opts): Promise<PersonalTicketDto> {
      const bytes = await opts.file.arrayBuffer()
      const r = (await binding.createPersonalTicket(opts.actor, opts.eventId, {
        contentType: opts.contentType,
        bytes,
        ...(opts.fileName !== undefined ? { fileName: opts.fileName } : {}),
      })) as RpcReturn<EventsRPC['createPersonalTicket']>
      if (r.kind === 'not_found') throw notFound('Personal event not found.')
      if (r.kind === 'bad_file') {
        throw new EventsClientError(422, 'bad_file', `Bad file: ${r.reason}.`)
      }
      return r.data as unknown as PersonalTicketDto
    },
    async listTickets(opts): Promise<PersonalTicketDto[]> {
      const r = (await binding.listPersonalTickets(opts.actor, opts.eventId)) as RpcReturn<
        EventsRPC['listPersonalTickets']
      >
      if (r.kind === 'not_found') throw notFound('Personal event not found.')
      return r.data as unknown as PersonalTicketDto[]
    },
    async downloadTicket(opts): Promise<Response> {
      const r = (await binding.downloadPersonalTicket(
        opts.actor,
        opts.eventId,
        opts.ticketId,
      )) as RpcReturn<EventsRPC['downloadPersonalTicket']>
      if (r.kind === 'not_found') throw notFound('Personal event not found.')
      if (r.kind === 'ticket_not_found') throw notFound('Ticket not found.')
      const headers = new Headers({
        'Content-Type': r.data.contentType,
        ...(r.data.contentLength !== null
          ? { 'Content-Length': String(r.data.contentLength) }
          : {}),
      })
      return new Response(r.data.body, { status: 200, headers })
    },
  }
}

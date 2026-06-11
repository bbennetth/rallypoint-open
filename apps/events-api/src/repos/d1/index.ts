import type { Repos } from '../types.js'
import { type Db, createDb } from './db.js'
import { D1EventRepo } from './events.js'
import { D1EventMemberRepo } from './event-members.js'
import { D1EventInviteRepo } from './event-invites.js'
import { D1EventAttendeeRepo } from './event-attendees.js'
import { D1EventTicketRepo } from './event-tickets.js'
import { D1EventActivityRepo } from './event-activity.js'
import { D1EventPurgeLogRepo } from './event-purge-log.js'
import { D1EventStageRepo } from './event-stages.js'
import { D1EventDayRepo } from './event-days.js'
import { D1ArtistRepo } from './artists.js'
import { D1EventArtistRepo } from './event-artists.js'
import { D1EventSessionRepo } from './event-sessions.js'
import { D1EventsSessionRepo } from './sessions.js'
import { D1EventMapRepo } from './event-maps.js'
import { D1EventPoiRepo } from './event-pois.js'
import { D1EventNoGoZoneRepo } from './event-no-go-zones.js'
import { D1GroupRepo } from './groups.js'
import { D1GroupMemberRepo } from './group-members.js'
import { D1GroupInviteRepo } from './group-invites.js'
import { D1RallyRepo } from './rallies.js'
import { D1RallyAttendeeRepo } from './rally-attendees.js'
import { D1ChatMessageRepo } from './chat-messages.js'
import { D1EventWeatherRepo } from './event-weather.js'
import { D1EventSetStarRepo } from './event-set-stars.js'
import { D1EventSnapshotRepo } from './event-snapshots.js'
import { D1PersonalTicketRepo } from './personal-tickets.js'
import { D1EventPlannerPrefRepo } from './event-planner-prefs.js'
import { D1RateLimitRepo } from './rate-limit.js'

export function buildD1Repos(db: Db): Repos {
  return {
    events: new D1EventRepo(db),
    members: new D1EventMemberRepo(db),
    invites: new D1EventInviteRepo(db),
    attendees: new D1EventAttendeeRepo(db),
    tickets: new D1EventTicketRepo(db),
    activity: new D1EventActivityRepo(db),
    purgeLog: new D1EventPurgeLogRepo(db),
    stages: new D1EventStageRepo(db),
    days: new D1EventDayRepo(db),
    artists: new D1ArtistRepo(db),
    eventArtists: new D1EventArtistRepo(db),
    eventSessions: new D1EventSessionRepo(db),
    sessions: new D1EventsSessionRepo(db),
    maps: new D1EventMapRepo(db),
    pois: new D1EventPoiRepo(db),
    noGoZones: new D1EventNoGoZoneRepo(db),
    groups: new D1GroupRepo(db),
    groupMembers: new D1GroupMemberRepo(db),
    groupInvites: new D1GroupInviteRepo(db),
    rallies: new D1RallyRepo(db),
    rallyAttendees: new D1RallyAttendeeRepo(db),
    chatMessages: new D1ChatMessageRepo(db),
    eventWeather: new D1EventWeatherRepo(db),
    eventSetStars: new D1EventSetStarRepo(db),
    eventSnapshots: new D1EventSnapshotRepo(db),
    personalTickets: new D1PersonalTicketRepo(db),
    eventPlannerPrefs: new D1EventPlannerPrefRepo(db),
    rateLimit: new D1RateLimitRepo(db),
  }
}

export { createDb }
export type { Db }

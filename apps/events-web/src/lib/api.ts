// Typed events-api client. The CSRF/transport machinery now lives in
// @rallypoint/web-kit's createCsrfClient (byte-identical across events
// and lists before extraction); this module keeps the events-specific
// typed DTO layer on top of it. All calls go through the Vite dev proxy
// (and the production reverse proxy) at /api/v1/ui/*, always with
// credentials:'include' so the session + CSRF cookies ride along.
// State-changing requests bootstrap a CSRF token (GET /csrf) and echo
// it in X-RP-CSRF — the double-submit half the server checks.

import { ApiError, createCsrfClient, resetAnalytics } from '@rallypoint/web-kit'
import type { SessionProfile } from '@rallypoint/web-kit'
import { hydrateThemeFromServer } from '@rallypoint/ui'

export type { SessionProfile }

export { ApiError }

const client = createCsrfClient({ basePath: '/api/v1/ui' })
const request = client.request

export type PrivacyMode = 'public' | 'unlisted' | 'private'
export type MemberRole = 'owner' | 'editor' | 'viewer'

// Per-event feature toggles (#216). The API always returns the fully
// resolved object (defaults merged server-side).
export interface EventFeatures {
  lineup: boolean
  sessions: boolean
  groups: boolean
  attendees: boolean
}
export type AssignableRole = 'editor' | 'viewer'

export interface EventDto {
  id: string
  slug: string
  name: string
  description: string | null
  start_date: string | null
  end_date: string | null
  timezone: string
  location_label: string | null
  location_lat: number | null
  location_lng: number | null
  privacy_mode: PrivacyMode
  public_page_config: PublicPageConfigInput | null
  features: EventFeatures
  owner_user_id: string
  // 'personal' | 'group' — discriminates festival events from personal ones.
  scope_type: string
  viewer_role: MemberRole
  // #440: the caller's group in this event (first joined), or null.
  // Drives viewer-role routing into the group attendee shell.
  my_group_id: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export interface EventListPage {
  items: EventDto[]
  next_cursor: string | null
}

export interface CreateEventInput {
  name: string
  timezone: string
  description?: string
  startDate?: string
  endDate?: string
  locationLabel?: string
  locationLat?: number
  locationLng?: number
  privacyMode?: PrivacyMode
}

export type PatchEventInput = Partial<CreateEventInput> & {
  // Owner-curated public page config (slice 11). Snake_case matches
  // the persisted jsonb shape; the API echoes it verbatim.
  publicPageConfig?: PublicPageConfigInput | null
  // Partial feature-toggle patch (#216); owner-only server-side.
  features?: Partial<EventFeatures>
}

// Mirror of @rallypoint/events-shared.PublicPageConfigSchema. Kept
// here as a local type to avoid a workspace dep; the server validates.
export interface PublicPageConfigInput {
  enabled: boolean
  theme?: {
    accent_color?: string
    background_image_key?: string
  }
  sections?: Array<
    | { kind: 'description' }
    | { kind: 'lineup'; limit_to_tier?: 'headliner' | 'support' }
    | { kind: 'sessions'; day_id?: string }
    | { kind: 'map'; layer: 'site' | 'camp' | 'full' }
    | { kind: 'rsvp_link'; url: string }
  >
  hidden_fields?: Array<'lineup' | 'sessions' | 'map' | 'description' | 'dates' | 'location_label'>
}

export interface InviteDto {
  id: string
  code: string
  role: AssignableRole
  invited_email: string | null
  expires_at: string
}

// --- session / SSO --------------------------------------------------

export interface SessionDto {
  user_id: string
  // The shared cross-app settings doc folded in by the BFF. Theme keys
  // (themeMode/themeColor) hydrate the store on load; other keys are
  // opaque to the client.
  settings?: Record<string, unknown>
  // The signed-in user's RPID profile (avatar + name) folded in by the
  // BFF for the user bar; `null`/absent when the fold-in degraded.
  profile?: SessionProfile | null
}

export async function getSession(): Promise<SessionDto> {
  const session = await request<SessionDto>('GET', '/api/v1/ui/session')
  // Side-effect: apply the server's theme before the first authed render
  // so the preference follows the user across devices/apps. Does not echo
  // a write back (hydrateThemeFromServer suppresses the persister).
  if (session.settings) {
    hydrateThemeFromServer({
      mode: session.settings.themeMode,
      color: session.settings.themeColor,
    })
  }
  return session
}

// Persist a shallow patch into a settings namespace (a `null`-valued key
// deletes it). Used by the theme persister (registered in main.tsx) and
// the Settings page. Returns the merged doc.
export async function updateSettings(
  namespace: string,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await request<{ settings: Record<string, unknown> }>(
    'PATCH',
    `/api/v1/ui/settings/${encodeURIComponent(namespace)}`,
    patch,
  )
  return res.settings
}

export async function exchangeSso(code: string, state: string): Promise<void> {
  await request<void>('POST', '/api/v1/ui/sso/exchange', { code, state })
}

export async function signout(): Promise<void> {
  await request<void>('POST', '/api/v1/ui/signout')
  resetAnalytics()
}

// --- events ---------------------------------------------------------

export async function createEvent(input: CreateEventInput): Promise<EventDto> {
  return request<EventDto>('POST', '/api/v1/ui/events', input)
}

export async function listEvents(opts?: {
  includeDeleted?: boolean
  cursor?: string
  limit?: number
}): Promise<EventListPage> {
  const q = new URLSearchParams()
  if (opts?.includeDeleted) q.set('include', 'deleted')
  if (opts?.cursor) q.set('cursor', opts.cursor)
  if (opts?.limit) q.set('limit', String(opts.limit))
  const qs = q.toString()
  return request<EventListPage>('GET', `/api/v1/ui/events${qs ? `?${qs}` : ''}`)
}

export async function getEvent(slug: string): Promise<EventDto> {
  return request<EventDto>('GET', `/api/v1/ui/events/${encodeURIComponent(slug)}`)
}

export async function patchEvent(id: string, fields: PatchEventInput): Promise<EventDto> {
  return request<EventDto>('PATCH', `/api/v1/ui/events/${encodeURIComponent(id)}`, fields)
}

export async function deleteEvent(id: string): Promise<void> {
  await request<void>('DELETE', `/api/v1/ui/events/${encodeURIComponent(id)}`)
}

export async function restoreEvent(id: string): Promise<EventDto> {
  return request<EventDto>('POST', `/api/v1/ui/events/${encodeURIComponent(id)}/restore`)
}

export async function transferOwnership(
  id: string,
  input: { newOwnerUserId: string; currentPassword: string },
): Promise<EventDto> {
  return request<EventDto>('POST', `/api/v1/ui/events/${encodeURIComponent(id)}/transfer`, input)
}

export async function createInvite(
  id: string,
  input: { role: AssignableRole; invitedEmail?: string },
): Promise<InviteDto> {
  return request<InviteDto>('POST', `/api/v1/ui/events/${encodeURIComponent(id)}/invites`, input)
}

export async function acceptInvite(code: string): Promise<{ event_slug: string; role: MemberRole }> {
  return request<{ event_slug: string; role: MemberRole }>(
    'POST',
    '/api/v1/ui/invites/accept',
    { code },
  )
}

// --- attendees + pending invites (Phase 0) ---------------------------

export interface AttendeeDto {
  user_id: string
  email: string | null
  display_name: string | null
  joined_at: string
  role: MemberRole | null
}

export interface AttendeesPage {
  items: AttendeeDto[]
  next_cursor: string | null
}

export async function listEventAttendees(
  eventId: string,
  opts?: { cursor?: string; limit?: number },
): Promise<AttendeesPage> {
  const q = new URLSearchParams()
  if (opts?.cursor) q.set('cursor', opts.cursor)
  if (opts?.limit) q.set('limit', String(opts.limit))
  const qs = q.toString()
  return request<AttendeesPage>(
    'GET',
    `/api/v1/ui/events/${encodeURIComponent(eventId)}/attendees${qs ? `?${qs}` : ''}`,
  )
}

// "Who's going" (#216): attendee-visible roster, display names only.
// Two access paths — event membership (solo attendees) or group
// membership (group-joined attendees). Both 404 when the event's
// `attendees` feature is off.
export interface CommunityAttendeeDto {
  user_id: string
  display_name: string | null
  joined_at: string
}

export async function listCommunityAttendees(
  eventId: string,
): Promise<{ items: CommunityAttendeeDto[]; next_cursor: string | null }> {
  return request<{ items: CommunityAttendeeDto[]; next_cursor: string | null }>(
    'GET',
    `/api/v1/ui/events/${encodeURIComponent(eventId)}/attendees/community?limit=200`,
  )
}

export async function listGroupAttendees(
  groupId: string,
): Promise<{ items: CommunityAttendeeDto[] }> {
  return request<{ items: CommunityAttendeeDto[] }>(
    'GET',
    `/api/v1/ui/groups/${encodeURIComponent(groupId)}/attendees`,
  )
}

export async function removeEventAttendee(
  eventId: string,
  userId: string,
): Promise<void> {
  await request<void>(
    'DELETE',
    `/api/v1/ui/events/${encodeURIComponent(eventId)}/attendees/${encodeURIComponent(userId)}`,
  )
}

// URL for the CSV export endpoint. The browser navigates directly so
// the session cookie auths the request; CSRF is GET-exempt.
export function eventAttendeesCsvUrl(eventId: string): string {
  return `/api/v1/ui/events/${encodeURIComponent(eventId)}/attendees.csv`
}

export interface PendingInviteDto {
  id: string
  invited_email: string | null
  role: MemberRole
  created_at: string
  expires_at: string
}

export async function listEventInvites(eventId: string): Promise<{ items: PendingInviteDto[] }> {
  return request<{ items: PendingInviteDto[] }>(
    'GET',
    `/api/v1/ui/events/${encodeURIComponent(eventId)}/invites`,
  )
}

export interface BulkInviteResult {
  created: Array<{ email: string; code: string; id: string; expires_at: string }>
}

export async function bulkCreateInvites(
  eventId: string,
  input: { emails: string[]; role?: AssignableRole },
): Promise<BulkInviteResult> {
  return request<BulkInviteResult>(
    'POST',
    `/api/v1/ui/events/${encodeURIComponent(eventId)}/invites/bulk`,
    input,
  )
}

export async function revokeEventInvite(
  eventId: string,
  inviteId: string,
): Promise<void> {
  await request<void>(
    'DELETE',
    `/api/v1/ui/events/${encodeURIComponent(eventId)}/invites/${encodeURIComponent(inviteId)}`,
  )
}

// --- tickets (Phase T) -----------------------------------------------

export interface TicketDto {
  id: string
  event_id: string
  name: string
  description: string | null
  price_cents: number
  quantity: number | null
  sold_count: number
  sort_order: number
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export interface CreateTicketInput {
  name: string
  description?: string | null
  priceCents: number
  quantity?: number | null
  sortOrder?: number
}

export type PatchTicketInput = Partial<CreateTicketInput>

export async function listEventTickets(eventId: string): Promise<{ items: TicketDto[] }> {
  return request<{ items: TicketDto[] }>(
    'GET',
    `/api/v1/ui/events/${encodeURIComponent(eventId)}/tickets`,
  )
}

export async function createEventTicket(
  eventId: string,
  input: CreateTicketInput,
): Promise<TicketDto> {
  return request<TicketDto>(
    'POST',
    `/api/v1/ui/events/${encodeURIComponent(eventId)}/tickets`,
    input,
  )
}

export async function patchEventTicket(
  eventId: string,
  ticketId: string,
  input: PatchTicketInput,
): Promise<TicketDto> {
  return request<TicketDto>(
    'PATCH',
    `/api/v1/ui/events/${encodeURIComponent(eventId)}/tickets/${encodeURIComponent(ticketId)}`,
    input,
  )
}

export async function deleteEventTicket(eventId: string, ticketId: string): Promise<void> {
  await request<void>(
    'DELETE',
    `/api/v1/ui/events/${encodeURIComponent(eventId)}/tickets/${encodeURIComponent(ticketId)}`,
  )
}

export async function restoreEventTicket(eventId: string, ticketId: string): Promise<TicketDto> {
  return request<TicketDto>(
    'POST',
    `/api/v1/ui/events/${encodeURIComponent(eventId)}/tickets/${encodeURIComponent(ticketId)}/restore`,
  )
}

// --- groups + members + invites (slice 6) ----------------------------

export type GroupRole = 'owner' | 'sidekick' | 'member'
export type AssignableGroupRole = 'sidekick' | 'member'

export interface GroupDto {
  id: string
  event_id: string
  name: string
  description: string | null
  start_date: string | null
  end_date: string | null
  owner_user_id: string
  // null in the event-scoped list when the viewer is not a group member
  // (an event viewer/editor browsing groups they haven't joined).
  viewer_role: GroupRole | null
  member_count?: number
  created_at: string
  updated_at: string
}

export interface GroupMemberDto {
  id: string
  user_id: string
  role: GroupRole
  joined_at: string
}

export interface GroupDetailDto extends GroupDto {
  // #440: 6-char re-showable join code (lazily backfilled server-side).
  short_code: string | null
  members: GroupMemberDto[]
}

// The join_code is only present on the create response (it leaves the
// API exactly once).
export interface CreateGroupResult extends GroupDto {
  short_code: string | null
  join_code: string
}

export interface GroupInviteResult {
  id: string
  code: string
  invited_email: string | null
  expires_at: string
}

export interface CreateGroupInput {
  name: string
  description?: string
  startDate?: string
  endDate?: string
}

export type PatchGroupInput = Partial<CreateGroupInput>

export async function listGroups(eventId: string): Promise<GroupDto[]> {
  return (await request<{ items: GroupDto[] }>('GET', `/api/v1/ui/events/${ev(eventId)}/groups`)).items
}
export async function createGroup(eventId: string, input: CreateGroupInput): Promise<CreateGroupResult> {
  return request<CreateGroupResult>('POST', `/api/v1/ui/events/${ev(eventId)}/groups`, input)
}
export async function getGroup(groupId: string): Promise<GroupDetailDto> {
  return request<GroupDetailDto>('GET', `/api/v1/ui/groups/${ev(groupId)}`)
}
export async function patchGroup(groupId: string, fields: PatchGroupInput): Promise<GroupDto> {
  return request<GroupDto>('PATCH', `/api/v1/ui/groups/${ev(groupId)}`, fields)
}
export async function deleteGroup(groupId: string): Promise<void> {
  await request<void>('DELETE', `/api/v1/ui/groups/${ev(groupId)}`)
}
export async function createGroupInvite(
  groupId: string,
  input: { invitedEmail?: string },
): Promise<GroupInviteResult> {
  return request<GroupInviteResult>('POST', `/api/v1/ui/groups/${ev(groupId)}/invites`, input)
}
export interface GroupJoinPreviewDto {
  group_id: string
  name: string
  member_count: number
  event_name: string
  you_are_member: boolean
}

// Resolve a join code (6-char or rpj_) to a preview without joining.
export async function previewGroupJoin(code: string): Promise<GroupJoinPreviewDto> {
  return request<GroupJoinPreviewDto>(
    'GET',
    `/api/v1/ui/groups/join/preview?code=${encodeURIComponent(code)}`,
  )
}

export async function joinGroup(code: string): Promise<{ group_id: string; role: GroupRole }> {
  return request<{ group_id: string; role: GroupRole }>('POST', '/api/v1/ui/groups/join', { code })
}
export async function transferGroup(groupId: string, newOwnerUserId: string): Promise<GroupDto> {
  return request<GroupDto>('POST', `/api/v1/ui/groups/${ev(groupId)}/transfer`, { newOwnerUserId })
}
export async function setGroupRole(
  groupId: string,
  userId: string,
  role: AssignableGroupRole,
): Promise<{ user_id: string; role: GroupRole }> {
  return request<{ user_id: string; role: GroupRole }>(
    'POST',
    `/api/v1/ui/groups/${ev(groupId)}/members/${ev(userId)}/role`,
    { role },
  )
}
export async function removeGroupMember(groupId: string, userId: string): Promise<void> {
  await request<void>('DELETE', `/api/v1/ui/groups/${ev(groupId)}/members/${ev(userId)}`)
}

// --- group lists (BFF proxy to lists-api, #84) -----------------------
// Read-only view of the Lists app's group-scoped lists. camelCase, unlike
// the snake_case Events DTOs above — these pass straight through from
// @rallypoint/lists-client's ListDto, which lists-api already publishes.
export type GroupListType = 'tasks' | 'standard'

export interface GroupListDto {
  id: string
  scopeType: 'group'
  scopeId: string
  listType: GroupListType
  name: string
  visibility: 'all' | 'private'
  color: string | null
  createdBy: string
  createdAt: string
  updatedAt: string
}

export async function listGroupLists(groupId: string): Promise<GroupListDto[]> {
  return (await request<{ items: GroupListDto[] }>('GET', `/api/v1/ui/groups/${ev(groupId)}/lists`)).items
}

// A list's items (tasks). camelCase, straight from @rallypoint/lists-client's
// ListItemDto. Reached through the group BFF, which confirms the list belongs
// to the group scope before proxying (confused-deputy guard).
export type ListItemStatus = 'todo' | 'in_progress' | 'done'
export type ListItemPriority = 'low' | 'medium' | 'high'

export interface ListItemDto {
  id: string
  listId: string
  title: string
  notes: string | null
  assignedTo: string | null
  completed: boolean
  completedAt: string | null
  status: ListItemStatus | null
  priority: ListItemPriority | null
  dueDate: string | null
  position: number
  // v2 typed values keyed by field-def id; My Day ignores them but the
  // proxied shape carries them so the type doesn't drop a field.
  customFields: Record<string, unknown>
  createdBy: string
  createdAt: string
  updatedAt: string
}

export async function listGroupListItems(
  groupId: string,
  listId: string,
): Promise<ListItemDto[]> {
  return (
    await request<{ items: ListItemDto[] }>(
      'GET',
      `/api/v1/ui/groups/${ev(groupId)}/lists/${ev(listId)}/items`,
    )
  ).items
}

// --- group ledger (slice 11) -----------------------------------------
// Read-only window into the Money app's per-group ledger. The DTO is
// the flat camelCase shape money-api emits on /sdk/money/ledgers;
// events-api proxies it verbatim through the /api/v1/ui/groups/:id/ledger
// BFF route, which also lazy-heals a missing ledger.
export interface GroupLedgerDto {
  id: string
  scopeType: 'group' | 'ledger_group' | 'personal'
  scopeId: string
  ownerUserId: string
  name: string
  currency: string
  description: string | null
  createdAt: string
  updatedAt: string
}

export async function getGroupLedger(groupId: string): Promise<GroupLedgerDto> {
  return request<GroupLedgerDto>('GET', `/api/v1/ui/groups/${ev(groupId)}/ledger`)
}

export interface GroupLedgerSplitDto {
  userId: string
  amountCents: number | null
  shareWeight: number | null
}

export interface GroupLedgerExpenseDto {
  id: string
  ledgerId: string
  paidByUserId: string
  totalCents: number
  description: string
  splitMode: 'equal' | 'by_share' | 'by_amount'
  categoryId: string | null
  ref: string | null
  spentAt: string
  createdAt: string
  updatedAt: string
  splits: GroupLedgerSplitDto[]
}

export async function listGroupLedgerExpenses(
  groupId: string,
): Promise<GroupLedgerExpenseDto[]> {
  return (
    await request<{ items: GroupLedgerExpenseDto[] }>(
      'GET',
      `/api/v1/ui/groups/${ev(groupId)}/ledger/expenses`,
    )
  ).items
}

// Balance projection: items[].net_cents is signed in the viewer's POV
// (positive = that user owes the viewer; negative = viewer owes them).
// When no ledger exists yet (during a money-api outage on first group
// access), ledger_id / currency may be null and items is [].
export interface GroupLedgerBalanceItemDto {
  user_id: string
  net_cents: number
}

export interface GroupLedgerBalancesDto {
  ledger_id: string | null
  currency: string | null
  viewer_user_id: string
  items: GroupLedgerBalanceItemDto[]
}

export async function getGroupLedgerBalances(
  groupId: string,
): Promise<GroupLedgerBalancesDto> {
  return request<GroupLedgerBalancesDto>(
    'GET',
    `/api/v1/ui/groups/${ev(groupId)}/ledger/balances`,
  )
}

// --- rallies (slice 9b) ---------------------------------------------
// A group's planned meet-ups within an event. snake_case, matching the
// events-api serializer. Writes need group sidekick+, reads need member,
// RSVP is a per-member self-action.
export type RallyStatus = 'proposed' | 'active' | 'cancelled'
export type RallyRsvpStatus = 'going' | 'maybe' | 'out'

export interface RallyAttendeeDto {
  id: string
  user_id: string
  status: RallyRsvpStatus
  responded_at: string
}

export interface RallyDto {
  id: string
  group_id: string
  event_id: string
  title: string
  description: string | null
  day_id: string | null
  start_time: string | null
  poi_id: string | null
  location_label: string | null
  lat: string | null
  lng: string | null
  status: RallyStatus
  created_by: string
  created_at: string
  updated_at: string
  attendees: RallyAttendeeDto[]
  rsvp_summary: { going: number; maybe: number; out: number }
  viewer_rsvp: RallyRsvpStatus | null
}

export interface CreateRallyInput {
  title: string
  description?: string | null
  dayId?: string | null
  startTime?: string | null
  poiId?: string | null
  locationLabel?: string | null
  lat?: number | null
  lng?: number | null
  status?: RallyStatus
}

export type PatchRallyInput = Partial<CreateRallyInput>

export async function listRallies(groupId: string): Promise<RallyDto[]> {
  return (await request<{ items: RallyDto[] }>('GET', `/api/v1/ui/groups/${ev(groupId)}/rallies`)).items
}
export async function createRally(groupId: string, input: CreateRallyInput): Promise<RallyDto> {
  return request<RallyDto>('POST', `/api/v1/ui/groups/${ev(groupId)}/rallies`, input)
}
export async function getRally(groupId: string, rallyId: string): Promise<RallyDto> {
  return request<RallyDto>('GET', `/api/v1/ui/groups/${ev(groupId)}/rallies/${ev(rallyId)}`)
}
export async function patchRally(
  groupId: string,
  rallyId: string,
  fields: PatchRallyInput,
): Promise<RallyDto> {
  return request<RallyDto>('PATCH', `/api/v1/ui/groups/${ev(groupId)}/rallies/${ev(rallyId)}`, fields)
}
export async function deleteRally(groupId: string, rallyId: string): Promise<void> {
  await request<void>('DELETE', `/api/v1/ui/groups/${ev(groupId)}/rallies/${ev(rallyId)}`)
}
export async function rsvpRally(
  groupId: string,
  rallyId: string,
  status: RallyRsvpStatus,
): Promise<RallyDto> {
  return request<RallyDto>('PUT', `/api/v1/ui/groups/${ev(groupId)}/rallies/${ev(rallyId)}/rsvp`, {
    status,
  })
}

// --- My Day aggregator (slice 9b) -----------------------------------
// One group-scoped day: its rallies, the event's lineup sets, group tasks
// due that day, and conflicts where a task/rally lands inside a set.
export interface MyDayRally {
  id: string
  title: string
  day_id: string | null
  start_time: string | null
  poi_id: string | null
  location_label: string | null
  status: RallyStatus
}

export interface MyDaySet {
  artist_id: string
  label: string
  stage_id: string | null
  start_time: string | null
  end_time: string | null
}

export interface MyDayTask {
  id: string
  list_id: string
  title: string
  due_date: string | null
  status: ListItemStatus | null
  priority: ListItemPriority | null
  completed: boolean
}

export interface MyDayConflict {
  kind: 'task' | 'rally'
  id: string
  title: string
  sets: string[]
}

export interface GroupDayDto {
  date: string
  day: { id: string; day_label: string; date: string } | null
  rallies: MyDayRally[]
  lineup: MyDaySet[]
  tasks: MyDayTask[]
  conflicts: MyDayConflict[]
}

export async function getGroupDay(groupId: string, date: string): Promise<GroupDayDto> {
  return request<GroupDayDto>('GET', `/api/v1/ui/groups/${ev(groupId)}/day?date=${ev(date)}`)
}

// --- group chat (slice 10) -------------------------------------------
// Newest-first, cursor-paged backwards via `before`. `next_before` is the
// oldest returned id when the page was full (more may exist), else null.
export interface ChatMessageDto {
  id: string
  group_id: string
  user_id: string
  body: string
  created_at: string
}

export interface ChatPage {
  items: ChatMessageDto[]
  next_before: string | null
}

export async function listChatMessages(
  groupId: string,
  opts: { before?: string; limit?: number } = {},
): Promise<ChatPage> {
  const qs = new URLSearchParams()
  if (opts.before) qs.set('before', opts.before)
  if (opts.limit !== undefined) qs.set('limit', String(opts.limit))
  const suffix = qs.toString() ? `?${qs.toString()}` : ''
  return request<ChatPage>('GET', `/api/v1/ui/groups/${ev(groupId)}/chat${suffix}`)
}

export async function sendChatMessage(groupId: string, body: string): Promise<ChatMessageDto> {
  return request<ChatMessageDto>('POST', `/api/v1/ui/groups/${ev(groupId)}/chat`, { body })
}

// --- lineup: stages / days / artists / slots (slice 3b) -------------

export interface StageDto {
  id: string
  event_id: string
  name: string
  sort_order: number
}

export interface DayDto {
  id: string
  event_id: string
  day_label: string
  date: string
  // The day's own optional window, 'HH:MM' or null. Both null = all-day.
  start_time: string | null
  end_time: string | null
  sort_order: number
}

export interface ArtistDto {
  id: string
  name: string
  soundcloud: string | null
  spotify: string | null
  apple_music: string | null
  youtube_music: string | null
  instagram: string | null
  updated_at: string
}

export type LineupTier = 'headliner' | 'support' | 'opener'

export interface LineupSlotDto {
  event_id: string
  artist_id: string
  artist_name: string | null
  day_id: string
  stage_id: string | null
  tier: LineupTier | null
  genre: string | null
  start_time: string | null
  end_time: string | null
  display_name: string | null
}

export interface LineupSlotInput {
  artistId: string
  dayId: string
  stageId?: string | null
  tier?: LineupTier | null
  genre?: string | null
  startTime?: string | null
  endTime?: string | null
  displayName?: string | null
}

const ev = (id: string) => encodeURIComponent(id)

export async function listStages(eventId: string): Promise<StageDto[]> {
  return (await request<{ items: StageDto[] }>('GET', `/api/v1/ui/events/${ev(eventId)}/stages`)).items
}
export async function createStage(
  eventId: string,
  input: { name: string; sortOrder?: number },
): Promise<StageDto> {
  return request<StageDto>('POST', `/api/v1/ui/events/${ev(eventId)}/stages`, input)
}
export async function deleteStage(eventId: string, stageId: string): Promise<void> {
  await request<void>('DELETE', `/api/v1/ui/events/${ev(eventId)}/stages/${ev(stageId)}`)
}

export async function listDays(eventId: string): Promise<DayDto[]> {
  return (await request<{ items: DayDto[] }>('GET', `/api/v1/ui/events/${ev(eventId)}/days`)).items
}
export async function createDay(
  eventId: string,
  input: {
    dayLabel: string
    date: string
    startTime?: string | null
    endTime?: string | null
    sortOrder?: number
  },
): Promise<DayDto> {
  return request<DayDto>('POST', `/api/v1/ui/events/${ev(eventId)}/days`, input)
}
export async function updateDay(
  eventId: string,
  dayId: string,
  input: {
    dayLabel?: string
    date?: string
    startTime?: string | null
    endTime?: string | null
    sortOrder?: number
  },
): Promise<DayDto> {
  return request<DayDto>('PATCH', `/api/v1/ui/events/${ev(eventId)}/days/${ev(dayId)}`, input)
}
export async function deleteDay(eventId: string, dayId: string): Promise<void> {
  await request<void>('DELETE', `/api/v1/ui/events/${ev(eventId)}/days/${ev(dayId)}`)
}
// Quick-create days from the event's date range (or an explicit override).
// Returns only the newly-created days (already-present dates are skipped).
export async function generateDays(
  eventId: string,
  range?: { startDate?: string; endDate?: string },
): Promise<DayDto[]> {
  return (
    await request<{ items: DayDto[] }>(
      'POST',
      `/api/v1/ui/events/${ev(eventId)}/days/generate`,
      range ?? {},
    )
  ).items
}

export async function searchArtists(query: string): Promise<ArtistDto[]> {
  return (
    await request<{ items: ArtistDto[] }>('GET', `/api/v1/ui/artists?q=${encodeURIComponent(query)}`)
  ).items
}
export async function findOrCreateArtist(name: string): Promise<ArtistDto> {
  return request<ArtistDto>('POST', '/api/v1/ui/artists', { name })
}

export async function listLineup(eventId: string): Promise<LineupSlotDto[]> {
  return (await request<{ items: LineupSlotDto[] }>('GET', `/api/v1/ui/events/${ev(eventId)}/lineup`)).items
}
export async function upsertLineupSlot(
  eventId: string,
  input: LineupSlotInput,
): Promise<LineupSlotDto> {
  return request<LineupSlotDto>('POST', `/api/v1/ui/events/${ev(eventId)}/lineup`, input)
}
export async function deleteLineupSlot(
  eventId: string,
  artistId: string,
  dayId: string,
): Promise<void> {
  await request<void>(
    'DELETE',
    `/api/v1/ui/events/${ev(eventId)}/lineup/${ev(artistId)}/${ev(dayId)}`,
  )
}

export interface LineupDeleteRef {
  artistId: string
  dayId: string
}
// Atomic bulk apply for the lineup grid: upsert `slots` and remove
// `deletes` in one transaction. Returns the upserted rows.
export async function bulkApplyLineup(
  eventId: string,
  input: { slots?: LineupSlotInput[]; deletes?: LineupDeleteRef[] },
): Promise<LineupSlotDto[]> {
  return (
    await request<{ items: LineupSlotDto[] }>(
      'POST',
      `/api/v1/ui/events/${ev(eventId)}/lineup/bulk`,
      input,
    )
  ).items
}

// --- set stars (issue #194): attendee-side star/unstar lineup slots --

export interface SetStarKeyDto {
  event_id: string
  artist_id: string
  day_id: string
}

export interface SetStarResultDto extends SetStarKeyDto {
  starred: boolean
}

// Return the user's starred set keys for the given event.
export async function listStarredSets(eventId: string): Promise<SetStarKeyDto[]> {
  return (
    await request<{ items: SetStarKeyDto[] }>(
      'GET',
      `/api/v1/ui/events/${ev(eventId)}/lineup/stars`,
    )
  ).items
}

// Idempotent star. Returns the result with starred=true.
export async function starSet(
  eventId: string,
  artistId: string,
  dayId: string,
): Promise<SetStarResultDto> {
  return request<SetStarResultDto>(
    'POST',
    `/api/v1/ui/events/${ev(eventId)}/lineup/stars`,
    { artistId, dayId },
  )
}

// Unstar. Returns the result with starred=false.
export async function unstarSet(
  eventId: string,
  artistId: string,
  dayId: string,
): Promise<SetStarResultDto> {
  return request<SetStarResultDto>(
    'DELETE',
    `/api/v1/ui/events/${ev(eventId)}/lineup/stars`,
    { artistId, dayId },
  )
}

// --- sessions (activities) + approval workflow (slice 3c) -----------

export type SessionApprovalStatus = 'approved' | 'pending' | 'rejected'
export type SessionVisibility = 'admin' | 'private' | 'group' | 'custom'

export interface SessionDtoFull {
  id: string
  event_id: string
  title: string
  description: string | null
  location: string | null
  day_id: string | null
  stage_id: string | null
  start_time: string | null
  end_time: string | null
  category: string | null
  host: string | null
  approval_status: SessionApprovalStatus
  visibility: SessionVisibility
  group_id: string | null
  shared_with: string[] | null
  created_by_user_id: string
  submitted_by_user_id: string | null
  approved_by_user_id: string | null
  approved_at: string | null
  created_at: string
  updated_at: string
}

export interface CreateSessionInput {
  title: string
  description?: string
  location?: string
  dayId?: string | null
  stageId?: string | null
  startTime?: string
  endTime?: string
  category?: string
  host?: string
  visibility?: SessionVisibility
}

export type PatchSessionInput = Partial<CreateSessionInput>

export async function listSessions(
  eventId: string,
  opts?: { approvalStatus?: SessionApprovalStatus; dayId?: string },
): Promise<SessionDtoFull[]> {
  const q = new URLSearchParams()
  if (opts?.approvalStatus) q.set('approval_status', opts.approvalStatus)
  if (opts?.dayId) q.set('day_id', opts.dayId)
  const qs = q.toString()
  return (
    await request<{ items: SessionDtoFull[] }>(
      'GET',
      `/api/v1/ui/events/${ev(eventId)}/sessions${qs ? `?${qs}` : ''}`,
    )
  ).items
}
export async function createSession(
  eventId: string,
  input: CreateSessionInput,
): Promise<SessionDtoFull> {
  return request<SessionDtoFull>('POST', `/api/v1/ui/events/${ev(eventId)}/sessions`, input)
}
export async function patchSession(
  eventId: string,
  sessionId: string,
  input: PatchSessionInput,
): Promise<SessionDtoFull> {
  return request<SessionDtoFull>(
    'PATCH',
    `/api/v1/ui/events/${ev(eventId)}/sessions/${ev(sessionId)}`,
    input,
  )
}
export async function deleteSession(eventId: string, sessionId: string): Promise<void> {
  await request<void>('DELETE', `/api/v1/ui/events/${ev(eventId)}/sessions/${ev(sessionId)}`)
}
export async function setSessionApproval(
  eventId: string,
  sessionId: string,
  action: 'submit' | 'approve' | 'reject',
): Promise<SessionDtoFull> {
  return request<SessionDtoFull>(
    'POST',
    `/api/v1/ui/events/${ev(eventId)}/sessions/${ev(sessionId)}/${action}`,
  )
}

export interface BulkSessionCreate {
  title: string
  description?: string | null
  location?: string | null
  dayId?: string | null
  stageId?: string | null
  startTime?: string | null
  endTime?: string | null
  category?: string | null
  host?: string | null
  visibility?: SessionVisibility
}

export interface BulkSessionUpdate {
  id: string
  patch: Partial<BulkSessionCreate>
}

export interface BulkSessionsInput {
  creates?: BulkSessionCreate[]
  updates?: BulkSessionUpdate[]
  deletes?: string[]
}

export async function bulkApplySessions(
  eventId: string,
  input: BulkSessionsInput,
): Promise<{ items: SessionDtoFull[] }> {
  return request<{ items: SessionDtoFull[] }>(
    'POST',
    `/api/v1/ui/events/${ev(eventId)}/sessions/bulk`,
    input,
  )
}

// --- snapshots / version history (issue #191 Phase 2) ---------------

export type SnapshotKind = 'lineup' | 'sessions'

export interface SnapshotDto {
  id: string
  event_id: string
  kind: SnapshotKind
  reason: string
  item_count: number
  created_by_user_id: string
  created_at: string
}

// Newest-first version history for an event's lineup or sessions.
export async function listSnapshots(
  eventId: string,
  kind: SnapshotKind,
): Promise<SnapshotDto[]> {
  return (
    await request<{ items: SnapshotDto[] }>(
      'GET',
      `/api/v1/ui/events/${ev(eventId)}/snapshots?kind=${kind}`,
    )
  ).items
}

// Restore a snapshot non-destructively (captures the pre-restore state
// first, so the restore is itself undoable).
export async function restoreSnapshot(
  eventId: string,
  snapshotId: string,
): Promise<{ restored: string; kind: SnapshotKind }> {
  return request<{ restored: string; kind: SnapshotKind }>(
    'POST',
    `/api/v1/ui/events/${ev(eventId)}/snapshots/${ev(snapshotId)}/restore`,
  )
}

// --- maps / POIs / no-go zones (slice 5) ----------------------------

export type MapLayer = 'site' | 'camp' | 'full'

export interface MapDto {
  id: string
  event_id: string
  layer: MapLayer
  // object_key is only present on editor-facing responses (POST bind).
  // The viewer-facing GET /maps omits it to avoid bucket-path enumeration.
  object_key?: string
  content_type: string
  bytes: number
  width_px: number
  height_px: number
  uploaded_by_user_id: string
  uploaded_at: string
}

export interface PoiDto {
  id: string
  event_id: string
  map_id: string | null
  category_id: string
  name: string
  description: string | null
  // Postgres `numeric` columns serialize to string over the wire; we
  // normalize to number at this fetch boundary so all callers see a
  // consistent numeric type (matching MapDto.bytes, ZoneVertex, etc.).
  x_pct: number
  y_pct: number
  lat: string | null
  lng: string | null
  sort_order: number
  created_at: string
  updated_at: string
}

// Normalize Postgres numeric string fields to JS numbers so the rest of
// the app sees a consistent numeric surface for all coordinate fields.
function normalizePoiDto(raw: Record<string, unknown>): PoiDto {
  return {
    ...(raw as PoiDto),
    x_pct: Number(raw['x_pct']),
    y_pct: Number(raw['y_pct']),
  }
}

export interface ZoneVertex {
  xPct: number
  yPct: number
}

export interface ZoneDto {
  id: string
  event_id: string
  map_id: string
  polygon: ZoneVertex[]
}

// Single same-origin map upload (#409): POST multipart/form-data to the
// Worker, which validates inline and streams bytes into R2. No presigned URL,
// no cross-origin PUT, no two-step presign+bind. The CSRF token is fetched
// separately because `request<T>()` only handles JSON bodies.
export async function uploadMap(
  eventId: string,
  input: { file: File; layer: MapLayer; widthPx: number; heightPx: number },
): Promise<MapDto> {
  // Ensure we have a current CSRF token. fetchCsrf() fetches a fresh one
  // so we never read a stale cache here.
  const csrfToken = await client.fetchCsrf()

  const formData = new FormData()
  formData.append('file', input.file)
  formData.append('layer', input.layer)
  formData.append('widthPx', String(input.widthPx))
  formData.append('heightPx', String(input.heightPx))

  const res = await fetch(`/api/v1/ui/events/${ev(eventId)}/maps`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'X-RP-CSRF': csrfToken,
    },
    credentials: 'include',
    body: formData,
  })

  if (!res.ok) {
    let errCode = 'upload_failed'
    let errMsg = `Upload failed (${res.status}).`
    try {
      const err = (await res.json()) as { error?: { code?: string; message?: string } }
      if (err.error?.code) errCode = err.error.code
      if (err.error?.message) errMsg = err.error.message
    } catch {
      // ignore JSON parse failure
    }
    throw new ApiError(errCode, errMsg, res.status)
  }

  return (await res.json()) as MapDto
}

export async function listMaps(eventId: string): Promise<MapDto[]> {
  return (await request<{ items: MapDto[] }>('GET', `/api/v1/ui/events/${ev(eventId)}/maps`)).items
}

export async function deleteMap(eventId: string, mapId: string): Promise<void> {
  await request<void>('DELETE', `/api/v1/ui/events/${ev(eventId)}/maps/${ev(mapId)}`)
}

export interface CreatePoiInput {
  categoryId: string
  name: string
  description?: string | null
  mapId?: string | null
  xPct: number
  yPct: number
  lat?: number | null
  lng?: number | null
  sortOrder?: number
}

export type PatchPoiInput = Partial<CreatePoiInput>

export async function listPois(eventId: string): Promise<PoiDto[]> {
  const { items } = await request<{ items: Record<string, unknown>[] }>(
    'GET',
    `/api/v1/ui/events/${ev(eventId)}/pois`,
  )
  return items.map(normalizePoiDto)
}
export async function createPoi(eventId: string, input: CreatePoiInput): Promise<PoiDto> {
  return normalizePoiDto(await request<Record<string, unknown>>('POST', `/api/v1/ui/events/${ev(eventId)}/pois`, input))
}
export async function patchPoi(
  eventId: string,
  poiId: string,
  input: PatchPoiInput,
): Promise<PoiDto> {
  return normalizePoiDto(await request<Record<string, unknown>>('PATCH', `/api/v1/ui/events/${ev(eventId)}/pois/${ev(poiId)}`, input))
}
export async function deletePoi(eventId: string, poiId: string): Promise<void> {
  await request<void>('DELETE', `/api/v1/ui/events/${ev(eventId)}/pois/${ev(poiId)}`)
}

export async function listZones(eventId: string): Promise<ZoneDto[]> {
  return (await request<{ items: ZoneDto[] }>('GET', `/api/v1/ui/events/${ev(eventId)}/zones`)).items
}
export async function createZone(
  eventId: string,
  input: { mapId: string; polygon: ZoneVertex[] },
): Promise<ZoneDto> {
  return request<ZoneDto>('POST', `/api/v1/ui/events/${ev(eventId)}/zones`, input)
}
export async function patchZone(
  eventId: string,
  zoneId: string,
  input: { polygon: ZoneVertex[] },
): Promise<ZoneDto> {
  return request<ZoneDto>('PATCH', `/api/v1/ui/events/${ev(eventId)}/zones/${ev(zoneId)}`, input)
}
export async function deleteZone(eventId: string, zoneId: string): Promise<void> {
  await request<void>('DELETE', `/api/v1/ui/events/${ev(eventId)}/zones/${ev(zoneId)}`)
}

// --- public event page (slice 11) ----------------------------------
// Truly public, cookieless. No session, no CSRF. The DTO mirrors
// apps/events-api/src/routes/sdk-events.ts serializePublicEventDto.
// On 404 we throw an `ApiError` with status 404 — the public page
// component renders an empty state for that case (event hidden /
// disabled / nonexistent).

export interface PublicEventSection {
  kind: 'description' | 'lineup' | 'sessions' | 'map' | 'rsvp_link'
  // Per-kind extras returned by the server.
  layer?: 'site' | 'camp' | 'full'
  imageUrl?: string | null
  url?: string
  limitToTier?: 'headliner' | 'support'
  dayId?: string
}

export interface PublicEventDto {
  id: string
  slug: string
  name: string
  description: string | null
  startDate: string | null
  endDate: string | null
  timezone: string
  locationLabel: string | null
  theme: {
    accentColor: string | null
    backgroundImageUrl: string | null
  }
  sections: PublicEventSection[]
  privacyMode: PrivacyMode
}

export interface PublicLineupArtistDto {
  id: string
  name: string
  spotify: string | null
  soundcloud: string | null
  appleMusic: string | null
  youtubeMusic: string | null
  instagram: string | null
}

export interface PublicLineupStageDto {
  id: string
  eventId: string
  name: string
  sortOrder: number
}

export interface PublicLineupDayDto {
  id: string
  eventId: string
  dayLabel: string
  date: string
  sortOrder: number
}

export interface PublicLineupEventArtistDto {
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

export interface PublicLineupDto {
  stages: PublicLineupStageDto[]
  days: PublicLineupDayDto[]
  artists: PublicLineupArtistDto[]
  eventArtists: PublicLineupEventArtistDto[]
}

export interface PublicSessionDto {
  id: string
  eventId: string
  title: string
  description: string | null
  dayId: string | null
  startTime: string | null
  endTime: string | null
  category: string | null
  location: string | null
  host: string | null
}

async function publicFetch<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: 'omit', headers: { accept: 'application/json' } })
  const text = await res.text()
  const json: unknown = text ? JSON.parse(text) : {}
  if (!res.ok) {
    const envBody = (json as { error?: { code?: string; message?: string } }).error
    throw new ApiError(
      envBody?.code ?? 'unknown_error',
      envBody?.message ?? `Request failed with status ${res.status}`,
      res.status,
    )
  }
  return json as T
}

export async function getPublicEvent(slug: string): Promise<PublicEventDto> {
  return publicFetch<PublicEventDto>(`/api/v1/sdk/events/${ev(slug)}`)
}

export async function getPublicEventLineup(slug: string): Promise<PublicLineupDto> {
  return publicFetch<PublicLineupDto>(`/api/v1/sdk/events/${ev(slug)}/lineup`)
}

export async function getPublicEventSessions(
  slug: string,
  opts?: { dayId?: string },
): Promise<PublicSessionDto[]> {
  const qs = opts?.dayId ? `?day_id=${encodeURIComponent(opts.dayId)}` : ''
  const res = await publicFetch<{ items: PublicSessionDto[] }>(
    `/api/v1/sdk/events/${ev(slug)}/sessions${qs}`,
  )
  return res.items
}

// --- weather (slice 12) -------------------------------------------
// Shared DTO between the public + internal endpoints. The fetchedAt
// + isStale flags let the UI render a "last updated" hint and
// optionally re-poll when the cache is mid-refresh.

export interface WeatherForecastDailyDto {
  date: string
  temperatureMax: number | null
  temperatureMin: number | null
  precipitationSum: number | null
  precipitationProbabilityMax: number | null
  windSpeedMax: number | null
  uvIndexMax: number | null
  weatherCode: number | null
  sunrise: string | null
  sunset: string | null
}

export interface WeatherForecastDto {
  units: {
    temperature: 'C'
    precipitation: 'mm'
    windSpeed: 'km/h'
  }
  current: {
    temperature: number | null
    apparentTemperature: number | null
    windSpeed: number | null
    weatherCode: number | null
    isDay: boolean | null
  } | null
  daily: WeatherForecastDailyDto[]
}

export interface AirQualityDailyDto {
  date: string
  usAqiMax: number | null
  pm2_5Mean: number | null
  pm10Mean: number | null
}

export interface AirQualityDto {
  current: {
    usAqi: number | null
    europeanAqi: number | null
    pm2_5: number | null
    pm10: number | null
    ozone: number | null
    dust: number | null
  } | null
  daily: AirQualityDailyDto[]
}

export interface WeatherDto {
  forecast: WeatherForecastDto | null
  airQuality: AirQualityDto | null
  fetchedAt: string | null
  errorCode: string | null
  isStale: boolean
}

// Authenticated detail page — member+ on the event.
export async function getEventWeather(eventId: string): Promise<WeatherDto> {
  return request<WeatherDto>('GET', `/api/v1/ui/events/${ev(eventId)}/weather`)
}

// Public landing — cookieless. Gated by public_page_config.enabled.
export async function getPublicEventWeather(slug: string): Promise<WeatherDto> {
  return publicFetch<WeatherDto>(`/api/v1/sdk/events/${ev(slug)}/weather`)
}

// --- planner prefs (per-user "show in planner" for group events) ----

// Returns the set of event ids the current user has flagged
// show_in_planner=true. Used by events-web to restore toggle state.
export async function listEventPlannerPrefs(): Promise<string[]> {
  const res = await request<{ eventIds: string[] }>('GET', '/api/v1/ui/events/planner-prefs')
  return res.eventIds
}

// Toggle the "show in planner" flag for a group event the user attends.
// show=false removes it from the Planner; the upsert is idempotent.
export async function setEventPlannerPref(eventId: string, show: boolean): Promise<void> {
  await request<void>('PUT', `/api/v1/ui/events/${ev(eventId)}/planner-pref`, { show })
}

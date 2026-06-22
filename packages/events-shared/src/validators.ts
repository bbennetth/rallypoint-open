import { z } from 'zod'
import { EventFeaturesPatchSchema } from './event-features.js'
import { POI_CATEGORY_IDS } from './poi-categories.js'
import { dayTimesIssue } from './day-generation.js'
import { ticketPlatformField } from './ticket-platforms.js'

// Account email a personal event's tickets are under — the user's OWN
// account identifier, stored as a plaintext label (not a secret, never a
// password). nullable+optional so a patch can clear it; empty string is
// rejected (use null to clear).
export const ticketAccountEmailField = z
  .string()
  .trim()
  .min(3, 'Email is too short.')
  .max(254, 'Email is too long.')
  .email('That does not look like an email address.')
  .transform((s) => s.toLowerCase())
  .nullable()
  .optional()

// Cross-target validators for Rallypoint Events. apps/events-api
// validates request bodies with these; apps/events-web reuses the
// same schemas client-side so users see field errors before a
// network round trip. Evolve the rules HERE, never in two places.
// Mirrors @rallypoint/shared's field-builder style.

// --- Field-level building blocks -------------------------------------

// Event display name. Matches events.name (notNull) — 1–100 chars
// after trimming.
export const eventNameField = z
  .string()
  .trim()
  .min(1, 'Event name is required.')
  .max(100, 'Event name must be at most 100 characters.')

// Free-text description. Matches events.description (nullable) —
// up to 5000 chars. Empty string normalises to null (an explicit
// "clear this column" signal on PATCH; an explicit NULL insert on
// CREATE). Absent stays undefined ("leave alone" on PATCH).
export const eventDescriptionField = z
  .string()
  .trim()
  .max(5000, 'Description must be at most 5000 characters.')
  .transform((s) => (s.length === 0 ? null : s))
  .nullable()
  .optional()

// URL slug. Lowercase kebab: letters/digits separated by single
// hyphens, no leading/trailing/double hyphen. 1–50 chars. Matches
// the (tenant_id, slug) unique index on events.
export const eventSlugField = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, 'Slug is required.')
  .max(50, 'Slug must be at most 50 characters.')
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'Slug must be lowercase letters, digits, and single hyphens.',
  )

// Calendar date, ISO-8601 (YYYY-MM-DD). Matches the date columns
// start_date / end_date. Validated for real calendar validity, not
// just shape (rejects 2026-02-30).
export const eventDateField = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format.')
  .refine((s) => {
    const parts = s.split('-').map(Number)
    const [y, m, d] = parts as [number, number, number]
    const dt = new Date(Date.UTC(y, m - 1, d))
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
  }, 'That is not a valid calendar date.')

// IANA timezone, validated against the runtime's canonical zone
// list (Node 22 / modern browsers expose Intl.supportedValuesOf).
// Falls back to a shape check on older runtimes that lack it.
const IANA_TIMEZONES: ReadonlySet<string> | null = (() => {
  const sv = (
    Intl as unknown as { supportedValuesOf?: (k: string) => string[] }
  ).supportedValuesOf
  if (typeof sv !== 'function') return null
  try {
    return new Set(sv('timeZone'))
  } catch {
    return null
  }
})()

export const eventTimezoneField = z
  .string()
  .trim()
  .min(1, 'Timezone is required.')
  .refine(
    // 'UTC' is universally valid but absent from
    // Intl.supportedValuesOf('timeZone') (which lists 'Etc/UTC'),
    // so accept it explicitly.
    (s) =>
      s === 'UTC' ||
      (IANA_TIMEZONES
        ? IANA_TIMEZONES.has(s)
        : /^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+$/.test(s)),
    'That is not a recognised IANA timezone.',
  )

// Coordinate fields. numeric(9,6) → lat ±90, lng ±180.
export const eventLatField = z
  .number()
  .min(-90, 'Latitude must be between -90 and 90.')
  .max(90, 'Latitude must be between -90 and 90.')

export const eventLngField = z
  .number()
  .min(-180, 'Longitude must be between -180 and 180.')
  .max(180, 'Longitude must be between -180 and 180.')

// Empty string normalises to null so PATCH can clear the column;
// absent stays undefined ("leave alone").
export const eventLocationLabelField = z
  .string()
  .trim()
  .max(200, 'Location label must be at most 200 characters.')
  .transform((s) => (s.length === 0 ? null : s))
  .nullable()
  .optional()

// Privacy mode. Matches events.privacy_mode (default 'unlisted').
export const PRIVACY_MODES = ['public', 'unlisted', 'private'] as const
export const privacyModeField = z.enum(PRIVACY_MODES, {
  errorMap: () => ({ message: 'Privacy mode must be public, unlisted, or private.' }),
})

// Scope type. Discriminates personal (planner-owned) events from
// group/festival events. Matches events.scope_type (default 'personal').
export const EVENT_SCOPE_TYPES = ['personal', 'group'] as const
export type EventScopeType = (typeof EVENT_SCOPE_TYPES)[number]
export const scopeTypeField = z.enum(EVENT_SCOPE_TYPES, {
  errorMap: () => ({ message: 'Scope type must be personal or group.' }),
})

// UTC datetime instant. ISO-8601 with a Z or explicit offset
// (e.g. 2026-06-03T18:00:00Z or 2026-06-03T20:00:00+02:00).
// The calling layer converts to a Date for DB storage.
export const eventInstantField = z.string().datetime({ offset: true })

// Create a personal (planner) event. scopeType, slug, and privacyMode
// are NOT accepted from the caller — they are forced server-side to
// 'personal', a server-minted ulid slug, and 'private' respectively.
// If both startAt and endAt are supplied, endAt must not precede startAt.
export const CreatePersonalEventSchema = z
  .object({
    name: eventNameField,
    description: eventDescriptionField,
    startAt: eventInstantField.optional(),
    endAt: eventInstantField.optional(),
    locationLabel: eventLocationLabelField,
    ticketPlatform: ticketPlatformField,
    ticketAccountEmail: ticketAccountEmailField,
    // Issue #545: explicit all-day flag.
    allDay: z.boolean().optional(),
  })
  .refine(
    (v) => {
      // Compare as instants, not lexically — mixed offsets (+02:00 vs Z)
      // for the same moment would mis-order a string compare.
      if (v.startAt && v.endAt) {
        return new Date(v.endAt).getTime() >= new Date(v.startAt).getTime()
      }
      return true
    },
    { path: ['endAt'], message: 'End time must not be before start time.' },
  )
export type CreatePersonalEventBody = z.infer<typeof CreatePersonalEventSchema>

// Patch a personal (planner) event. Every field optional; at least one
// must be present. `startAt`/`endAt` are nullable (null clears the column).
// scopeType / slug / privacyMode / timezone stay server-controlled and are
// not patchable here. endAt must not precede startAt when both are supplied
// in the same patch (a partial patch touching only one side is validated
// against the stored value at the route, like the group PatchEventSchema).
export const PatchPersonalEventSchema = z
  .object({
    name: eventNameField.optional(),
    description: eventDescriptionField,
    startAt: eventInstantField.nullable().optional(),
    endAt: eventInstantField.nullable().optional(),
    locationLabel: eventLocationLabelField,
    ticketPlatform: ticketPlatformField,
    ticketAccountEmail: ticketAccountEmailField,
    // Issue #545: explicit all-day flag. null clears an explicit value back to inference.
    allDay: z.boolean().nullable().optional(),
  })
  .superRefine((v, ctx) => {
    if (Object.values(v).every((x) => x === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: 'At least one field must be supplied.',
      })
    }
    if (v.startAt && v.endAt && new Date(v.endAt).getTime() < new Date(v.startAt).getTime()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endAt'],
        message: 'End time must not be before start time.',
      })
    }
  })
export type PatchPersonalEventBody = z.infer<typeof PatchPersonalEventSchema>

// --- Public page config (slice 11; design §11) -----------------------

// Slice 11 ships only the minimal editor surface: enabled + theme +
// hidden_fields. Sections live in the jsonb today and are honoured by
// the SDK route, but the editor UI for them is a follow-up. Owners
// can still PATCH `sections` directly via the API if they want.
export const PUBLIC_SECTION_KINDS = [
  'description',
  'lineup',
  'sessions',
  'map',
  'rsvp_link',
] as const

export const PUBLIC_HIDDEN_FIELDS = [
  'lineup',
  'sessions',
  'map',
  'description',
  'dates',
  'location_label',
] as const

const accentColorField = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Accent colour must be a hex string like #1abc9c.')
  .transform((s) => s.toLowerCase())

const backgroundImageKeyField = z.string().trim().min(1).max(512)

const publicPageThemeSchema = z.object({
  accent_color: accentColorField.optional(),
  background_image_key: backgroundImageKeyField.optional(),
})

// Each `section` shape per design §11. Discriminated on `kind`. The
// editor UI in V1 emits an empty `sections: []`; the SDK route will
// surface any pre-populated shape an owner sets via API.
const publicSectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('description') }),
  z.object({
    kind: z.literal('lineup'),
    limit_to_tier: z.enum(['headliner', 'support']).optional(),
  }),
  z.object({
    kind: z.literal('sessions'),
    day_id: z.string().trim().min(1).max(128).optional(),
  }),
  z.object({
    kind: z.literal('map'),
    layer: z.enum(['site', 'camp', 'full']),
  }),
  z.object({
    kind: z.literal('rsvp_link'),
    url: z.string().url().max(2048),
  }),
])

// The persisted shape for `events.public_page_config`. The editor
// only ever flips `enabled` + `theme.accent_color` in V1; the rest
// passes through verbatim so owners who set sections via API don't
// lose them on a UI save.
export const PublicPageConfigSchema = z.object({
  enabled: z.boolean(),
  theme: publicPageThemeSchema.optional(),
  sections: z.array(publicSectionSchema).max(50).optional(),
  hidden_fields: z.array(z.enum(PUBLIC_HIDDEN_FIELDS)).optional(),
})

export type PublicPageConfig = z.infer<typeof PublicPageConfigSchema>

// Membership roles. 'owner' is never granted by invite/patch — it
// changes only through transfer-ownership — so the assignable set
// excludes it.
export const MEMBER_ROLES = ['owner', 'editor', 'viewer'] as const
export const ASSIGNABLE_ROLES = ['editor', 'viewer'] as const
export const assignableRoleField = z.enum(ASSIGNABLE_ROLES, {
  errorMap: () => ({ message: 'Role must be editor or viewer.' }),
})

// Raw invite code as handed to the accepter: 'rpe_' + base64url.
export const inviteCodeField = z
  .string()
  .trim()
  .min(5, 'Invite code is required.')
  .max(256, 'Invite code is too long.')
  .regex(/^rpe_[A-Za-z0-9_-]+$/, 'That is not a valid invite code.')

// User id as supplied to transfer-ownership. Prefix-tagged ULID
// from RPID (`usr_<ulid>`); we bound length and charset rather than
// re-deriving the full ULID grammar here.
export const userIdField = z
  .string()
  .trim()
  .min(1, 'User id is required.')
  .max(64, 'User id is too long.')

// Re-auth password echo. Bounds match RPID's MAX_PASSWORD_LENGTH;
// we only need non-empty + a sane ceiling, the real check is RPID's.
const currentPasswordField = z.string().min(1, 'Current password is required.').max(256)

// --- Request schemas -----------------------------------------------

// Create. name + timezone required (both notNull columns). Slug is
// server-generated as `<slugified-name, max 24>-<random suffix>` and
// is NOT accepted from the client — custom slugs land later as a
// paid-tier feature. Clients that still send `slug` have it silently
// stripped here (Zod default behaviour) and the server's auto-gen
// replaces it; an integration test pins that contract.
// endDate must not precede startDate when both are given.
export const CreateEventSchema = z
  .object({
    name: eventNameField,
    description: eventDescriptionField,
    timezone: eventTimezoneField,
    startDate: eventDateField.optional(),
    endDate: eventDateField.optional(),
    locationLabel: eventLocationLabelField,
    locationLat: eventLatField.optional(),
    locationLng: eventLngField.optional(),
    privacyMode: privacyModeField.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.startDate && v.endDate && v.endDate < v.startDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endDate'],
        message: 'End date must not be before start date.',
      })
    }
    if ((v.locationLat === undefined) !== (v.locationLng === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['locationLng'],
        message: 'Latitude and longitude must be provided together.',
      })
    }
  })
export type CreateEventBody = z.infer<typeof CreateEventSchema>

// Patch. Every field optional; at least one must be present.
// nulls are allowed where the column is nullable, to clear a value.
// Slug is NOT patchable here — custom slugs land later as a paid-
// tier feature with its own gated PATCH endpoint.
export const PatchEventSchema = z
  .object({
    name: eventNameField.optional(),
    description: eventDescriptionField,
    timezone: eventTimezoneField.optional(),
    startDate: eventDateField.nullable().optional(),
    endDate: eventDateField.nullable().optional(),
    locationLabel: eventLocationLabelField,
    locationLat: eventLatField.nullable().optional(),
    locationLng: eventLngField.nullable().optional(),
    privacyMode: privacyModeField.optional(),
    publicPageConfig: PublicPageConfigSchema.nullable().optional(),
    // Per-event feature toggles (#216). Owner-only — enforced at the
    // route (PatchEventSchema is shared by editor-level patches).
    features: EventFeaturesPatchSchema.optional(),
  })
  .superRefine((v, ctx) => {
    if (Object.values(v).every((x) => x === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: 'At least one field must be supplied.',
      })
    }
    if (v.startDate && v.endDate && v.endDate < v.startDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endDate'],
        message: 'End date must not be before start date.',
      })
    }
  })
export type PatchEventBody = z.infer<typeof PatchEventSchema>

// Create an invite. role is the membership granted on accept;
// invited_email optional (absent = open-code invite).
export const CreateInviteSchema = z.object({
  role: assignableRoleField,
  invitedEmail: emailFieldOptional(),
})
export type CreateInviteBody = z.infer<typeof CreateInviteSchema>

export const AcceptInviteSchema = z.object({
  code: inviteCodeField,
})
export type AcceptInviteBody = z.infer<typeof AcceptInviteSchema>

export const TransferOwnershipSchema = z.object({
  newOwnerUserId: userIdField,
  currentPassword: currentPasswordField,
})
export type TransferOwnershipBody = z.infer<typeof TransferOwnershipSchema>

// --- lineup field-level building blocks (slice 3) ------------------

// Stage name. Matches event_stages.name (notNull), unique per event.
export const stageNameField = z
  .string()
  .trim()
  .min(1, 'Stage name is required.')
  .max(100, 'Stage name must be at most 100 characters.')

// Day label, e.g. 'WED' or 'Day 1'. Matches event_days.day_label.
export const dayLabelField = z
  .string()
  .trim()
  .min(1, 'Day label is required.')
  .max(50, 'Day label must be at most 50 characters.')

// Non-negative display ordering. Bounded to keep it sane.
export const sortOrderField = z
  .number()
  .int('Sort order must be a whole number.')
  .min(0, 'Sort order must not be negative.')
  .max(100_000, 'Sort order is too large.')

// Artist name. Matches artists.name (notNull), deduped case-insensitively.
export const artistNameField = z
  .string()
  .trim()
  .min(1, 'Artist name is required.')
  .max(200, 'Artist name must be at most 200 characters.')

// Optional music-profile URL. Empty string clears the column; absent
// leaves it alone. Must be http(s) and within a sane length.
function musicLinkField() {
  return z
    .string()
    .trim()
    .max(2048, 'Link is too long.')
    .url('That does not look like a URL.')
    .refine((s) => /^https?:\/\//i.test(s), 'Link must be an http(s) URL.')
    .or(z.literal(''))
    .transform((s) => (s.length === 0 ? null : s))
    .nullable()
    .optional()
}

// Per-event override of artists.name. Empty string clears; absent
// leaves alone.
export const displayNameField = z
  .string()
  .trim()
  .max(200, 'Display name must be at most 200 characters.')
  .transform((s) => (s.length === 0 ? null : s))
  .nullable()
  .optional()

// Lineup tier. Free-text in the schema but bounded to the known set
// at the edge so the editor's filters stay meaningful.
export const LINEUP_TIERS = ['headliner', 'support', 'opener'] as const
export const tierField = z
  .enum(LINEUP_TIERS, { errorMap: () => ({ message: 'Tier must be headliner, support, or opener.' }) })
  .nullable()
  .optional()

export const genreField = z
  .string()
  .trim()
  .max(100, 'Genre must be at most 100 characters.')
  .transform((s) => (s.length === 0 ? null : s))
  .nullable()
  .optional()

// Set time as 24h 'HH:MM' (seconds optional). Normalised to 'HH:MM'.
// Empty string clears; absent leaves alone.
export const setTimeField = z
  .string()
  .trim()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'Time must be HH:MM (24-hour).')
  .transform((s) => s.slice(0, 5))
  .or(z.literal(''))
  .transform((s) => (s.length === 0 ? null : s))
  .nullable()
  .optional()

// Prefix-tagged ids handed back to the client. Bound length/charset
// rather than re-deriving the ULID grammar.
const idRefField = (label: string) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required.`)
    .max(64, `${label} is too long.`)

// Group id prefix-aware refinement (added Phase R). Rejects old
// `crew_<ulid>` IDs at the validation boundary so callers can't pass
// stale identifiers; new rows mint `grp_<ulid>`.
const groupIdRefField = (label: string) =>
  idRefField(label).refine(
    (v) => v.startsWith('grp_'),
    `${label} must be a group id (grp_…).`,
  )

// --- lineup request schemas ----------------------------------------

export const CreateStageSchema = z.object({
  name: stageNameField,
  sortOrder: sortOrderField.optional(),
})
export type CreateStageBody = z.infer<typeof CreateStageSchema>

export const PatchStageSchema = z
  .object({ name: stageNameField.optional(), sortOrder: sortOrderField.optional() })
  .superRefine((v, ctx) => {
    if (v.name === undefined && v.sortOrder === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [], message: 'At least one field must be supplied.' })
    }
  })
export type PatchStageBody = z.infer<typeof PatchStageSchema>

// A day's own optional window ("date + optional times"). start_time and
// end_time are edited as a pair: both empty = all-day, both set = a timed
// window where end must not precede start. Empty string clears (→ null);
// `setTimeField` normalises 'HH:MM:SS' → 'HH:MM'.
function addDayTimesIssue(
  v: { startTime?: string | null | undefined; endTime?: string | null | undefined },
  ctx: z.RefinementCtx,
): void {
  const issue = dayTimesIssue(v.startTime, v.endTime)
  if (issue === 'both_required') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['endTime'],
      message: 'Start and end time must be set together (or both left blank for an all-day date).',
    })
  } else if (issue === 'end_before_start') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['endTime'],
      message: 'End time must not be before start time.',
    })
  }
}

export const CreateDaySchema = z
  .object({
    dayLabel: dayLabelField,
    date: eventDateField,
    startTime: setTimeField,
    endTime: setTimeField,
    sortOrder: sortOrderField.optional(),
  })
  .superRefine(addDayTimesIssue)
export type CreateDayBody = z.infer<typeof CreateDaySchema>

export const PatchDaySchema = z
  .object({
    dayLabel: dayLabelField.optional(),
    date: eventDateField.optional(),
    startTime: setTimeField,
    endTime: setTimeField,
    sortOrder: sortOrderField.optional(),
  })
  .superRefine((v, ctx) => {
    if (
      v.dayLabel === undefined &&
      v.date === undefined &&
      v.startTime === undefined &&
      v.endTime === undefined &&
      v.sortOrder === undefined
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [], message: 'At least one field must be supplied.' })
    }
    // Only enforce the pair rule when this patch touches the window.
    if (v.startTime !== undefined || v.endTime !== undefined) {
      addDayTimesIssue(v, ctx)
    }
  })
export type PatchDayBody = z.infer<typeof PatchDaySchema>

// Quick-create days from a date range (issue #191). Both fields optional:
// when absent the server falls back to the event's start_date/end_date.
// When supplied, endDate must not precede startDate (same rule as event
// create). The actual day rows are produced by generateDays().
export const GenerateDaysSchema = z
  .object({
    startDate: eventDateField.optional(),
    endDate: eventDateField.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.startDate && v.endDate && v.endDate < v.startDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endDate'],
        message: 'End date must not be before start date.',
      })
    }
  })
export type GenerateDaysBody = z.infer<typeof GenerateDaysSchema>

// Music links shared by create + patch of an artist.
const artistLinkFields = {
  soundcloud: musicLinkField(),
  spotify: musicLinkField(),
  appleMusic: musicLinkField(),
  youtubeMusic: musicLinkField(),
  instagram: musicLinkField(),
}

export const CreateArtistSchema = z.object({ name: artistNameField, ...artistLinkFields })
export type CreateArtistBody = z.infer<typeof CreateArtistSchema>

export const PatchArtistSchema = z
  .object({ name: artistNameField.optional(), ...artistLinkFields })
  .superRefine((v, ctx) => {
    if (Object.values(v).every((x) => x === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [], message: 'At least one field must be supplied.' })
    }
  })
export type PatchArtistBody = z.infer<typeof PatchArtistSchema>

// A single lineup slot: which artist plays which day, plus optional
// stage/time/tier metadata. endTime may legitimately precede startTime
// (a set crossing midnight), so the two are NOT cross-validated here.
export const LineupSlotSchema = z.object({
  artistId: idRefField('Artist id'),
  dayId: idRefField('Day id'),
  stageId: idRefField('Stage id').nullable().optional(),
  tier: tierField,
  genre: genreField,
  startTime: setTimeField,
  endTime: setTimeField,
  displayName: displayNameField,
})
export type LineupSlotBody = z.infer<typeof LineupSlotSchema>

// A lineup slot to remove, keyed by its composite identity (artist + day).
export const LineupDeleteSchema = z.object({
  artistId: idRefField('Artist id'),
  dayId: idRefField('Day id'),
})
export type LineupDeleteBody = z.infer<typeof LineupDeleteSchema>

// Bulk apply: upsert slots and/or delete slots in one transactional request
// (the editor's "save changes"). Both arrays optional, but at least one
// non-empty operation is required.
export const BulkLineupSchema = z
  .object({
    slots: z.array(LineupSlotSchema).max(200, 'Too many slots in one request.').optional(),
    deletes: z.array(LineupDeleteSchema).max(200, 'Too many deletes in one request.').optional(),
  })
  .superRefine((v, ctx) => {
    if (!v.slots?.length && !v.deletes?.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: 'At least one slot or delete is required.',
      })
    }
  })
export type BulkLineupBody = z.infer<typeof BulkLineupSchema>

// --- sessions (activities) field-level building blocks (slice 3c) --

// Session title. Matches event_sessions.title (notNull).
export const sessionTitleField = z
  .string()
  .trim()
  .min(1, 'Title is required.')
  .max(200, 'Title must be at most 200 characters.')

// Free-text description. Empty string clears; absent leaves alone.
export const sessionDescriptionField = z
  .string()
  .trim()
  .max(5000, 'Description must be at most 5000 characters.')
  .transform((s) => (s.length === 0 ? null : s))
  .nullable()
  .optional()

// Bounded free-text. Empty clears; absent leaves alone. Shared by the
// location / category / host columns.
function shortTextField(label: string, max: number) {
  return z
    .string()
    .trim()
    .max(max, `${label} must be at most ${max} characters.`)
    .transform((s) => (s.length === 0 ? null : s))
    .nullable()
    .optional()
}

// Session visibility. Matches event_sessions.visibility (default
// 'group'). 'admin' = event-owner-only (festival-planner parity).
export const SESSION_VISIBILITIES = ['admin', 'private', 'group', 'custom'] as const
export const sessionVisibilityField = z.enum(SESSION_VISIBILITIES, {
  errorMap: () => ({ message: 'Visibility must be admin, private, group, or custom.' }),
})

// user_ids shared with when visibility='custom'. Empty array clears.
export const sharedWithField = z
  .array(userIdField)
  .max(500, 'Too many shared users in one request.')
  .nullable()
  .optional()

// --- session request schemas ---------------------------------------

// Create. title required; everything else optional. endTime may
// precede startTime (a session crossing midnight) so they are NOT
// cross-validated. approval_status + group assignment are server-driven,
// not client-set, so they're absent here.
export const CreateSessionSchema = z.object({
  title: sessionTitleField,
  description: sessionDescriptionField,
  location: shortTextField('Location', 200),
  dayId: idRefField('Day id').nullable().optional(),
  stageId: idRefField('Stage id').nullable().optional(),
  startTime: setTimeField,
  endTime: setTimeField,
  category: shortTextField('Category', 100),
  host: shortTextField('Host', 200),
  visibility: sessionVisibilityField.optional(),
  groupId: groupIdRefField('Group id').nullable().optional(),
  sharedWith: sharedWithField,
})
export type CreateSessionBody = z.infer<typeof CreateSessionSchema>

// Patch. Every field optional; at least one must be present. Approval
// state moves only through the submit/approve/reject endpoints.
export const PatchSessionSchema = z
  .object({
    title: sessionTitleField.optional(),
    description: sessionDescriptionField,
    location: shortTextField('Location', 200),
    dayId: idRefField('Day id').nullable().optional(),
    stageId: idRefField('Stage id').nullable().optional(),
    startTime: setTimeField,
    endTime: setTimeField,
    category: shortTextField('Category', 100),
    host: shortTextField('Host', 200),
    visibility: sessionVisibilityField.optional(),
    groupId: groupIdRefField('Group id').nullable().optional(),
    sharedWith: sharedWithField,
  })
  .superRefine((v, ctx) => {
    if (Object.values(v).every((x) => x === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [], message: 'At least one field must be supplied.' })
    }
  })
export type PatchSessionBody = z.infer<typeof PatchSessionSchema>

// Bulk create + update + delete in one transactional request (slice 1C).
// Updates use a nested `patch` envelope because PatchSessionSchema is a
// ZodEffects (`.superRefine`) which cannot safely participate in a
// ZodObject intersection (`.and()`). At least one of the three arrays
// must be non-empty.
const sessionIdField = z
  .string()
  .trim()
  .min(1, 'Session id is required.')
  .max(64, 'Session id is too long.')

export const BulkSessionUpdateSchema = z.object({
  id: sessionIdField,
  patch: PatchSessionSchema,
})
export type BulkSessionUpdate = z.infer<typeof BulkSessionUpdateSchema>

export const BulkSessionsSchema = z
  .object({
    creates: z.array(CreateSessionSchema).max(200).optional(),
    updates: z.array(BulkSessionUpdateSchema).max(200).optional(),
    deletes: z.array(sessionIdField).max(200).optional(),
  })
  .superRefine((v, ctx) => {
    const hasCreates = (v.creates?.length ?? 0) > 0
    const hasUpdates = (v.updates?.length ?? 0) > 0
    const hasDeletes = (v.deletes?.length ?? 0) > 0
    if (!hasCreates && !hasUpdates && !hasDeletes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: 'At least one of creates, updates, or deletes must be non-empty.',
      })
    }
  })
export type BulkSessionsBody = z.infer<typeof BulkSessionsSchema>

// --- map + POI field-level building blocks (slice 5) ---------------

// Which map layer a row belongs to. Matches the (event_id, layer)
// unique index on event_maps.
export const MAP_LAYERS = ['site', 'camp', 'full'] as const

// POI display name. Matches event_pois.name (notNull).
export const poiNameField = z
  .string()
  .trim()
  .min(1, 'POI name is required.')
  .max(120, 'POI name must be at most 120 characters.')

export const poiCategoryField = z.enum(POI_CATEGORY_IDS, {
  errorMap: () => ({ message: 'Unknown POI category.' }),
})

// Percentage coordinate (0..100) of the map image.
const pctField = z
  .number()
  .min(0, 'Coordinate must be between 0 and 100.')
  .max(100, 'Coordinate must be between 0 and 100.')

// Optional geo coordinates for outdoor wayfinding. Empty stays absent.
const latField = z.number().min(-90).max(90).nullable().optional()
const lngField = z.number().min(-180).max(180).nullable().optional()

// A polygon ring of percentage points. 3..200 vertices.
const polygonField = z
  .array(z.object({ xPct: pctField, yPct: pctField }))
  .min(3, 'A zone needs at least 3 points.')
  .max(200, 'Too many points in one zone.')

// --- POI request schemas -------------------------------------------

export const CreatePoiSchema = z.object({
  categoryId: poiCategoryField,
  name: poiNameField,
  description: shortTextField('Description', 2000),
  mapId: idRefField('Map id').nullable().optional(),
  xPct: pctField,
  yPct: pctField,
  lat: latField,
  lng: lngField,
  sortOrder: sortOrderField.optional(),
})
export type CreatePoiBody = z.infer<typeof CreatePoiSchema>

export const PatchPoiSchema = z
  .object({
    categoryId: poiCategoryField.optional(),
    name: poiNameField.optional(),
    description: shortTextField('Description', 2000),
    mapId: idRefField('Map id').nullable().optional(),
    xPct: pctField.optional(),
    yPct: pctField.optional(),
    lat: latField,
    lng: lngField,
    sortOrder: sortOrderField.optional(),
  })
  .superRefine((v, ctx) => {
    if (Object.values(v).every((x) => x === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [], message: 'At least one field must be supplied.' })
    }
  })
export type PatchPoiBody = z.infer<typeof PatchPoiSchema>

// --- no-go-zone request schemas ------------------------------------

// A zone is meaningless without its map, so mapId is required.
export const CreateZoneSchema = z.object({
  mapId: idRefField('Map id'),
  polygon: polygonField,
})
export type CreateZoneBody = z.infer<typeof CreateZoneSchema>

export const PatchZoneSchema = z.object({
  polygon: polygonField,
})
export type PatchZoneBody = z.infer<typeof PatchZoneSchema>

// Optional email — reuses RFC-ish bounds + lowercasing. Defined as
// a factory so the optional-ness is explicit at each call site.
function emailFieldOptional() {
  return z
    .string()
    .trim()
    .min(3, 'Email is too short.')
    .max(254, 'Email is too long.')
    .email('That does not look like an email address.')
    .transform((s) => s.toLowerCase())
    .optional()
}

// --- set-star request schemas (issue #194) -------------------------

// Body for star / unstar a lineup slot. artistId and dayId are the
// composite key that identifies the set alongside the event_id in
// the route parameter.
export const SetStarSchema = z.object({
  artistId: idRefField('Artist id'),
  dayId: idRefField('Day id'),
})
export type SetStarBody = z.infer<typeof SetStarSchema>

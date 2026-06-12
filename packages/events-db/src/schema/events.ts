import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, real, uniqueIndex, index } from 'drizzle-orm/sqlite-core'

// events — the core event row (design doc §5.1). id is a
// prefix-tagged ULID (`event_<ulid>`) minted in the app layer.
// owner_user_id holds a Rallypoint ID `user_<ulid>`; it is NOT a
// cross-schema FK (the schemas migrate independently — §5). slug is
// unique per tenant. deleted_at is the soft-delete marker; the 2c
// pruner hard-purges 30 days past it (§5.1.1).

export const events = sqliteTable(
  'events',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().default('rallypoint'),
    ownerUserId: text('owner_user_id').notNull(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    startDate: text('start_date'),
    endDate: text('end_date'),
    timezone: text('timezone').notNull(),
    locationLabel: text('location_label'),
    // GPS coordinate — real/double has ample precision for lat/lng.
    locationLat: real('location_lat'),
    // GPS coordinate — real/double has ample precision for lat/lng.
    locationLng: real('location_lng'),
    privacyMode: text('privacy_mode').notNull().default('unlisted'),
    publicPageConfig: text('public_page_config', { mode: 'json' }),
    // Per-event feature toggles (#216): JSON {lineup,sessions,groups,
    // attendees} booleans. NULL = defaults (lineup/sessions/groups on,
    // attendees off). Parsed/merged by resolveEventFeatures in
    // events-shared; never read raw outside that helper.
    features: text('features', { mode: 'json' }),
    // Slice 2 (planner personal events): scope discriminator + UTC instants.
    // Existing rows take 'personal' via the column default; personal events
    // are private datetime events owned by a single user (never group/festival).
    scopeType: text('scope_type').notNull().default('personal'),
    startAt: integer('start_at', { mode: 'timestamp_ms' }),
    endAt: integer('end_at', { mode: 'timestamp_ms' }),
    // Slice 3b (ticket platform): optional metadata for personal events.
    // Both are nullable plaintext — no secrets, no FK.
    ticketPlatform: text('ticket_platform'),
    ticketAccountEmail: text('ticket_account_email'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
  },
  (t) => ({
    tenantSlugIdx: uniqueIndex('events_tenant_slug_idx').on(t.tenantId, t.slug),
    ownerIdx: index('events_owner_idx').on(t.ownerUserId),
    // Slice 2: backs listPersonalForUser queries (tenant + scope + owner + time).
    personalIdx: index('events_personal_idx').on(t.tenantId, t.scopeType, t.ownerUserId, t.startAt),
  }),
)

export type DbEvent = typeof events.$inferSelect
export type DbEventInsert = typeof events.$inferInsert

-- Seed: "Harvest Moon Festival" — a system-owned demo festival.
--
-- Owner is the SYSTEM_USER_ID sentinel reserved in @rallypoint/shared
-- (user_00000000000000000000000000, PR #792): no users row, resolves to
-- "Rallypoint" in rosters, manageable via admin-web /system-events, and
-- ADMIN_USER_IDS allowlistees act as owner on it in events-web.
--
-- Idempotent: every statement is INSERT OR IGNORE keyed on fixed ids
-- (and the tenant+slug / event+label unique indexes), so re-runs are
-- no-ops and post-seed edits made through the app are never clobbered.
--
-- Apply via scripts/seed-demo-festival.sh (local dev D1 or remote
-- qa/prod). Statement separator contract: each statement ends with a
-- semicolon at end-of-line, and no string literal contains one — the
-- runner and the d1 test split on that.

-- scope_type 'group' is deliberate (the admin RPC create leaves the
-- column default 'personal'): festival semantics — group/rally features
-- and the planner group-events feed both filter on scope 'group'. The
-- enabled public_page_config makes /e/harvest-moon-demo live (the
-- public-html + SDK gates 404 a public event without it), which is the
-- read path ordinary users reach a system event through.
INSERT OR IGNORE INTO events
  (id, tenant_id, owner_user_id, slug, name, description,
   start_date, end_date, timezone, location_label, location_lat, location_lng,
   privacy_mode, scope_type, public_page_config, features)
VALUES
  ('event_demo_harvest_moon_2026', 'rallypoint', 'user_00000000000000000000000000',
   'harvest-moon-demo', 'Harvest Moon Festival',
   'Three nights of music under the September moon at Golden Meadow Ranch. A Rallypoint demo festival — poke around the lineup, schedule a session, rally your crew.',
   '2026-09-18', '2026-09-20', 'America/Los_Angeles',
   'Golden Meadow Ranch, Sonoma, CA', 38.4404, -122.7141,
   'public', 'group', '{"enabled":true}',
   '{"lineup":true,"sessions":true,"groups":true,"attendees":true}');

INSERT OR IGNORE INTO event_days (id, event_id, day_label, date, start_time, end_time, sort_order) VALUES
  ('evd_demo_hm_fri', 'event_demo_harvest_moon_2026', 'Friday',   '2026-09-18', '15:00', '23:30', 0),
  ('evd_demo_hm_sat', 'event_demo_harvest_moon_2026', 'Saturday', '2026-09-19', '11:00', '23:30', 1),
  ('evd_demo_hm_sun', 'event_demo_harvest_moon_2026', 'Sunday',   '2026-09-20', '11:00', '22:30', 2);

INSERT OR IGNORE INTO event_stages (id, event_id, name, sort_order) VALUES
  ('evs_demo_hm_meadow', 'event_demo_harvest_moon_2026', 'Meadow Stage',   0),
  ('evs_demo_hm_grove',  'event_demo_harvest_moon_2026', 'Grove Stage',    1),
  ('evs_demo_hm_tent',   'event_demo_harvest_moon_2026', 'Starlight Tent', 2);

-- Fictional acts. artists has a global unique index on lower(name) —
-- OR IGNORE means a rare name collision skips the row. NOTE: OR IGNORE
-- does NOT suppress foreign-key violations, so the lineup insert below
-- joins on artists to drop slots whose artist row was skipped instead
-- of trusting the fixed ids.
INSERT OR IGNORE INTO artists (id, name) VALUES
  ('art_demo_neon_meridian',  'Neon Meridian'),
  ('art_demo_salt_flats',     'The Salt Flats'),
  ('art_demo_juniper_pine',   'Juniper & Pine'),
  ('art_demo_velvet_antenna', 'Velvet Antenna'),
  ('art_demo_copper_canyon',  'Copper Canyon Choir'),
  ('art_demo_marlowe_dusk',   'Marlowe Dusk'),
  ('art_demo_static_bloom',   'Static Bloom'),
  ('art_demo_paper_lanterns', 'The Paper Lanterns'),
  ('art_demo_ferris_wheels',  'Ferris & The Wheels'),
  ('art_demo_glass_meadow',   'Glass Meadow'),
  ('art_demo_low_tide',       'Low Tide Collective'),
  ('art_demo_prairie_signals','Prairie Signals');

-- FK-safe lineup insert: the join on artists (the one globally-shared
-- namespace above) drops any slot whose artist insert was OR-IGNOREd
-- away by a name collision, instead of hard-failing on the FK.
WITH slots (event_id, artist_id, day_id, stage_id, tier, genre, start_time, end_time) AS (VALUES
  -- Friday
  ('event_demo_harvest_moon_2026', 'art_demo_prairie_signals', 'evd_demo_hm_fri', 'evs_demo_hm_grove',  'support',   'ambient',          '16:00', '17:00'),
  ('event_demo_harvest_moon_2026', 'art_demo_velvet_antenna',  'evd_demo_hm_fri', 'evs_demo_hm_meadow', 'support',   'synthpop',         '17:00', '18:00'),
  ('event_demo_harvest_moon_2026', 'art_demo_paper_lanterns',  'evd_demo_hm_fri', 'evs_demo_hm_meadow', 'support',   'indie pop',        '18:30', '19:30'),
  ('event_demo_harvest_moon_2026', 'art_demo_marlowe_dusk',    'evd_demo_hm_fri', 'evs_demo_hm_grove',  'support',   'downtempo',        '19:00', '20:00'),
  ('event_demo_harvest_moon_2026', 'art_demo_neon_meridian',   'evd_demo_hm_fri', 'evs_demo_hm_meadow', 'headliner', 'indie electronic', '21:00', '23:00'),
  -- Saturday
  ('event_demo_harvest_moon_2026', 'art_demo_copper_canyon',   'evd_demo_hm_sat', 'evs_demo_hm_meadow', 'support',   'americana',        '15:00', '16:00'),
  ('event_demo_harvest_moon_2026', 'art_demo_static_bloom',    'evd_demo_hm_sat', 'evs_demo_hm_grove',  'support',   'shoegaze',         '16:00', '17:00'),
  ('event_demo_harvest_moon_2026', 'art_demo_ferris_wheels',   'evd_demo_hm_sat', 'evs_demo_hm_meadow', 'support',   'funk',             '17:30', '18:45'),
  ('event_demo_harvest_moon_2026', 'art_demo_glass_meadow',    'evd_demo_hm_sat', 'evs_demo_hm_grove',  'support',   'dream pop',        '18:00', '19:00'),
  ('event_demo_harvest_moon_2026', 'art_demo_salt_flats',      'evd_demo_hm_sat', 'evs_demo_hm_meadow', 'headliner', 'desert rock',      '21:00', '23:00'),
  ('event_demo_harvest_moon_2026', 'art_demo_low_tide',        'evd_demo_hm_sat', 'evs_demo_hm_tent',   'support',   'house',            '22:00', '23:30'),
  -- Sunday
  ('event_demo_harvest_moon_2026', 'art_demo_marlowe_dusk',    'evd_demo_hm_sun', 'evs_demo_hm_grove',  'support',   'downtempo',        '17:00', '18:00'),
  ('event_demo_harvest_moon_2026', 'art_demo_glass_meadow',    'evd_demo_hm_sun', 'evs_demo_hm_tent',   'support',   'dream pop',        '19:00', '20:00'),
  ('event_demo_harvest_moon_2026', 'art_demo_juniper_pine',    'evd_demo_hm_sun', 'evs_demo_hm_meadow', 'headliner', 'folk',             '20:30', '22:00'))
INSERT OR IGNORE INTO event_artists (event_id, artist_id, day_id, stage_id, tier, genre, start_time, end_time)
SELECT s.event_id, s.artist_id, s.day_id, s.stage_id, s.tier, s.genre, s.start_time, s.end_time
  FROM slots s
  JOIN artists a ON a.id = s.artist_id;

-- Official (owner-authored) schedule sessions. visibility 'group' with
-- a NULL group_id is the column-default shape; approval pre-granted.
INSERT OR IGNORE INTO event_sessions
  (id, event_id, title, description, location, day_id, start_time, end_time,
   category, host, approval_status, visibility, created_by_user_id)
VALUES
  ('evx_demo_hm_yoga',   'event_demo_harvest_moon_2026', 'Sunrise Yoga',
   'Slow flow in the meadow before the gates open. Mats provided.',
   'Meadow Lawn', 'evd_demo_hm_sat', '09:30', '10:30',
   'wellness', 'Rallypoint', 'approved', 'group', 'user_00000000000000000000000000'),
  ('evx_demo_hm_print',  'event_demo_harvest_moon_2026', 'Poster Screenprinting Workshop',
   'Pull your own limited-run festival poster with the print crew.',
   'Craft Barn', 'evd_demo_hm_sat', '13:00', '14:30',
   'workshop', 'Rallypoint', 'approved', 'group', 'user_00000000000000000000000000'),
  ('evx_demo_hm_walk',   'event_demo_harvest_moon_2026', 'Golden Hour Photo Walk',
   'A guided loop of the ranch at sunset — bring any camera.',
   'Main Gate', 'evd_demo_hm_sun', '18:15', '19:15',
   'art', 'Rallypoint', 'approved', 'group', 'user_00000000000000000000000000');

-- Activity-log parity with the admin create path (admin-events-core
-- records event.created with system:true).
INSERT OR IGNORE INTO event_activity (id, event_id, actor_user_id, event_type, meta) VALUES
  ('eva_demo_hm_created', 'event_demo_harvest_moon_2026', 'user_00000000000000000000000000',
   'event.created', '{"slug":"harvest-moon-demo","system":true,"seed":true}');

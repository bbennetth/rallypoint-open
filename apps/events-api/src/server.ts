// The Node single-binary entrypoint was retired in the native-Cloudflare
// migration (events-api D1 port, Phase 4). events-api's data layer moved
// from Postgres to D1, which is a per-request Worker binding — there is no
// Node Postgres connection to build repos from, so this process can no
// longer boot.
//
// Phase 4+ adds the Worker entrypoint (`src/worker.ts` exporting
// `{ fetch, scheduled }`): it maps the Worker `env` bindings to the typed
// Env, builds `buildD1Repos(createDb(env.EVENTS_DB))`, serves the same
// `buildApp(...)`, and runs pruner / weather-refresher work as Cron
// Triggers. Run locally with `wrangler dev`.
//
// The PG realtime bus construction and the setInterval-based pruner +
// weather-refresher drivers are also retired here; their logic (pruner
// repo methods, hard-purge, weather refresh) lives intact in pruner.ts /
// weather-refresher.ts for the cron handler to call directly.
//
// Kept as a stub (not deleted) so the file path + scripts survive until
// the Worker entrypoint replaces it.

throw new Error(
  'events-api runs on Cloudflare Workers now — the Node entrypoint was retired in the D1 migration. ' +
    'The Worker entrypoint (src/worker.ts) lands in a later phase; run locally with `wrangler dev`.',
)

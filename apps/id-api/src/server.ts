// The Node single-binary entrypoint was retired in the native-Cloudflare
// migration (#313). id-api's data layer moved from Postgres to D1, which
// is a per-request Worker binding — there is no Node Postgres connection
// to build repos from, so this process can no longer boot.
//
// Phase 2 adds the Worker entrypoint (`src/worker.ts` exporting
// `{ fetch, scheduled }`): it maps the Worker `env` bindings to the typed
// Env, builds `buildD1Repos(createDb(env.DB))`, serves the same
// `buildApp(...)`, and runs the TTL pruner as a Cron Trigger. Run locally
// with `wrangler dev`.
//
// Kept as a stub (not deleted) so the file path + scripts survive until
// the Worker entrypoint replaces it.

throw new Error(
  'id-api runs on Cloudflare Workers now — the Node entrypoint was retired in the D1 migration (#313). ' +
    'The Worker entrypoint (src/worker.ts) lands in Phase 2; run locally with `wrangler dev`.',
)

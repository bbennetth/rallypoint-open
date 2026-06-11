// Dev seeding moved off Node/Postgres in the native-Cloudflare migration
// (#313). With D1, seed the local dev database via wrangler instead, e.g.
//   wrangler d1 execute <db> --local --command "INSERT INTO users ..."
// or a seed run inside `wrangler dev`. A D1-aware seed lands with the
// id-api Worker entrypoint in Phase 2 (it can reuse buildD1Repos +
// createPasswordHasher against the Worker's env.DB binding).
//
// Kept as a stub (not deleted) so the `db:seed` script path survives.

throw new Error(
  'seed-dev was retired in the D1 migration (#313) — there is no Node Postgres connection to seed. ' +
    'Seed the local D1 via `wrangler d1 execute --local` (a D1-aware seed lands in Phase 2).',
)

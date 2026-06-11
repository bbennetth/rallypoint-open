// The Node Postgres migration runner was retired in the native-Cloudflare
// D1 migration. D1 migrations live in ./migrations (regenerated as
// SQLite via `npm run planner:db:generate`) and are applied with wrangler:
//   wrangler d1 migrations apply <DB> --env <qa|prod>      (deploy)
//   readD1Migrations(...) + applyD1Migrations(...)          (tests)
// The wrangler binding + apply step are wired with the planner-api Worker in
// Phase 5. Kept as a stub so the `planner:db:migrate` script path survives.

throw new Error(
  'packages/planner-db migrate runner was retired in the D1 migration. ' +
    'Apply D1 migrations with `wrangler d1 migrations apply` (deploy) or readD1Migrations (tests).',
)

// The Node Postgres migration runner was retired in the native-Cloudflare
// migration (#313). D1 migrations live in ./migrations (regenerated as
// SQLite via `npm run db:generate`) and are applied with wrangler:
//   wrangler d1 migrations apply <DB> --env <qa|prod>      (deploy)
//   readD1Migrations(...) + applyD1Migrations(...)          (tests)
// The wrangler binding + apply step are wired with the id-api Worker in
// Phase 2. Kept as a stub so the `db:migrate` script path survives.

throw new Error(
  'packages/db migrate runner was retired in the D1 migration (#313). ' +
    'Apply D1 migrations with `wrangler d1 migrations apply` (deploy) or readD1Migrations (tests).',
)

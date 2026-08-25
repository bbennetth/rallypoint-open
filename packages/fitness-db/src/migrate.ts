// The Node Postgres migration runner was never used for fitness-db.
// D1 migrations live in ./migrations (regenerated as
// SQLite via `npm run fitness:db:generate`) and are applied with wrangler:
//   wrangler d1 migrations apply <DB> --env <qa|prod>      (deploy)
//   readD1Migrations(...) + applyD1Migrations(...)          (tests)
// The wrangler binding + apply step are wired with the fitness-api Worker.
// Kept as a stub so the `fitness:db:migrate` script path survives.

throw new Error(
  'packages/fitness-db migrate runner is a stub. ' +
    'Apply D1 migrations with `wrangler d1 migrations apply` (deploy) or readD1Migrations (tests).',
)

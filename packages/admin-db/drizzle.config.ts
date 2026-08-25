import { defineConfig } from 'drizzle-kit'

// Drizzle migration tooling for Rallypoint Admin. Schema files live under
// src/schema/; generated SQLite/D1 SQL lands in ./migrations and is applied
// with `wrangler d1 migrations apply` (deploy) / readD1Migrations (tests).
// Mirrors packages/fitness-db/drizzle.config.ts.

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './migrations',
  dialect: 'sqlite',
  strict: true,
  verbose: true,
})

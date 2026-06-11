import { defineConfig } from 'drizzle-kit'

// Drizzle migration tooling for Rallypoint Lists. Schema files live under
// src/schema/; generated SQLite/D1 SQL lands in ./migrations and is
// applied with `wrangler d1 migrations apply` (deploy) / readD1Migrations
// (tests). Mirrors the @rallypoint/db (RPID) config after the
// native-Cloudflare migration (#313).

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './migrations',
  dialect: 'sqlite',
  strict: true,
  verbose: true,
})

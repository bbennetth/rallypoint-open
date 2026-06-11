import { defineConfig } from 'drizzle-kit'

// Drizzle migration tooling config. Schema files live under
// src/schema/; generated SQL lands in ./migrations.

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './migrations',
  dialect: 'sqlite',
  strict: true,
  verbose: true,
})

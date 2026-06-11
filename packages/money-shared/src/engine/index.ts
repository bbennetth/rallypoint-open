// Barrel re-export for the pure split + balance engine. Imported by
// both apps/money-api (server resolution + balance projection) and
// apps/money-web (live split previews as the user types).

export * from './split.js'
export * from './balances.js'

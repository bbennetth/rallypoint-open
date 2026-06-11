// Repo-layer error shared by the in-memory and D1 impls, so route
// handlers can catch a single type regardless of backend. The D1 unique
// detector lives in repos/d1/_errors.ts (mapUniqueViolation); the old
// Postgres SQLSTATE-23505 helper was removed with the pg repos (#313).

export class UniqueConstraintError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UniqueConstraintError'
  }
}

import { UniqueConstraintError } from '../errors.js'

// Map D1/SQLite unique-violation errors to our typed UniqueConstraintError.
// SQLite raises SQLITE_CONSTRAINT_UNIQUE with the message
// "UNIQUE constraint failed: <table>.<col>", but drizzle's d1 driver wraps
// it: the outer error's message is "Failed query: …" and the SQLite text
// lives on the `.cause` chain. So we walk message + causes rather than
// checking only the top-level message.

export function mapUniqueViolation(err: unknown): Error {
  const seen = new Set<unknown>()
  let cur: unknown = err
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur)
    const msg = (cur as { message?: unknown }).message
    if (typeof msg === 'string' && msg.includes('UNIQUE constraint failed')) {
      // e.g. "UNIQUE constraint failed: groups.event_id, groups.name"
      const match = /UNIQUE constraint failed: ([^\n]+)/.exec(msg)
      return new UniqueConstraintError(match?.[1] ?? 'unknown')
    }
    cur = (cur as { cause?: unknown }).cause
  }
  return err as Error
}

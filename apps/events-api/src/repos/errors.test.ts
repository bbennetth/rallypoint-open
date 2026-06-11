// Unit tests for the UniqueConstraintError / isUniqueViolation helpers
// (issue #115: PG repos should forward the real constraint name, not a
//  hard-coded one).

import { describe, it, expect } from 'vitest'
import { UniqueConstraintError, isUniqueViolation } from './errors.js'

// ---------------------------------------------------------------------------
// UniqueConstraintError shape
// ---------------------------------------------------------------------------

describe('UniqueConstraintError', () => {
  it('sets name, message, and constraintName from the constructor arg', () => {
    const err = new UniqueConstraintError('groups_event_name_idx')
    expect(err.name).toBe('UniqueConstraintError')
    expect(err.message).toBe('groups_event_name_idx')
    expect(err.constraintName).toBe('groups_event_name_idx')
  })

  it('is an instanceof Error', () => {
    expect(new UniqueConstraintError('x')).toBeInstanceOf(Error)
  })
})

// ---------------------------------------------------------------------------
// isUniqueViolation — returns constraint name or false
// ---------------------------------------------------------------------------

describe('isUniqueViolation', () => {
  // Helper to fabricate a postgres-driver-style 23505 error
  function pgError(constraint: string): Error & { code: string; constraint: string } {
    const e = new Error('duplicate key') as Error & { code: string; constraint: string }
    e.code = '23505'
    e.constraint = constraint
    return e
  }

  // Helper to fabricate a drizzle-wrapped error (cause = pg error)
  function drizzleWrapped(constraint: string): Error & { cause: unknown } {
    const wrapped = new Error('drizzle wrapper') as Error & { cause: unknown }
    wrapped.cause = pgError(constraint)
    return wrapped
  }

  it('returns the constraint name from a bare PG 23505 error', () => {
    expect(isUniqueViolation(pgError('groups_event_name_idx'))).toBe('groups_event_name_idx')
  })

  it('returns the constraint name from a drizzle-wrapped 23505 error', () => {
    expect(isUniqueViolation(drizzleWrapped('groups_join_code_hash_idx'))).toBe(
      'groups_join_code_hash_idx',
    )
  })

  it('returns false for a generic Error', () => {
    expect(isUniqueViolation(new Error('boom'))).toBe(false)
  })

  it('returns false for a PG error with a different code', () => {
    const e = new Error('fk violation') as Error & { code: string }
    e.code = '23503'
    expect(isUniqueViolation(e)).toBe(false)
  })

  it('returns false for null', () => {
    expect(isUniqueViolation(null)).toBe(false)
  })

  it('returns false for undefined', () => {
    expect(isUniqueViolation(undefined)).toBe(false)
  })

  it('returns false for a plain string', () => {
    expect(isUniqueViolation('23505')).toBe(false)
  })

  // When a 23505 fires but the driver does not supply a constraint name
  // (unusual but possible), we return an empty string rather than false.
  // Call sites use `!== false` (not a truthy check) so an empty string
  // still triggers UniqueConstraintError — it just carries no name.
  it('returns an empty string when constraint field is absent on the PG error', () => {
    const e = new Error('duplicate key') as Error & { code: string }
    e.code = '23505'
    expect(isUniqueViolation(e)).toBe('')
  })

  it('prefers constraint name on the top-level error over the cause', () => {
    // If somehow both levels carry 23505 (shouldn't happen in practice),
    // the top-level constraint name wins.
    const top = pgError('top_constraint')
    ;(top as unknown as Record<string, unknown>).cause = pgError('cause_constraint')
    expect(isUniqueViolation(top)).toBe('top_constraint')
  })

  // Constraint names for each affected table from issue #115
  it.each([
    ['groups_event_name_idx'],
    ['groups_join_code_hash_idx'],
    ['event_tickets_event_name_idx'],
    ['events_tenant_slug_idx'],
    ['event_stages_event_name_idx'],
    ['event_days_event_label_unique'],
    ['event_days_event_date_unique'],
    ['event_maps_event_layer_idx'],
    ['artists_lower_name_idx'],
    ['group_members_group_user_idx'],
  ])('round-trips constraint name %s', (name) => {
    expect(isUniqueViolation(pgError(name))).toBe(name)
    expect(isUniqueViolation(drizzleWrapped(name))).toBe(name)
  })
})

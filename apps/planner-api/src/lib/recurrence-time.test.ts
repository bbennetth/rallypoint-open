import { describe, it, expect } from 'vitest'
import type { ListItemDto } from '@rallypoint/lists-client'
import { resolveFloatingDue, resolveRecurrenceDues } from './recurrence-time.js'

function task(over: Partial<ListItemDto> & { id: string }): ListItemDto {
  return {
    listId: 'list_1',
    title: 'Task',
    notes: null,
    assignedTo: null,
    completed: false,
    completedAt: null,
    status: null,
    statusId: null,
    parentId: null,
    priority: null,
    dueDate: null,
    position: 0,
    customFields: {},
    seriesId: null,
    createdBy: 'user_a',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...over,
  }
}

describe('resolveFloatingDue', () => {
  it('reinterprets the UTC-stamped wall-clock as local time in tz (Pacific, summer)', () => {
    // 10:30 floating, viewed in PDT (UTC−7) → 17:30Z. This is the reported bug:
    // the raw stamp rendered as 03:30 local; resolved it renders as 10:30 local.
    expect(resolveFloatingDue('2026-06-15T10:30:00.000Z', 'America/Los_Angeles')).toBe(
      '2026-06-15T17:30:00.000Z',
    )
  })

  it('is a no-op in UTC', () => {
    expect(resolveFloatingDue('2026-06-15T10:30:00.000Z', 'UTC')).toBe('2026-06-15T10:30:00.000Z')
  })

  it('resolves in an eastern zone (New York, EDT −4)', () => {
    expect(resolveFloatingDue('2026-06-15T10:30:00.000Z', 'America/New_York')).toBe(
      '2026-06-15T14:30:00.000Z',
    )
  })

  it('honors DST per occurrence — 10:30 stays local across the PST/PDT split', () => {
    // Floating means "10:30 local" regardless of season: PDT in June (−7) and
    // PST in January (−8) yield different instants for the same wall-clock.
    expect(resolveFloatingDue('2026-06-15T10:30:00.000Z', 'America/Los_Angeles')).toBe(
      '2026-06-15T17:30:00.000Z',
    )
    expect(resolveFloatingDue('2026-01-15T10:30:00.000Z', 'America/Los_Angeles')).toBe(
      '2026-01-15T18:30:00.000Z',
    )
  })

  it('keeps an early-morning occurrence on its own calendar day (the wrong-day edge)', () => {
    // 03:00 floating in PDT → 10:00Z, still Jun 15. The raw stamp (03:00Z)
    // would render as Jun 14 20:00 local — wrong day AND wrong time.
    expect(resolveFloatingDue('2026-06-15T03:00:00.000Z', 'America/Los_Angeles')).toBe(
      '2026-06-15T10:00:00.000Z',
    )
  })

  it('anchors a no-time (all-day) occurrence to local midnight in tz', () => {
    expect(resolveFloatingDue('2026-06-15T00:00:00.000Z', 'America/Los_Angeles')).toBe(
      '2026-06-15T07:00:00.000Z',
    )
  })

  it('returns a non-floating string unchanged (defensive)', () => {
    expect(resolveFloatingDue('not-a-date', 'America/Los_Angeles')).toBe('not-a-date')
  })
})

describe('resolveRecurrenceDues', () => {
  const tz = 'America/Los_Angeles'

  it('resolves a series-backed item but leaves a one-off item untouched', () => {
    const out = resolveRecurrenceDues(
      [
        task({ id: 'chore', seriesId: 'lse_1', dueDate: '2026-06-15T10:30:00.000Z' }),
        // One-off due: a genuine absolute instant (client-anchored to local
        // midnight) — must NOT be reinterpreted.
        task({ id: 'one-off', seriesId: null, dueDate: '2026-06-15T07:00:00.000Z' }),
      ],
      tz,
    )
    expect(out.find((t) => t.id === 'chore')?.dueDate).toBe('2026-06-15T17:30:00.000Z')
    expect(out.find((t) => t.id === 'one-off')?.dueDate).toBe('2026-06-15T07:00:00.000Z')
  })

  it('leaves a series item with a null due untouched', () => {
    const out = resolveRecurrenceDues([task({ id: 'no-due', seriesId: 'lse_1', dueDate: null })], tz)
    expect(out[0]?.dueDate).toBeNull()
  })

  it('passes a series item with a non-floating due through unchanged (defensive)', () => {
    const out = resolveRecurrenceDues([task({ id: 'weird', seriesId: 'lse_1', dueDate: 'not-an-iso' })], tz)
    expect(out[0]?.dueDate).toBe('not-an-iso')
  })

  it('does not mutate the input array or its items', () => {
    const input = [task({ id: 'chore', seriesId: 'lse_1', dueDate: '2026-06-15T10:30:00.000Z' })]
    const out = resolveRecurrenceDues(input, tz)
    expect(input[0]?.dueDate).toBe('2026-06-15T10:30:00.000Z') // original unchanged
    expect(out).not.toBe(input)
    expect(out[0]).not.toBe(input[0])
  })
})

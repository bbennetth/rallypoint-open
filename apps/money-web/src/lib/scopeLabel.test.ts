import { describe, it, expect } from 'vitest'
import { formatLedgerScope } from './scopeLabel.js'

describe('formatLedgerScope', () => {
  it('renders a personal scope without an id suffix', () => {
    expect(formatLedgerScope('personal', 'user_01JT6Z0000000000000000')).toBe('Personal')
  })

  it('renders a group scope with a short id suffix', () => {
    expect(formatLedgerScope('group', 'grp_01JT6ZABCDEF')).toBe('Group ·ABCDEF')
  })

  it('renders a ledger_group scope with a short id suffix', () => {
    expect(formatLedgerScope('ledger_group', 'lgrp_01JT6ZFEDCBA')).toBe(
      'Shared ledger group ·FEDCBA',
    )
  })

  it('falls back to the raw pair for an unrecognized scope type', () => {
    expect(formatLedgerScope('mystery', 'abc')).toBe('mystery:abc')
  })
})

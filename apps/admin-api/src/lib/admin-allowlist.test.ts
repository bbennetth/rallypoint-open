import { describe, it, expect } from 'vitest'
import { parseAdminUserIds, isAdminUser } from './admin-allowlist.js'

describe('parseAdminUserIds', () => {
  it('returns an empty list for undefined / empty input (nobody is admin)', () => {
    expect(parseAdminUserIds(undefined)).toEqual([])
    expect(parseAdminUserIds('')).toEqual([])
  })

  it('splits on commas and trims whitespace', () => {
    expect(parseAdminUserIds('user_a, user_b ,user_c')).toEqual(['user_a', 'user_b', 'user_c'])
  })

  it('drops empty segments (trailing / doubled commas)', () => {
    expect(parseAdminUserIds('user_a,,user_b,')).toEqual(['user_a', 'user_b'])
    expect(parseAdminUserIds(' , ')).toEqual([])
  })
})

describe('isAdminUser', () => {
  it('true only for an allowlisted id', () => {
    expect(isAdminUser('user_a', 'user_a,user_b')).toBe(true)
    expect(isAdminUser('user_c', 'user_a,user_b')).toBe(false)
  })

  it('never matches on an empty allowlist', () => {
    expect(isAdminUser('user_a', '')).toBe(false)
    expect(isAdminUser('', '')).toBe(false)
  })

  it('does not substring-match ids', () => {
    expect(isAdminUser('user_a', 'user_ab')).toBe(false)
    expect(isAdminUser('user_ab', 'user_a')).toBe(false)
  })
})

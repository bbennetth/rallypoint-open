import { describe, it, expect } from 'vitest'
import {
  DEFAULT_GROUP_NAME,
  isWritableGroup,
  needsDefaultGroup,
  selectDefaultGroupId,
} from './default-group.js'
import type { GroupDto } from './api.js'

const group = (id: string, origin: string | null): GroupDto => ({
  id,
  name: id,
  description: null,
  origin,
  created_by: 'user_test',
  created_at: '2026-06-11T00:00:00.000Z',
  updated_at: '2026-06-11T00:00:00.000Z',
})

describe('isWritableGroup', () => {
  it('treats null-origin (Lists-owned) groups as writable', () => {
    expect(isWritableGroup(group('a', null))).toBe(true)
  })
  it('treats planner-origin groups as read-only', () => {
    expect(isWritableGroup(group('b', 'planner'))).toBe(false)
  })
})

describe('needsDefaultGroup', () => {
  it('needs a default when the user has no groups at all', () => {
    expect(needsDefaultGroup([])).toBe(true)
  })
  it('needs a default when the only group is the Planner one', () => {
    expect(needsDefaultGroup([group('mytasks', 'planner')])).toBe(true)
  })
  it('does not need a default once a writable group exists', () => {
    expect(needsDefaultGroup([group('mytasks', 'planner'), group('mine', null)])).toBe(false)
  })
})

describe('selectDefaultGroupId', () => {
  it('prefers the first writable group over a planner group', () => {
    expect(selectDefaultGroupId([group('mytasks', 'planner'), group('mine', null)])).toBe('mine')
  })
  it('returns null when only planner groups exist', () => {
    expect(selectDefaultGroupId([group('mytasks', 'planner')])).toBeNull()
  })
  it('returns null for an empty list', () => {
    expect(selectDefaultGroupId([])).toBeNull()
  })
})

describe('DEFAULT_GROUP_NAME', () => {
  it('is distinct from the Planner reserved name', () => {
    expect(DEFAULT_GROUP_NAME).not.toBe('My Tasks')
  })
})

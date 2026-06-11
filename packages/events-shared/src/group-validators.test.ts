import { describe, it, expect } from 'vitest'
import {
  groupNameField,
  groupDescriptionField,
  assignableGroupRoleField,
  joinCodeField,
  CreateGroupSchema,
  PatchGroupSchema,
  JoinGroupSchema,
  CreateGroupInviteSchema,
  SetGroupRoleSchema,
  TransferGroupSchema,
} from './group-validators.js'

describe('groupNameField', () => {
  it('accepts and trims a normal name', () => {
    expect(groupNameField.parse('  Night Owls  ')).toBe('Night Owls')
  })
  it('rejects empty / whitespace-only', () => {
    expect(groupNameField.safeParse('   ').success).toBe(false)
  })
  it('rejects over 100 chars', () => {
    expect(groupNameField.safeParse('x'.repeat(101)).success).toBe(false)
  })
})

describe('groupDescriptionField', () => {
  it('normalises empty string to null', () => {
    expect(groupDescriptionField.parse('')).toBeNull()
    expect(groupDescriptionField.parse('   ')).toBeNull()
  })
  it('leaves absent as undefined', () => {
    expect(groupDescriptionField.parse(undefined)).toBeUndefined()
  })
  it('rejects over 5000 chars', () => {
    expect(groupDescriptionField.safeParse('x'.repeat(5001)).success).toBe(false)
  })
})

describe('assignableGroupRoleField', () => {
  it('accepts sidekick and member', () => {
    expect(assignableGroupRoleField.parse('sidekick')).toBe('sidekick')
    expect(assignableGroupRoleField.parse('member')).toBe('member')
  })
  it('rejects owner (transfer-only)', () => {
    expect(assignableGroupRoleField.safeParse('owner').success).toBe(false)
  })
  it('rejects unknown roles', () => {
    expect(assignableGroupRoleField.safeParse('captain').success).toBe(false)
  })
})

describe('joinCodeField', () => {
  const realCode = 'rpj_AbC-123_xyz_padded_to_real_length'
  it('accepts an rpj_ code', () => {
    expect(joinCodeField.parse(realCode)).toBe(realCode)
  })
  it('rejects a non-rpj prefix', () => {
    expect(joinCodeField.safeParse('rpe_AbC123_padded_to_real_length').success).toBe(false)
  })
  it('rejects empty', () => {
    expect(joinCodeField.safeParse('').success).toBe(false)
  })
  it('rejects a too-short code', () => {
    expect(joinCodeField.safeParse('rpj_short').success).toBe(false)
  })
})

describe('CreateGroupSchema', () => {
  it('accepts a name-only body', () => {
    const r = CreateGroupSchema.safeParse({ name: 'Group A' })
    expect(r.success).toBe(true)
  })
  it('accepts name + dates in order', () => {
    const r = CreateGroupSchema.safeParse({
      name: 'Group A',
      startDate: '2026-06-01',
      endDate: '2026-06-03',
    })
    expect(r.success).toBe(true)
  })
  it('rejects missing name', () => {
    expect(CreateGroupSchema.safeParse({}).success).toBe(false)
  })
  it('rejects endDate before startDate', () => {
    const r = CreateGroupSchema.safeParse({
      name: 'Group A',
      startDate: '2026-06-03',
      endDate: '2026-06-01',
    })
    expect(r.success).toBe(false)
  })
})

describe('PatchGroupSchema', () => {
  it('accepts a single field', () => {
    expect(PatchGroupSchema.safeParse({ name: 'Renamed' }).success).toBe(true)
  })
  it('clears description with empty string', () => {
    const r = PatchGroupSchema.parse({ description: '' })
    expect(r.description).toBeNull()
  })
  it('rejects an empty body', () => {
    expect(PatchGroupSchema.safeParse({}).success).toBe(false)
  })
  it('rejects endDate before startDate', () => {
    const r = PatchGroupSchema.safeParse({ startDate: '2026-06-03', endDate: '2026-06-01' })
    expect(r.success).toBe(false)
  })
})

describe('JoinGroupSchema', () => {
  it('accepts a valid code', () => {
    expect(JoinGroupSchema.safeParse({ code: 'rpj_abc123_padded_to_real_length' }).success).toBe(
      true,
    )
  })
  it('rejects a bad code', () => {
    expect(JoinGroupSchema.safeParse({ code: 'nope' }).success).toBe(false)
  })
})

describe('CreateGroupInviteSchema', () => {
  it('accepts an empty body (open-code invite)', () => {
    expect(CreateGroupInviteSchema.safeParse({}).success).toBe(true)
  })
  it('lowercases the invited email', () => {
    const r = CreateGroupInviteSchema.parse({ invitedEmail: 'Foo@Bar.COM' })
    expect(r.invitedEmail).toBe('foo@bar.com')
  })
  it('rejects a malformed email', () => {
    expect(CreateGroupInviteSchema.safeParse({ invitedEmail: 'not-an-email' }).success).toBe(false)
  })
})

describe('SetGroupRoleSchema', () => {
  it('accepts an assignable role', () => {
    expect(SetGroupRoleSchema.safeParse({ role: 'sidekick' }).success).toBe(true)
  })
  it('rejects owner', () => {
    expect(SetGroupRoleSchema.safeParse({ role: 'owner' }).success).toBe(false)
  })
})

describe('TransferGroupSchema', () => {
  it('accepts a user id', () => {
    expect(TransferGroupSchema.safeParse({ newOwnerUserId: 'user_abc' }).success).toBe(true)
  })
  it('rejects a missing user id', () => {
    expect(TransferGroupSchema.safeParse({}).success).toBe(false)
  })
})

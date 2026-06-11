import { describe, expect, it } from 'vitest'
import {
  TICKET_PLATFORMS,
  ticketPlatformField,
  ticketPlatformLabel,
  ticketPlatformLoginUrl,
  ticketPlatformMeta,
} from './ticket-platforms.js'
import { CreatePersonalEventSchema, PatchPersonalEventSchema } from './validators.js'

describe('TICKET_PLATFORMS list', () => {
  it('includes the curated majors + the `other` escape hatch', () => {
    const ids = TICKET_PLATFORMS.map((p) => p.id)
    expect(ids).toContain('ticketmaster')
    expect(ids).toContain('eventbrite')
    expect(ids).toContain('other')
  })
  it('every non-other platform has an https loginUrl; other has none', () => {
    for (const p of TICKET_PLATFORMS) {
      if (p.id === 'other') expect(p.loginUrl).toBeNull()
      else expect(p.loginUrl).toMatch(/^https:\/\//)
    }
  })
})

describe('ticketPlatform resolvers', () => {
  it('ticketPlatformLoginUrl resolves a known platform', () => {
    expect(ticketPlatformLoginUrl('eventbrite')).toBe('https://www.eventbrite.com/signin/')
  })
  it('ticketPlatformLoginUrl returns null for other/unknown/empty', () => {
    expect(ticketPlatformLoginUrl('other')).toBeNull()
    expect(ticketPlatformLoginUrl('nope')).toBeNull()
    expect(ticketPlatformLoginUrl(null)).toBeNull()
    expect(ticketPlatformLoginUrl(undefined)).toBeNull()
  })
  it('ticketPlatformLabel resolves / returns null for unknown', () => {
    expect(ticketPlatformLabel('axs')).toBe('AXS')
    expect(ticketPlatformLabel('nope')).toBeNull()
  })
  it('ticketPlatformMeta returns the full record or null', () => {
    expect(ticketPlatformMeta('dice')).toEqual({
      id: 'dice',
      label: 'DICE',
      loginUrl: 'https://dice.fm/account',
    })
    expect(ticketPlatformMeta('nope')).toBeNull()
  })
})

describe('ticketPlatformField', () => {
  it('accepts a known id, null, and undefined', () => {
    expect(ticketPlatformField.parse('stubhub')).toBe('stubhub')
    expect(ticketPlatformField.parse(null)).toBeNull()
    expect(ticketPlatformField.parse(undefined)).toBeUndefined()
  })
  it('rejects an unknown id', () => {
    expect(ticketPlatformField.safeParse('myspace').success).toBe(false)
  })
})

describe('personal-event schemas with ticket fields', () => {
  it('CreatePersonalEventSchema accepts platform + lowercased email', () => {
    const parsed = CreatePersonalEventSchema.parse({
      name: 'Concert',
      ticketPlatform: 'ticketmaster',
      ticketAccountEmail: 'Fan@Example.COM',
    })
    expect(parsed.ticketPlatform).toBe('ticketmaster')
    expect(parsed.ticketAccountEmail).toBe('fan@example.com')
  })
  it('CreatePersonalEventSchema rejects a malformed email', () => {
    const r = CreatePersonalEventSchema.safeParse({ name: 'X', ticketAccountEmail: 'not-an-email' })
    expect(r.success).toBe(false)
  })
  it('CreatePersonalEventSchema rejects an unknown platform', () => {
    const r = CreatePersonalEventSchema.safeParse({ name: 'X', ticketPlatform: 'ticketzilla' })
    expect(r.success).toBe(false)
  })
  it('PatchPersonalEventSchema accepts null to clear both fields', () => {
    const parsed = PatchPersonalEventSchema.parse({ ticketPlatform: null, ticketAccountEmail: null })
    expect(parsed.ticketPlatform).toBeNull()
    expect(parsed.ticketAccountEmail).toBeNull()
  })
})

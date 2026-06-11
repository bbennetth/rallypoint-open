import { describe, it, expect } from 'vitest'
import {
  eventNameField,
  eventDescriptionField,
  eventSlugField,
  eventDateField,
  eventTimezoneField,
  privacyModeField,
  assignableRoleField,
  inviteCodeField,
  CreateEventSchema,
  PatchEventSchema,
  CreateInviteSchema,
  AcceptInviteSchema,
  TransferOwnershipSchema,
  setTimeField,
  tierField,
  CreateStageSchema,
  PatchStageSchema,
  CreateDaySchema,
  PatchDaySchema,
  CreateArtistSchema,
  PatchArtistSchema,
  LineupSlotSchema,
  BulkLineupSchema,
  CreatePoiSchema,
  PatchPoiSchema,
  CreateZoneSchema,
  scopeTypeField,
  eventInstantField,
  CreatePersonalEventSchema,
  PatchPersonalEventSchema,
} from './validators.js'

describe('eventNameField', () => {
  it('accepts and trims a normal name', () => {
    expect(eventNameField.parse('  Summer Fest  ')).toBe('Summer Fest')
  })
  it('rejects empty / whitespace-only', () => {
    expect(eventNameField.safeParse('   ').success).toBe(false)
  })
  it('rejects over 100 chars', () => {
    expect(eventNameField.safeParse('a'.repeat(101)).success).toBe(false)
  })
  it('accepts exactly 100 chars', () => {
    expect(eventNameField.safeParse('a'.repeat(100)).success).toBe(true)
  })
})

describe('eventDescriptionField', () => {
  it('passes text through trimmed', () => {
    expect(eventDescriptionField.parse('  hello  ')).toBe('hello')
  })
  it('normalises empty string to null (a PATCH clear signal)', () => {
    expect(eventDescriptionField.parse('')).toBeNull()
    expect(eventDescriptionField.parse('   ')).toBeNull()
  })
  it('accepts explicit null', () => {
    expect(eventDescriptionField.parse(null)).toBeNull()
  })
  it('accepts undefined (leave alone)', () => {
    expect(eventDescriptionField.parse(undefined)).toBeUndefined()
  })
  it('rejects over 5000 chars', () => {
    expect(eventDescriptionField.safeParse('a'.repeat(5001)).success).toBe(false)
  })
})

describe('eventSlugField', () => {
  it('accepts kebab-case and lowercases', () => {
    expect(eventSlugField.parse('Summer-Fest-2026')).toBe('summer-fest-2026')
  })
  it.each([
    ['leading hyphen', '-foo'],
    ['trailing hyphen', 'foo-'],
    ['double hyphen', 'foo--bar'],
    ['space', 'foo bar'],
    ['underscore', 'foo_bar'],
    ['empty', ''],
  ])('rejects %s', (_label, val) => {
    expect(eventSlugField.safeParse(val).success).toBe(false)
  })
  it('rejects over 50 chars', () => {
    expect(eventSlugField.safeParse('a'.repeat(51)).success).toBe(false)
  })
})

describe('eventDateField', () => {
  it('accepts a valid ISO date', () => {
    expect(eventDateField.parse('2026-05-28')).toBe('2026-05-28')
  })
  it.each([
    ['bad shape', '2026/05/28'],
    ['month 13', '2026-13-01'],
    ['feb 30', '2026-02-30'],
    ['no zero pad', '2026-5-8'],
    ['datetime', '2026-05-28T00:00:00Z'],
  ])('rejects %s', (_label, val) => {
    expect(eventDateField.safeParse(val).success).toBe(false)
  })
})

describe('eventTimezoneField', () => {
  it('accepts a canonical zone', () => {
    expect(eventTimezoneField.parse('America/New_York')).toBe('America/New_York')
  })
  it('accepts UTC', () => {
    expect(eventTimezoneField.parse('UTC')).toBe('UTC')
  })
  it('rejects gibberish', () => {
    expect(eventTimezoneField.safeParse('Not/A_Zone_xyz').success).toBe(false)
  })
  it('rejects empty', () => {
    expect(eventTimezoneField.safeParse('').success).toBe(false)
  })
})

describe('privacyModeField', () => {
  it.each(['public', 'unlisted', 'private'])('accepts %s', (m) => {
    expect(privacyModeField.parse(m)).toBe(m)
  })
  it('rejects unknown', () => {
    expect(privacyModeField.safeParse('secret').success).toBe(false)
  })
})

describe('assignableRoleField', () => {
  it.each(['editor', 'viewer'])('accepts %s', (r) => {
    expect(assignableRoleField.parse(r)).toBe(r)
  })
  it('rejects owner (not invite-assignable)', () => {
    expect(assignableRoleField.safeParse('owner').success).toBe(false)
  })
})

describe('inviteCodeField', () => {
  it('accepts an rpe_ token', () => {
    expect(inviteCodeField.parse('rpe_abc-DEF_123')).toBe('rpe_abc-DEF_123')
  })
  it('rejects wrong prefix', () => {
    expect(inviteCodeField.safeParse('xxx_abc').success).toBe(false)
  })
  it('rejects empty body', () => {
    expect(inviteCodeField.safeParse('rpe_').success).toBe(false)
  })
})

describe('CreateEventSchema', () => {
  const base = { name: 'Fest', timezone: 'UTC' }

  it('accepts the minimal valid body', () => {
    expect(CreateEventSchema.safeParse(base).success).toBe(true)
  })
  it('accepts a full body', () => {
    const r = CreateEventSchema.safeParse({
      ...base,
      slug: 'fest-2026',
      description: 'A festival',
      startDate: '2026-06-01',
      endDate: '2026-06-03',
      locationLabel: 'The Park',
      locationLat: 40.7,
      locationLng: -73.9,
      privacyMode: 'public',
    })
    expect(r.success).toBe(true)
  })
  it('rejects missing name', () => {
    expect(CreateEventSchema.safeParse({ timezone: 'UTC' }).success).toBe(false)
  })
  it('rejects missing timezone', () => {
    expect(CreateEventSchema.safeParse({ name: 'Fest' }).success).toBe(false)
  })
  it('rejects endDate before startDate', () => {
    const r = CreateEventSchema.safeParse({
      ...base,
      startDate: '2026-06-03',
      endDate: '2026-06-01',
    })
    expect(r.success).toBe(false)
  })
  it('accepts equal start/end dates', () => {
    const r = CreateEventSchema.safeParse({
      ...base,
      startDate: '2026-06-01',
      endDate: '2026-06-01',
    })
    expect(r.success).toBe(true)
  })
  it('rejects lat without lng', () => {
    expect(CreateEventSchema.safeParse({ ...base, locationLat: 40.7 }).success).toBe(false)
  })
  it('rejects lng without lat', () => {
    expect(CreateEventSchema.safeParse({ ...base, locationLng: -73.9 }).success).toBe(false)
  })
  it('rejects out-of-range lat', () => {
    expect(
      CreateEventSchema.safeParse({ ...base, locationLat: 91, locationLng: 0 }).success,
    ).toBe(false)
  })
})

describe('PatchEventSchema', () => {
  it('accepts a single-field patch', () => {
    expect(PatchEventSchema.safeParse({ name: 'New' }).success).toBe(true)
  })
  it('rejects an empty patch', () => {
    expect(PatchEventSchema.safeParse({}).success).toBe(false)
  })
  it('allows clearing nullable dates', () => {
    expect(PatchEventSchema.safeParse({ startDate: null }).success).toBe(true)
  })
  it('rejects endDate before startDate', () => {
    const r = PatchEventSchema.safeParse({ startDate: '2026-06-03', endDate: '2026-06-01' })
    expect(r.success).toBe(false)
  })
})

describe('CreateInviteSchema', () => {
  it('accepts an open-code invite (no email)', () => {
    const r = CreateInviteSchema.safeParse({ role: 'editor' })
    expect(r.success).toBe(true)
  })
  it('accepts and lowercases an emailed invite', () => {
    const r = CreateInviteSchema.parse({ role: 'viewer', invitedEmail: 'A@B.COM' })
    expect(r.invitedEmail).toBe('a@b.com')
  })
  it('rejects owner role', () => {
    expect(CreateInviteSchema.safeParse({ role: 'owner' }).success).toBe(false)
  })
  it('rejects a malformed email', () => {
    expect(CreateInviteSchema.safeParse({ role: 'editor', invitedEmail: 'nope' }).success).toBe(
      false,
    )
  })
})

describe('AcceptInviteSchema', () => {
  it('accepts a valid code', () => {
    expect(AcceptInviteSchema.safeParse({ code: 'rpe_abc123' }).success).toBe(true)
  })
  it('rejects a bad code', () => {
    expect(AcceptInviteSchema.safeParse({ code: 'bad' }).success).toBe(false)
  })
})

describe('TransferOwnershipSchema', () => {
  it('accepts a valid body', () => {
    const r = TransferOwnershipSchema.safeParse({
      newOwnerUserId: 'usr_01H',
      currentPassword: 'hunter2hunter2',
    })
    expect(r.success).toBe(true)
  })
  it('rejects missing newOwnerUserId', () => {
    expect(TransferOwnershipSchema.safeParse({ currentPassword: 'x' }).success).toBe(false)
  })
  it('rejects empty currentPassword', () => {
    expect(
      TransferOwnershipSchema.safeParse({ newOwnerUserId: 'usr_1', currentPassword: '' }).success,
    ).toBe(false)
  })
})

describe('setTimeField', () => {
  it('accepts HH:MM and passes through', () => {
    expect(setTimeField.parse('18:30')).toBe('18:30')
  })
  it('normalises HH:MM:SS to HH:MM', () => {
    expect(setTimeField.parse('18:30:45')).toBe('18:30')
  })
  it('normalises empty string to null', () => {
    expect(setTimeField.parse('')).toBeNull()
  })
  it('accepts null / undefined', () => {
    expect(setTimeField.parse(null)).toBeNull()
    expect(setTimeField.parse(undefined)).toBeUndefined()
  })
  it.each(['24:00', '7:30', '18:60', 'noon', '18.30'])('rejects %s', (bad) => {
    expect(setTimeField.safeParse(bad).success).toBe(false)
  })
})

describe('tierField', () => {
  it.each(['headliner', 'support', 'opener'])('accepts %s', (t) => {
    expect(tierField.parse(t)).toBe(t)
  })
  it('accepts null/undefined', () => {
    expect(tierField.parse(null)).toBeNull()
    expect(tierField.parse(undefined)).toBeUndefined()
  })
  it('rejects unknown tier', () => {
    expect(tierField.safeParse('legend').success).toBe(false)
  })
})

describe('CreateStageSchema', () => {
  it('accepts a name with optional sortOrder', () => {
    expect(CreateStageSchema.safeParse({ name: 'Main Stage' }).success).toBe(true)
    expect(CreateStageSchema.safeParse({ name: 'Main', sortOrder: 2 }).success).toBe(true)
  })
  it('rejects an empty name', () => {
    expect(CreateStageSchema.safeParse({ name: '   ' }).success).toBe(false)
  })
  it('rejects a negative sortOrder', () => {
    expect(CreateStageSchema.safeParse({ name: 'Main', sortOrder: -1 }).success).toBe(false)
  })
})

describe('PatchStageSchema', () => {
  it('requires at least one field', () => {
    expect(PatchStageSchema.safeParse({}).success).toBe(false)
  })
  it('accepts a sortOrder-only patch', () => {
    expect(PatchStageSchema.safeParse({ sortOrder: 5 }).success).toBe(true)
  })
})

describe('CreateDaySchema', () => {
  it('accepts a label + valid date', () => {
    expect(CreateDaySchema.safeParse({ dayLabel: 'WED', date: '2026-06-17' }).success).toBe(true)
  })
  it('rejects an invalid calendar date', () => {
    expect(CreateDaySchema.safeParse({ dayLabel: 'WED', date: '2026-02-30' }).success).toBe(false)
  })
  it('rejects a missing label', () => {
    expect(CreateDaySchema.safeParse({ date: '2026-06-17' }).success).toBe(false)
  })
})

describe('PatchDaySchema', () => {
  it('requires at least one field', () => {
    expect(PatchDaySchema.safeParse({}).success).toBe(false)
  })
  it('accepts a date-only patch', () => {
    expect(PatchDaySchema.safeParse({ date: '2026-06-18' }).success).toBe(true)
  })
})

describe('CreateArtistSchema', () => {
  it('accepts a bare name', () => {
    expect(CreateArtistSchema.safeParse({ name: 'Skrillex' }).success).toBe(true)
  })
  it('accepts http(s) music links and clears empties to null', () => {
    const r = CreateArtistSchema.safeParse({
      name: 'Skrillex',
      spotify: 'https://open.spotify.com/artist/x',
      soundcloud: '',
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.spotify).toBe('https://open.spotify.com/artist/x')
      expect(r.data.soundcloud).toBeNull()
    }
  })
  it('rejects a non-http link', () => {
    expect(
      CreateArtistSchema.safeParse({ name: 'X', spotify: 'ftp://foo/bar' }).success,
    ).toBe(false)
  })
})

describe('PatchArtistSchema', () => {
  it('requires at least one field', () => {
    expect(PatchArtistSchema.safeParse({}).success).toBe(false)
  })
})

describe('LineupSlotSchema', () => {
  it('accepts a minimal slot (artist + day)', () => {
    expect(LineupSlotSchema.safeParse({ artistId: 'art_1', dayId: 'evd_1' }).success).toBe(true)
  })
  it('accepts a fully-specified slot', () => {
    const r = LineupSlotSchema.safeParse({
      artistId: 'art_1',
      dayId: 'evd_1',
      stageId: 'evs_1',
      tier: 'headliner',
      genre: 'dubstep',
      startTime: '22:00',
      endTime: '23:30',
      displayName: 'SKRILLEX b2b',
    })
    expect(r.success).toBe(true)
  })
  it('allows an end time before start time (crosses midnight)', () => {
    expect(
      LineupSlotSchema.safeParse({
        artistId: 'art_1',
        dayId: 'evd_1',
        startTime: '23:30',
        endTime: '01:00',
      }).success,
    ).toBe(true)
  })
  it('rejects a missing dayId', () => {
    expect(LineupSlotSchema.safeParse({ artistId: 'art_1' }).success).toBe(false)
  })
})

describe('BulkLineupSchema', () => {
  it('accepts 1..200 slots', () => {
    const slot = { artistId: 'art_1', dayId: 'evd_1' }
    expect(BulkLineupSchema.safeParse({ slots: [slot] }).success).toBe(true)
    expect(BulkLineupSchema.safeParse({ slots: Array(200).fill(slot) }).success).toBe(true)
  })
  it('rejects an empty array', () => {
    expect(BulkLineupSchema.safeParse({ slots: [] }).success).toBe(false)
  })
  it('rejects over 200 slots', () => {
    const slot = { artistId: 'art_1', dayId: 'evd_1' }
    expect(BulkLineupSchema.safeParse({ slots: Array(201).fill(slot) }).success).toBe(false)
  })
})

describe('CreatePoiSchema', () => {
  it('accepts a minimal POI', () => {
    expect(
      CreatePoiSchema.safeParse({ categoryId: 'water', name: 'Water 1', xPct: 10, yPct: 20 })
        .success,
    ).toBe(true)
  })
  it('rejects an unknown category', () => {
    expect(
      CreatePoiSchema.safeParse({ categoryId: 'nope', name: 'X', xPct: 10, yPct: 20 }).success,
    ).toBe(false)
  })
  it('rejects out-of-range coordinates', () => {
    expect(
      CreatePoiSchema.safeParse({ categoryId: 'water', name: 'X', xPct: 120, yPct: 20 }).success,
    ).toBe(false)
    expect(
      CreatePoiSchema.safeParse({ categoryId: 'water', name: 'X', xPct: 10, yPct: -1 }).success,
    ).toBe(false)
  })
  it('rejects out-of-range lat/lng', () => {
    expect(
      CreatePoiSchema.safeParse({
        categoryId: 'water',
        name: 'X',
        xPct: 10,
        yPct: 20,
        lat: 200,
      }).success,
    ).toBe(false)
  })
})

describe('PatchPoiSchema', () => {
  it('requires at least one field', () => {
    expect(PatchPoiSchema.safeParse({}).success).toBe(false)
  })
  it('accepts a position-only patch', () => {
    expect(PatchPoiSchema.safeParse({ xPct: 5, yPct: 5 }).success).toBe(true)
  })
})

describe('CreateZoneSchema', () => {
  const tri = [
    { xPct: 0, yPct: 0 },
    { xPct: 10, yPct: 0 },
    { xPct: 0, yPct: 10 },
  ]
  it('accepts a 3+ vertex polygon with a map id', () => {
    expect(CreateZoneSchema.safeParse({ mapId: 'emp_1', polygon: tri }).success).toBe(true)
  })
  it('rejects a polygon with fewer than 3 points', () => {
    expect(
      CreateZoneSchema.safeParse({ mapId: 'emp_1', polygon: tri.slice(0, 2) }).success,
    ).toBe(false)
  })
  it('rejects a missing map id', () => {
    expect(CreateZoneSchema.safeParse({ polygon: tri }).success).toBe(false)
  })
  it('rejects out-of-range vertices', () => {
    expect(
      CreateZoneSchema.safeParse({
        mapId: 'emp_1',
        polygon: [
          { xPct: 0, yPct: 0 },
          { xPct: 101, yPct: 0 },
          { xPct: 0, yPct: 10 },
        ],
      }).success,
    ).toBe(false)
  })
})

// --- Slice 2: scopeTypeField ----------------------------------------
describe('scopeTypeField', () => {
  it('accepts personal', () => {
    expect(scopeTypeField.parse('personal')).toBe('personal')
  })
  it('accepts group', () => {
    expect(scopeTypeField.parse('group')).toBe('group')
  })
  it('rejects unknown scope type', () => {
    expect(scopeTypeField.safeParse('admin').success).toBe(false)
  })
  it('rejects empty string', () => {
    expect(scopeTypeField.safeParse('').success).toBe(false)
  })
})

// --- Slice 2: eventInstantField ------------------------------------
describe('eventInstantField', () => {
  it('accepts a UTC Z instant', () => {
    expect(eventInstantField.parse('2026-06-03T18:00:00Z')).toBe('2026-06-03T18:00:00Z')
  })
  it('accepts an explicit +02:00 offset', () => {
    expect(eventInstantField.parse('2026-06-03T20:00:00+02:00')).toBe(
      '2026-06-03T20:00:00+02:00',
    )
  })
  it('rejects a date-only string (no time/offset)', () => {
    expect(eventInstantField.safeParse('2026-06-03').success).toBe(false)
  })
  it('rejects a datetime without offset', () => {
    // z.string().datetime({ offset: true }) requires an offset or Z.
    expect(eventInstantField.safeParse('2026-06-03T18:00:00').success).toBe(false)
  })
})

// --- Slice 2: CreatePersonalEventSchema ----------------------------
describe('CreatePersonalEventSchema', () => {
  it('accepts a minimal create (name only)', () => {
    const result = CreatePersonalEventSchema.safeParse({ name: 'Morning run' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.name).toBe('Morning run')
      expect(result.data.startAt).toBeUndefined()
      expect(result.data.endAt).toBeUndefined()
    }
  })

  it('accepts a full create with start + end instants', () => {
    const result = CreatePersonalEventSchema.safeParse({
      name: 'Team sync',
      startAt: '2026-06-03T09:00:00Z',
      endAt: '2026-06-03T10:00:00Z',
    })
    expect(result.success).toBe(true)
  })

  it('rejects when endAt precedes startAt', () => {
    const result = CreatePersonalEventSchema.safeParse({
      name: 'Oops',
      startAt: '2026-06-03T10:00:00Z',
      endAt: '2026-06-03T09:00:00Z',
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('endAt')
    }
  })

  it('rejects when name is absent', () => {
    expect(CreatePersonalEventSchema.safeParse({ startAt: '2026-06-03T09:00:00Z' }).success).toBe(
      false,
    )
  })

  it('accepts equal startAt and endAt (zero-length event)', () => {
    const result = CreatePersonalEventSchema.safeParse({
      name: 'Instant',
      startAt: '2026-06-03T12:00:00Z',
      endAt: '2026-06-03T12:00:00Z',
    })
    expect(result.success).toBe(true)
  })

  it('strips server-forced keys injected by a caller (#268)', () => {
    // scopeType / slug / privacyMode are forced server-side; the schema must
    // silently DROP them (Zod default .strip()) rather than surface them, so
    // a future .passthrough()/rewrite can't let a caller override them.
    const result = CreatePersonalEventSchema.safeParse({
      name: 'Sneaky',
      scopeType: 'group',
      slug: 'attacker-chosen',
      privacyMode: 'public',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.name).toBe('Sneaky')
      expect(result.data).not.toHaveProperty('scopeType')
      expect(result.data).not.toHaveProperty('slug')
      expect(result.data).not.toHaveProperty('privacyMode')
    }
  })
})

describe('PatchPersonalEventSchema', () => {
  it('accepts a single-field patch', () => {
    expect(PatchPersonalEventSchema.safeParse({ name: 'Renamed' }).success).toBe(true)
  })

  it('rejects an empty patch', () => {
    expect(PatchPersonalEventSchema.safeParse({}).success).toBe(false)
  })

  it('allows clearing nullable instants with null', () => {
    const r = PatchPersonalEventSchema.safeParse({ startAt: null, endAt: null })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.startAt).toBeNull()
      expect(r.data.endAt).toBeNull()
    }
  })

  it('normalises an empty locationLabel to null', () => {
    const r = PatchPersonalEventSchema.safeParse({ locationLabel: '' })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.locationLabel).toBeNull()
  })

  it('rejects when endAt precedes startAt in the same patch', () => {
    const r = PatchPersonalEventSchema.safeParse({
      startAt: '2026-06-03T10:00:00Z',
      endAt: '2026-06-03T09:00:00Z',
    })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues.map((i) => i.path.join('.'))).toContain('endAt')
  })

  it('accepts a patch that only moves endAt (cross-check deferred to the route)', () => {
    expect(PatchPersonalEventSchema.safeParse({ endAt: '2026-06-03T09:00:00Z' }).success).toBe(true)
  })
})

import { describe, expect, it } from 'vitest'
import {
  KNOWN_POSES,
  PROGRESS_PHOTO_MAX_BYTES,
  groupPhotosByDay,
  groupPhotosBySet,
  isProgressPhotoMimeType,
  poseLabel,
  poseSchema,
  primaryPhotoOfSet,
  progressPhotoUploadMetaSchema,
  setIdSchema,
  validateProgressPhotoUpload,
} from './progress-photos.js'

describe('poseSchema', () => {
  it('accepts curated pose ids', () => {
    for (const p of KNOWN_POSES) expect(poseSchema.safeParse(p.id).success).toBe(true)
  })

  it('accepts custom slugs', () => {
    expect(poseSchema.safeParse('side_flexed').success).toBe(true)
    expect(poseSchema.safeParse('legs2').success).toBe(true)
  })

  it('trims whitespace', () => {
    expect(poseSchema.parse('  front  ')).toBe('front')
  })

  it('rejects uppercase, spaces, symbols, empty, and over-length slugs', () => {
    for (const bad of ['Front', 'side flexed', 'side-flexed', '', 'a'.repeat(41)]) {
      expect(poseSchema.safeParse(bad).success).toBe(false)
    }
  })
})

describe('poseLabel', () => {
  it('uses the curated label for known poses', () => {
    expect(poseLabel('front')).toBe('Front')
  })

  it('spaces underscores for custom poses', () => {
    expect(poseLabel('side_flexed')).toBe('side flexed')
  })
})

describe('validateProgressPhotoUpload', () => {
  it('accepts a valid jpeg within limits', () => {
    const r = validateProgressPhotoUpload({ contentType: 'image/jpeg', contentLength: 100_000 })
    expect(r).toMatchObject({ ok: true, mimeType: 'image/jpeg', extension: 'jpg' })
  })

  it('rejects unsupported types', () => {
    for (const t of ['image/gif', 'image/heic', 'application/pdf', '']) {
      expect(validateProgressPhotoUpload({ contentType: t, contentLength: 100 })).toEqual({
        ok: false,
        code: 'unsupported_photo_type',
        field: 'contentType',
      })
    }
  })

  it('rejects zero, negative, non-finite, and oversize lengths', () => {
    for (const len of [0, -1, NaN, Infinity, PROGRESS_PHOTO_MAX_BYTES + 1]) {
      expect(
        validateProgressPhotoUpload({ contentType: 'image/png', contentLength: len }),
      ).toMatchObject({ ok: false, code: 'photo_too_large' })
    }
  })

  it('accepts exactly the max size', () => {
    expect(
      validateProgressPhotoUpload({
        contentType: 'image/webp',
        contentLength: PROGRESS_PHOTO_MAX_BYTES,
      }),
    ).toMatchObject({ ok: true, extension: 'webp' })
  })
})

describe('isProgressPhotoMimeType', () => {
  it('matches only the allow-list', () => {
    expect(isProgressPhotoMimeType('image/jpeg')).toBe(true)
    expect(isProgressPhotoMimeType('image/png')).toBe(true)
    expect(isProgressPhotoMimeType('image/webp')).toBe(true)
    expect(isProgressPhotoMimeType('image/svg+xml')).toBe(false)
  })
})

describe('progressPhotoUploadMetaSchema', () => {
  it('accepts pose only', () => {
    expect(progressPhotoUploadMetaSchema.safeParse({ pose: 'front' }).success).toBe(true)
  })

  it('accepts full metadata', () => {
    const r = progressPhotoUploadMetaSchema.safeParse({
      pose: 'side_flexed',
      takenAt: '2026-07-01T10:00:00.000Z',
      note: 'morning',
    })
    expect(r.success).toBe(true)
  })

  it('rejects missing pose and malformed takenAt', () => {
    expect(progressPhotoUploadMetaSchema.safeParse({}).success).toBe(false)
    expect(
      progressPhotoUploadMetaSchema.safeParse({ pose: 'front', takenAt: 'yesterday' }).success,
    ).toBe(false)
  })
})

describe('setIdSchema', () => {
  it('accepts fps_ + 26-char Crockford ULID and rejects other shapes', () => {
    expect(setIdSchema.safeParse('fps_01HZXW5T9G8YJ2M4N6P8Q0R1S2').success).toBe(true)
    for (const bad of ['fps_short', 'fpp_01HZXW5T9G8YJ2M4N6P8Q0R1S2', 'fps_01hzxw5t9g8yj2m4n6p8q0r1s2', '']) {
      expect(setIdSchema.safeParse(bad).success).toBe(false)
    }
  })
})

describe('groupPhotosBySet', () => {
  const photo = (id: string, setId: string | null, pose: string, takenAt: string) => ({
    id,
    setId,
    pose,
    takenAt,
  })

  it('groups by setId with legacy NULL rows as singletons', () => {
    const sets = groupPhotosBySet([
      photo('a', 'fps_X', 'front', '2026-07-01T10:00:00.000Z'),
      photo('b', null, 'side', '2026-07-02T10:00:00.000Z'),
      photo('c', 'fps_X', 'back', '2026-07-01T10:00:01.000Z'),
    ])
    expect(sets.map((s) => s.setKey)).toEqual(['b', 'fps_X'])
    expect(sets[1]!.photos.map((p) => p.id)).toEqual(['a', 'c']) // front before back
  })

  it('merges a set split by non-adjacent input (pagination boundary)', () => {
    const sets = groupPhotosBySet([
      photo('a', 'fps_X', 'front', '2026-07-01T10:00:00.000Z'),
      photo('b', 'fps_Y', 'front', '2026-06-30T10:00:00.000Z'),
      photo('c', 'fps_X', 'side', '2026-07-01T10:00:02.000Z'),
    ])
    expect(sets).toHaveLength(2)
    expect(sets[0]!.setKey).toBe('fps_X')
    expect(sets[0]!.photos.map((p) => p.id)).toEqual(['a', 'c'])
  })

  it('orders sets by newest photo and members by curated pose order then takenAt', () => {
    const sets = groupPhotosBySet([
      photo('s1', 'fps_A', 'side', '2026-07-01T10:00:00.000Z'),
      photo('b1', 'fps_A', 'back', '2026-07-01T10:00:05.000Z'),
      photo('x1', 'fps_A', 'legs', '2026-07-01T10:00:01.000Z'),
      photo('y1', 'fps_A', 'arms', '2026-07-01T10:00:00.000Z'),
    ])
    // back (curated) first, then side (curated), then customs oldest-first.
    expect(sets[0]!.photos.map((p) => p.id)).toEqual(['b1', 's1', 'y1', 'x1'])
  })
})

describe('primaryPhotoOfSet', () => {
  it('prefers front, else the first photo', () => {
    expect(
      primaryPhotoOfSet([{ pose: 'side' }, { pose: 'front' }, { pose: 'back' }]).pose,
    ).toBe('front')
    expect(primaryPhotoOfSet([{ pose: 'back' }, { pose: 'side' }]).pose).toBe('back')
  })
})

describe('groupPhotosByDay', () => {
  const photo = (id: string, takenAt: string) => ({ id, takenAt })

  it('returns empty for no photos', () => {
    expect(groupPhotosByDay([])).toEqual([])
  })

  it('groups same-local-day photos together, newest day first', () => {
    // Use local-noon times so the local calendar day matches the ISO date
    // in any test timezone.
    const a = photo('a', new Date(2026, 6, 1, 12, 0).toISOString())
    const b = photo('b', new Date(2026, 6, 1, 13, 0).toISOString())
    const c = photo('c', new Date(2026, 6, 3, 12, 0).toISOString())
    const groups = groupPhotosByDay([a, c, b])
    expect(groups).toHaveLength(2)
    expect(groups[0]!.dayKey).toBe('2026-07-03')
    expect(groups[0]!.photos.map((p) => p.id)).toEqual(['c'])
    expect(groups[1]!.dayKey).toBe('2026-07-01')
    // Within a day, newest first.
    expect(groups[1]!.photos.map((p) => p.id)).toEqual(['b', 'a'])
  })
})

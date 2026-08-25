import { describe, it, expect } from 'vitest'
import {
  encodeCursor,
  decodeCursorStrict,
  createCursorCodec,
  createKeysetCursorCodec,
  paginationQuery,
  buildPage,
  toPageDto,
  type CursorCodec,
} from './pagination.js'

describe('encodeCursor / decodeCursorStrict', () => {
  it('round-trips a scalar key tuple', () => {
    const key = ['2026-06-24T18:03:00.000Z', 'eva_01JT6']
    const enc = encodeCursor(key)
    expect(decodeCursorStrict(enc)).toEqual(key)
  })

  it('round-trips numeric keys', () => {
    expect(decodeCursorStrict(encodeCursor([42, 'itm_1']))).toEqual([42, 'itm_1'])
  })

  it('emits url-safe base64 with no padding', () => {
    const enc = encodeCursor(['2026-06-24T18:03:00.000Z', 'x'.repeat(20)])
    expect(enc).not.toMatch(/[+/=]/)
  })

  it('round-trips non-ASCII payloads (UTF-8 bridge, not latin1)', () => {
    expect(decodeCursorStrict(encodeCursor(['café ☕ 日本', 'id']))).toEqual(['café ☕ 日本', 'id'])
  })

  it('returns null on garbage / tampered input', () => {
    expect(decodeCursorStrict('not!valid!base64')).toBeNull()
    expect(decodeCursorStrict('')).toBeNull()
    expect(decodeCursorStrict('YWJj')).toBeNull() // base64 of "abc" — not JSON
  })

  it('rejects a wrong version envelope', () => {
    const v2 = btoaUrl(JSON.stringify({ v: 2, k: ['a'] }))
    expect(decodeCursorStrict(v2)).toBeNull()
  })

  it('rejects a non-array k', () => {
    const bad = btoaUrl(JSON.stringify({ v: 1, k: { a: 1 } }))
    expect(decodeCursorStrict(bad)).toBeNull()
  })

  it('rejects non-scalar elements in k', () => {
    const bad = btoaUrl(JSON.stringify({ v: 1, k: ['ok', { nested: true }] }))
    expect(decodeCursorStrict(bad)).toBeNull()
  })

  it('rejects a bare JSON number/string (not an envelope object)', () => {
    expect(decodeCursorStrict(btoaUrl('12345'))).toBeNull()
    expect(decodeCursorStrict(btoaUrl('"just a string"'))).toBeNull()
  })
})

describe('createCursorCodec', () => {
  const codec = createCursorCodec<{ id: string }>({
    toKey: (v) => [v.id],
    fromKey: (k) => (k.length === 1 && typeof k[0] === 'string' ? { id: k[0] } : null),
    legacy: (raw) => (/^[A-Za-z0-9_]+$/.test(raw) ? { id: raw } : null),
  })

  it('encodes then decodes through the v1 path', () => {
    expect(codec.decode(codec.encode({ id: 'msg_1' }))).toEqual({ id: 'msg_1' })
  })

  it('falls back to legacy only when the raw is not a v1 envelope', () => {
    // A bare id is not a v1 envelope → legacy parser handles it.
    expect(codec.decode('msg_legacy')).toEqual({ id: 'msg_legacy' })
  })

  it('does NOT fall through to legacy when a valid v1 envelope fails fromKey', () => {
    // Two-element key is a valid envelope but wrong arity for this codec:
    // reject rather than mis-route to the (permissive) legacy parser.
    const wrongEndpoint = encodeCursor(['a', 'b'])
    expect(codec.decode(wrongEndpoint)).toBeNull()
  })

  it('returns null when neither v1 nor legacy accept the raw', () => {
    const noLegacy = createCursorCodec<{ id: string }>({
      toKey: (v) => [v.id],
      fromKey: (k) => (k.length === 1 && typeof k[0] === 'string' ? { id: k[0] } : null),
    })
    expect(noLegacy.decode('anything')).toBeNull()
  })
})

describe('createKeysetCursorCodec', () => {
  const legacyPipe = (raw: string): { at: Date; id: string } | null => {
    try {
      const [iso, id] = new TextDecoder().decode(fromB64url(raw)).split('|')
      if (!iso || !id) return null
      const at = new Date(iso)
      return Number.isNaN(at.getTime()) ? null : { at, id }
    } catch {
      return null
    }
  }
  const codec = createKeysetCursorCodec(legacyPipe)

  it('round-trips a (timestamp, id) cursor', () => {
    const at = new Date('2026-06-24T18:03:00.000Z')
    const dec = codec.decode(codec.encode({ at, id: 'evt_1' }))
    expect(dec?.at.toISOString()).toBe('2026-06-24T18:03:00.000Z')
    expect(dec?.id).toBe('evt_1')
  })

  it('accepts a legacy base64url(ISO|id) cursor and disambiguates from v1', () => {
    // The legacy format is ALSO base64url, but decodes to `ISO|id` (not JSON),
    // so strict decode fails and the legacy parser takes over cleanly.
    const legacyRaw = toB64url('2026-01-02T03:04:05.000Z|evt_legacy')
    const dec = codec.decode(legacyRaw)
    expect(dec?.at.toISOString()).toBe('2026-01-02T03:04:05.000Z')
    expect(dec?.id).toBe('evt_legacy')
  })

  it('rejects an invalid timestamp and an empty id', () => {
    expect(codec.decode(encodeCursor(['not-a-date', 'id']))).toBeNull()
    expect(codec.decode(encodeCursor(['2026-06-24T18:03:00.000Z', '']))).toBeNull()
  })
})

describe('paginationQuery', () => {
  describe('reject mode (default)', () => {
    const schema = paginationQuery({ defaultLimit: 20, maxLimit: 100 })

    it('applies the default when limit is absent or empty', () => {
      expect(schema.safeParse({}).success && schema.parse({})).toEqual({
        limit: 20,
        cursor: undefined,
      })
      expect(schema.parse({ limit: '' })).toEqual({ limit: 20, cursor: undefined })
    })

    it('accepts an in-range integer limit and passes cursor through', () => {
      expect(schema.parse({ limit: '50', cursor: 'abc' })).toEqual({ limit: 50, cursor: 'abc' })
    })

    it('rejects out-of-range, non-integer, and non-numeric limits', () => {
      for (const bad of ['0', '101', '10.5', 'abc', '-3']) {
        const res = schema.safeParse({ limit: bad })
        expect(res.success, `limit=${bad} should fail`).toBe(false)
      }
    })

    it('rejects an over-length cursor', () => {
      const res = schema.safeParse({ cursor: 'x'.repeat(257) })
      expect(res.success).toBe(false)
    })
  })

  describe('clamp mode', () => {
    const schema = paginationQuery({ defaultLimit: 50, maxLimit: 100, mode: 'clamp' })

    it('clamps out-of-range limits instead of erroring', () => {
      expect(schema.parse({ limit: '500' })).toEqual({ limit: 100, cursor: undefined })
      expect(schema.parse({ limit: '0' })).toEqual({ limit: 1, cursor: undefined })
    })

    it('falls back to default on a non-numeric limit', () => {
      expect(schema.parse({ limit: 'abc' })).toEqual({ limit: 50, cursor: undefined })
    })

    it('floors a fractional limit', () => {
      expect(schema.parse({ limit: '10.9' })).toEqual({ limit: 10, cursor: undefined })
    })

    it('still rejects an over-length cursor (only limit is tolerant)', () => {
      expect(schema.safeParse({ cursor: 'x'.repeat(300) }).success).toBe(false)
    })
  })

  it('honors a custom maxCursorLength', () => {
    const schema = paginationQuery({ defaultLimit: 10, maxLimit: 50, maxCursorLength: 8 })
    expect(schema.safeParse({ cursor: 'short' }).success).toBe(true)
    expect(schema.safeParse({ cursor: 'wayTooLong' }).success).toBe(false)
  })
})

describe('buildPage', () => {
  const codec: CursorCodec<{ id: string }> = createCursorCodec({
    toKey: (v) => [v.id],
    fromKey: (k) => (typeof k[0] === 'string' ? { id: k[0] } : null),
  })
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `r${i}` }))

  it('full page: over-fetched extra row → next cursor from last kept row', () => {
    const page = buildPage(rows(6), 5, codec, (r) => ({ id: r.id }))
    expect(page.items).toHaveLength(5)
    expect(page.items[4]!.id).toBe('r4')
    expect(codec.decode(page.nextCursor!)).toEqual({ id: 'r4' })
  })

  it('short page: no extra row → null cursor', () => {
    const page = buildPage(rows(3), 5, codec, (r) => ({ id: r.id }))
    expect(page.items).toHaveLength(3)
    expect(page.nextCursor).toBeNull()
  })

  it('exact-limit page: no extra row → null cursor (no spurious next page)', () => {
    const page = buildPage(rows(5), 5, codec, (r) => ({ id: r.id }))
    expect(page.items).toHaveLength(5)
    expect(page.nextCursor).toBeNull()
  })

  it('empty page', () => {
    const page = buildPage(rows(0), 5, codec, (r) => ({ id: r.id }))
    expect(page.items).toEqual([])
    expect(page.nextCursor).toBeNull()
  })
})

describe('toPageDto', () => {
  it('maps items and renames to snake_case next_cursor', () => {
    const dto = toPageDto({ items: [{ id: 1 }, { id: 2 }], nextCursor: 'cur' }, (r) => r.id)
    expect(dto).toEqual({ items: [1, 2], next_cursor: 'cur' })
  })
})

// --- local base64url helpers for the tests (independent of the module) -------

function btoaUrl(s: string): string {
  return toB64url(s)
}
function toB64url(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function fromB64url(raw: string): Uint8Array {
  const b64 = raw.replace(/-/g, '+').replace(/_/g, '/')
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
  const bin = atob(padded)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

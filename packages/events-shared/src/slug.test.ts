import { describe, expect, it } from 'vitest'
import {
  SLUG_NAME_MAX,
  SLUG_SUFFIX_LENGTH,
  generateEventSlug,
  generateSlugSuffix,
  slugifyEventName,
} from './slug.js'

// Deterministic randomByte feed for assertions. Pops from the array;
// throws once exhausted so a slug change that draws more entropy than
// the test expects fails loudly.
function feed(bytes: number[]): () => number {
  const queue = [...bytes]
  return () => {
    const next = queue.shift()
    if (next === undefined) throw new Error('feed() exhausted')
    return next
  }
}

describe('slugifyEventName', () => {
  it('lowercases + kebab-cases a normal name', () => {
    expect(slugifyEventName('Summer Festival 2026')).toBe('summer-festival-2026')
  })

  it('collapses runs of non-alphanumeric into a single hyphen', () => {
    expect(slugifyEventName("Bob's   Birthday!!!")).toBe('bob-s-birthday')
  })

  it('trims leading/trailing hyphens', () => {
    expect(slugifyEventName('   ---hello---   ')).toBe('hello')
  })

  it('caps at 24 chars and trims a hyphen left at the boundary', () => {
    const slugged = slugifyEventName('aaaaaaaaa bbbbbbbbb cccccccc dddd')
    expect(slugged.length).toBeLessThanOrEqual(SLUG_NAME_MAX)
    expect(slugged.endsWith('-')).toBe(false)
  })

  it("specifically: a 25-char input with a hyphen at position 24 trims it", () => {
    // Names like "Foo Bar Baz Qux Quux Quu xxx" slugify to
    // 'foo-bar-baz-qux-quux-quu' (24 chars) before the slice, then
    // when the input is *just* longer than the cap we get a trailing
    // hyphen at position 24 that must be trimmed away. Pin it.
    // Input: "aaaaa bbbbb ccccc ddddd eeeee" — slugified is
    // "aaaaa-bbbbb-ccccc-ddddd-eeeee" (29 chars); .slice(0,24) =
    // "aaaaa-bbbbb-ccccc-ddddd-" (trailing hyphen); the final
    // regex-trim drops that hyphen.
    expect(slugifyEventName('aaaaa bbbbb ccccc ddddd eeeee')).toBe('aaaaa-bbbbb-ccccc-ddddd')
  })

  it('returns empty for an all-punctuation name', () => {
    expect(slugifyEventName('!!!')).toBe('')
    expect(slugifyEventName('   ')).toBe('')
  })
})

describe('generateSlugSuffix', () => {
  it('always returns SLUG_SUFFIX_LENGTH characters', () => {
    const suffix = generateSlugSuffix(feed([0, 0, 0, 0]))
    expect(suffix).toHaveLength(SLUG_SUFFIX_LENGTH)
  })

  it('only uses the no-ambiguous alphabet (no 0, 1, i, l, o)', () => {
    // Sweep the full byte range through to confirm every modulo result
    // lands on the alphabet, never on a banned character.
    const banned = new Set(['0', '1', 'i', 'l', 'o'])
    for (let b = 0; b < 256; b += 1) {
      const suffix = generateSlugSuffix(feed([b, b, b, b]))
      for (const ch of suffix) {
        expect(banned.has(ch)).toBe(false)
        expect(/[2-9a-z]/.test(ch)).toBe(true)
      }
    }
  })

  it('is deterministic given the same byte feed', () => {
    const a = generateSlugSuffix(feed([5, 10, 15, 20]))
    const b = generateSlugSuffix(feed([5, 10, 15, 20]))
    expect(a).toBe(b)
  })
})

describe('generateEventSlug', () => {
  it('combines slugified name + suffix with a single hyphen', () => {
    const slug = generateEventSlug('Summer Fest', feed([0, 0, 0, 0]))
    // Suffix from [0,0,0,0] → '2222' (first char of SUFFIX_ALPHABET).
    expect(slug).toBe('summer-fest-2222')
  })

  it('falls back to `event-<suffix>` for an all-punctuation name', () => {
    const slug = generateEventSlug('!!!', feed([0, 0, 0, 0]))
    expect(slug).toBe('event-2222')
  })

  it('respects the pre-suffix cap', () => {
    const slug = generateEventSlug(
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      feed([0, 0, 0, 0]),
    )
    const [namePart] = slug.split(/-(?=[2-9a-z]{4}$)/)
    expect(namePart!.length).toBeLessThanOrEqual(SLUG_NAME_MAX)
  })

  it('matches the kebab-case slug regex', () => {
    const slug = generateEventSlug("Bob's Burgers", feed([1, 2, 3, 4]))
    expect(slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  })
})

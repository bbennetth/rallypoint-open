import { describe, it, expect } from 'vitest'
import { themeObjectKeys } from './pruner.js'

// Theme images live inline on the public_page_config JSON blob, not in
// a table, so the purge sweep has no row to walk — these keys are the
// only handle on them. Parsing must be defensive: a config that fails
// schema validation still has bytes in R2 that must be reaped.
describe('themeObjectKeys', () => {
  it('returns both theme keys when present', () => {
    expect(
      themeObjectKeys({
        enabled: true,
        theme: { icon_image_key: 'a/icon.png', background_image_key: 'b/bg.jpg' },
      }),
    ).toEqual(['a/icon.png', 'b/bg.jpg'])
  })

  it('returns just the icon key when that is all there is', () => {
    expect(themeObjectKeys({ theme: { icon_image_key: 'a/icon.png' } })).toEqual([
      'a/icon.png',
    ])
  })

  it.each([null, undefined, 'string', 42, [], {}, { theme: null }, { theme: 'x' }])(
    'returns [] for %s',
    (input) => {
      expect(themeObjectKeys(input)).toEqual([])
    },
  )

  // A malformed config still had real bytes uploaded — reap what parses.
  it('salvages a valid key from an otherwise malformed config', () => {
    expect(
      themeObjectKeys({ enabled: 'not-a-boolean', theme: { icon_image_key: 'a/icon.png' } }),
    ).toEqual(['a/icon.png'])
  })

  it('skips non-string and empty keys', () => {
    expect(
      themeObjectKeys({ theme: { icon_image_key: '', background_image_key: 123 } }),
    ).toEqual([])
  })
})

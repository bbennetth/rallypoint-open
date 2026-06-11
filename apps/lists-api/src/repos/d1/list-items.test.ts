import { describe, it, expect } from 'vitest'
import { BUILTIN_FIELDS } from '@rallypoint/lists-shared'
import { builtinColumn } from './list-items.js'

// #242: BUILTIN_COLUMN (the name→Drizzle column map in list-items.ts) must
// cover every builtin field the validation gate BUILTIN_FIELDS lets resolve
// to `source: 'builtin'`. If the two drift, a validated builtin spec would
// reach builtinColumn with no column and embed `sql${undefined}`. The map
// has an import-time assertion; these tests pin the invariant + the
// defensive throw so a future drift fails as a clear error, not bad SQL.
describe('builtinColumn drift guard (#242)', () => {
  it('maps every BUILTIN_FIELDS name to a column without throwing', () => {
    for (const field of Object.keys(BUILTIN_FIELDS)) {
      expect(() => builtinColumn(field)).not.toThrow()
    }
  })

  it('throws on a field name with no column mapping', () => {
    expect(() => builtinColumn('not_a_real_column')).toThrow()
  })
})

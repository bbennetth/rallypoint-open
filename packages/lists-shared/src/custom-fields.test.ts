import { describe, it, expect } from 'vitest'
import {
  buildCreateOptions,
  mergeUpdateOptions,
  validateCustomFields,
  isUnsatisfiableRequiredSelect,
  type FieldDefForValidation,
  type FieldDefOptions,
} from './custom-fields.js'
import { slugifyFieldKey, uniqueFieldKey } from './validators.js'

// Deterministic id minter for assertions: opt_1, opt_2, …
function counterMinter() {
  let n = 0
  return () => `opt_${++n}`
}

describe('slugifyFieldKey', () => {
  it('lowercases and replaces non-alphanumeric runs with a single underscore', () => {
    expect(slugifyFieldKey('Budget (USD)')).toBe('budget_usd')
    expect(slugifyFieldKey('Store / Location')).toBe('store_location')
  })

  it('trims leading and trailing underscores', () => {
    expect(slugifyFieldKey('  !!Owner!!  ')).toBe('owner')
  })

  it('caps the slug at 40 characters without a trailing underscore', () => {
    const key = slugifyFieldKey('a'.repeat(50))
    expect(key).toHaveLength(40)
    expect(key.endsWith('_')).toBe(false)
  })

  it('falls back to "field" when the label slugs to empty', () => {
    expect(slugifyFieldKey('!!!')).toBe('field')
    expect(slugifyFieldKey('   ')).toBe('field')
  })
})

describe('uniqueFieldKey', () => {
  it('returns the base slug when not taken', () => {
    expect(uniqueFieldKey('Owner', [])).toBe('owner')
  })

  it('suffixes _2, _3 on collision', () => {
    expect(uniqueFieldKey('Owner', ['owner'])).toBe('owner_2')
    expect(uniqueFieldKey('Owner', ['owner', 'owner_2'])).toBe('owner_3')
  })

  it('keeps the suffixed key within 40 characters', () => {
    const key = uniqueFieldKey('a'.repeat(50), ['a'.repeat(40)])
    expect(key.length).toBeLessThanOrEqual(40)
    expect(key.endsWith('_2')).toBe(true)
  })
})

describe('buildCreateOptions', () => {
  it('mints a fresh id per choice for select fields', () => {
    const opts = buildCreateOptions(
      'single_select',
      { choices: [{ label: 'A' }, { label: 'B', color: 'red' }] },
      counterMinter(),
    )
    expect(opts.choices).toEqual([
      { id: 'opt_1', label: 'A' },
      { id: 'opt_2', label: 'B', color: 'red' },
    ])
  })

  it('ignores any client-supplied choice id and mints server-side', () => {
    const opts = buildCreateOptions(
      'multi_select',
      { choices: [{ id: 'opt_client', label: 'A' }] },
      counterMinter(),
    )
    expect(opts.choices?.[0]!.id).toBe('opt_1')
  })

  it('records the multiline flag only for text fields', () => {
    expect(buildCreateOptions('text', { multiline: true }, counterMinter())).toEqual({
      multiline: true,
    })
    // non-text never carries multiline (the route/schema rejects it, but
    // the builder is defensive too)
    expect(buildCreateOptions('number', { multiline: true }, counterMinter())).toEqual({})
  })

  it('omits choices on non-select fields', () => {
    expect(buildCreateOptions('number', { choices: [{ label: 'X' }] }, counterMinter())).toEqual({})
  })
})

describe('mergeUpdateOptions', () => {
  const existing = {
    choices: [
      { id: 'opt_a', label: 'Apple' },
      { id: 'opt_b', label: 'Banana' },
    ],
  }

  it('edits a choice in place by id (stable id, new label)', () => {
    const merged = mergeUpdateOptions(
      'single_select',
      existing,
      { choices: [{ id: 'opt_a', label: 'Apricot' }] },
      counterMinter(),
    )
    // opt_a relabeled; opt_b preserved (anti-orphan) and appended.
    expect(merged.choices).toEqual([
      { id: 'opt_a', label: 'Apricot' },
      { id: 'opt_b', label: 'Banana' },
    ])
  })

  it('mints a fresh id for a choice with no id', () => {
    const merged = mergeUpdateOptions(
      'single_select',
      existing,
      { choices: [{ label: 'Cherry' }] },
      counterMinter(),
    )
    expect(merged.choices).toEqual([
      { id: 'opt_1', label: 'Cherry' },
      { id: 'opt_a', label: 'Apple' },
      { id: 'opt_b', label: 'Banana' },
    ])
  })

  it('archives a choice via archived:true without dropping it', () => {
    const merged = mergeUpdateOptions(
      'multi_select',
      existing,
      { choices: [{ id: 'opt_a', label: 'Apple', archived: true }] },
      counterMinter(),
    )
    expect(merged.choices).toEqual([
      { id: 'opt_a', label: 'Apple', archived: true },
      { id: 'opt_b', label: 'Banana' },
    ])
  })

  it('mints a fresh id for an unknown id (never trusts client ids)', () => {
    const merged = mergeUpdateOptions(
      'single_select',
      existing,
      { choices: [{ id: 'opt_ghost', label: 'Ghost' }] },
      counterMinter(),
    )
    expect(merged.choices).toEqual([
      { id: 'opt_1', label: 'Ghost' },
      { id: 'opt_a', label: 'Apple' },
      { id: 'opt_b', label: 'Banana' },
    ])
  })

  it('updates the multiline flag for text fields', () => {
    expect(
      mergeUpdateOptions('text', { multiline: false }, { multiline: true }, counterMinter()),
    ).toEqual({ multiline: true })
  })

  it('leaves options untouched when the patch carries neither choices nor multiline', () => {
    expect(mergeUpdateOptions('single_select', existing, {}, counterMinter())).toEqual(existing)
  })
})

describe('validateCustomFields', () => {
  function def(partial: Partial<FieldDefForValidation> & Pick<FieldDefForValidation, 'id' | 'fieldType'>): FieldDefForValidation {
    return { required: false, options: {}, ...partial }
  }

  const textDef = def({ id: 'lfd_text', fieldType: 'text' })
  const numDef = def({ id: 'lfd_num', fieldType: 'number' })
  const boolDef = def({ id: 'lfd_bool', fieldType: 'checkbox' })
  const dateDef = def({ id: 'lfd_date', fieldType: 'date' })
  const personDef = def({ id: 'lfd_person', fieldType: 'person' })
  const urlDef = def({ id: 'lfd_url', fieldType: 'url' })
  const singleDef = def({
    id: 'lfd_single',
    fieldType: 'single_select',
    options: { choices: [{ id: 'opt_a', label: 'A' }, { id: 'opt_z', label: 'Z', archived: true }] },
  })
  const multiDef = def({
    id: 'lfd_multi',
    fieldType: 'multi_select',
    options: { choices: [{ id: 'opt_x', label: 'X' }, { id: 'opt_y', label: 'Y' }] },
  })

  it('returns empty values for empty input and no defs (v1 behaviour)', () => {
    expect(validateCustomFields([], {})).toEqual({ ok: true, values: {} })
  })

  it('accepts well-typed values of every type', () => {
    const r = validateCustomFields(
      [textDef, numDef, boolDef, dateDef, personDef, urlDef, singleDef, multiDef],
      {
        lfd_text: 'hello',
        lfd_num: 42,
        lfd_bool: true,
        lfd_date: '2026-06-02',
        lfd_person: 'user_123',
        lfd_url: 'https://example.com',
        lfd_single: 'opt_a',
        lfd_multi: ['opt_x', 'opt_y'],
      },
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.values.lfd_text).toBe('hello')
      expect(r.values.lfd_num).toBe(42)
      expect(r.values.lfd_bool).toBe(true)
      // date normalises to an ISO string
      expect(r.values.lfd_date).toBe(new Date('2026-06-02').toISOString())
      expect(r.values.lfd_single).toBe('opt_a')
      expect(r.values.lfd_multi).toEqual(['opt_x', 'opt_y'])
    }
  })

  it('rejects a value of the wrong type', () => {
    const r = validateCustomFields([numDef], { lfd_num: 'not a number' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.issues[0]!.path).toEqual(['customFields', 'lfd_num'])
  })

  it('rejects a missing required field', () => {
    const r = validateCustomFields([def({ id: 'lfd_text', fieldType: 'text', required: true })], {})
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.issues[0]!.message).toMatch(/required/i)
  })

  it('treats an empty string / empty array as missing for a required field', () => {
    const reqText = def({ id: 'lfd_text', fieldType: 'text', required: true })
    const reqMulti = def({ ...multiDef, required: true })
    expect(validateCustomFields([reqText], { lfd_text: '' }).ok).toBe(false)
    expect(validateCustomFields([reqMulti], { lfd_multi: [] }).ok).toBe(false)
  })

  it('omits empty optional values from the result rather than storing them', () => {
    const r = validateCustomFields([textDef, multiDef], { lfd_text: '', lfd_multi: [] })
    expect(r).toEqual({ ok: true, values: {} })
  })

  it('rejects an unknown key', () => {
    const r = validateCustomFields([textDef], { lfd_ghost: 'x' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.issues[0]!.code).toBe('unrecognized_keys')
  })

  it('rejects a select value that is not a defined choice', () => {
    const r = validateCustomFields([singleDef], { lfd_single: 'opt_missing' })
    expect(r.ok).toBe(false)
  })

  it('rejects an archived select option (cannot be picked in a new edit)', () => {
    const r = validateCustomFields([singleDef], { lfd_single: 'opt_z' })
    expect(r.ok).toBe(false)
  })

  it('rejects a multi-select value containing an unknown choice', () => {
    const r = validateCustomFields([multiDef], { lfd_multi: ['opt_x', 'opt_nope'] })
    expect(r.ok).toBe(false)
  })

  it('rejects a multi-select value that is not an array', () => {
    expect(validateCustomFields([multiDef], { lfd_multi: 'opt_x' }).ok).toBe(false)
  })

  it('rejects NaN and Infinity for a number field', () => {
    expect(validateCustomFields([numDef], { lfd_num: Number.NaN }).ok).toBe(false)
    expect(validateCustomFields([numDef], { lfd_num: Number.POSITIVE_INFINITY }).ok).toBe(false)
  })

  it('rejects a url without an http(s) scheme', () => {
    expect(validateCustomFields([urlDef], { lfd_url: 'ftp://example.com' }).ok).toBe(false)
    // a javascript: scheme must be rejected (no XSS-bearing values stored)
    expect(validateCustomFields([urlDef], { lfd_url: 'javascript:alert(1)' }).ok).toBe(false)
    expect(validateCustomFields([urlDef], { lfd_url: 'https://ok.com' }).ok).toBe(true)
  })

  it('rejects an invalid date string', () => {
    expect(validateCustomFields([dateDef], { lfd_date: 'not-a-date' }).ok).toBe(false)
  })
})

describe('isUnsatisfiableRequiredSelect (#258)', () => {
  const withChoices = (choices: FieldDefOptions['choices']): FieldDefOptions => ({ choices })

  it('is true for a required select with zero active choices (none / all archived)', () => {
    expect(isUnsatisfiableRequiredSelect('single_select', true, withChoices([]))).toBe(true)
    expect(isUnsatisfiableRequiredSelect('single_select', true, {})).toBe(true)
    expect(
      isUnsatisfiableRequiredSelect(
        'multi_select',
        true,
        withChoices([{ id: 'opt_1', label: 'A', archived: true }]),
      ),
    ).toBe(true)
  })

  it('is false for a required select that keeps at least one active choice', () => {
    expect(
      isUnsatisfiableRequiredSelect(
        'single_select',
        true,
        withChoices([
          { id: 'opt_1', label: 'A', archived: true },
          { id: 'opt_2', label: 'B' },
        ]),
      ),
    ).toBe(false)
  })

  it('is false for an optional select regardless of choices', () => {
    expect(isUnsatisfiableRequiredSelect('single_select', false, withChoices([]))).toBe(false)
  })

  it('is false for non-select field types even when required with no choices', () => {
    expect(isUnsatisfiableRequiredSelect('text', true, {})).toBe(false)
    expect(isUnsatisfiableRequiredSelect('number', true, {})).toBe(false)
    expect(isUnsatisfiableRequiredSelect('person', true, {})).toBe(false)
  })
})

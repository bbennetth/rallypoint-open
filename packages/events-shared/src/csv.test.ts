import { describe, it, expect } from 'vitest'
import { escapeCsvField, escapeCsvCell } from './csv.js'

describe('escapeCsvCell (RFC 4180 only)', () => {
  it('leaves a plain value untouched', () => {
    expect(escapeCsvCell('Ada Lovelace')).toBe('Ada Lovelace')
  })

  it('quotes values containing comma, quote, CR, or LF', () => {
    expect(escapeCsvCell('Last, First')).toBe('"Last, First"')
    expect(escapeCsvCell('say "hi"')).toBe('"say ""hi"""')
    expect(escapeCsvCell('line1\nline2')).toBe('"line1\nline2"')
  })

  it('does NOT add a formula-guard prefix (round-trip safe)', () => {
    // Round-trippable serialization must not mutate the value; a leading
    // trigger char is left as-is so parseCsv reads back the original.
    expect(escapeCsvCell('=SUM(A1)')).toBe('=SUM(A1)')
    expect(escapeCsvCell('-Main Stage')).toBe('-Main Stage')
  })
})

describe('escapeCsvField (RFC 4180 + formula guard)', () => {
  it('leaves a plain value untouched', () => {
    expect(escapeCsvField('Ada Lovelace')).toBe('Ada Lovelace')
    expect(escapeCsvField('ada@example.com')).toBe('ada@example.com')
  })

  it('quotes values containing comma, quote, CR, or LF (RFC 4180)', () => {
    expect(escapeCsvField('Last, First')).toBe('"Last, First"')
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""')
    expect(escapeCsvField('line1\r\nline2')).toBe('"line1\r\nline2"')
  })

  it('neutralizes leading formula triggers with a single-quote prefix', () => {
    expect(escapeCsvField('+1234')).toBe("'+1234")
    expect(escapeCsvField('-1234')).toBe("'-1234")
    expect(escapeCsvField('@SUM(A1:A9)')).toBe("'@SUM(A1:A9)")
    expect(escapeCsvField('\tstart-with-tab')).toBe("'\tstart-with-tab")
  })

  it('prefixes AND RFC-quotes a formula value that also has quotes/commas', () => {
    expect(escapeCsvField('=HYPERLINK("http://evil","x")')).toBe(
      '"\'=HYPERLINK(""http://evil"",""x"")"',
    )
  })

  it('does not prefix a value that merely contains a trigger char mid-string', () => {
    expect(escapeCsvField('a=b')).toBe('a=b')
    expect(escapeCsvField('3-5 people')).toBe('3-5 people')
  })

  it('leaves an empty string empty', () => {
    expect(escapeCsvField('')).toBe('')
    expect(escapeCsvCell('')).toBe('')
  })
})

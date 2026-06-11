import { describe, expect, it } from 'vitest'
import { headerIndex, parseCsv, toCsv } from './csv.js'

describe('parseCsv', () => {
  it('parses a simple grid', () => {
    expect(parseCsv('a,b,c\n1,2,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ])
  })

  it('handles quoted fields with embedded commas', () => {
    expect(parseCsv('name,note\n"Doe, John","hi"')).toEqual([
      ['name', 'note'],
      ['Doe, John', 'hi'],
    ])
  })

  it('handles doubled quotes inside a quoted field', () => {
    expect(parseCsv('x\n"she said ""hi"""')).toEqual([['x'], ['she said "hi"']])
  })

  it('handles newlines inside quoted fields', () => {
    expect(parseCsv('x,y\n"line1\nline2",z')).toEqual([
      ['x', 'y'],
      ['line1\nline2', 'z'],
    ])
  })

  it('treats CRLF as a row separator', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('treats a lone CR (old-Mac line ending) as a row separator', () => {
    expect(parseCsv('a,b\r1,2\r3,4')).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
    ])
  })

  it('normalises CRLF inside a quoted field to a bare LF', () => {
    expect(parseCsv('x,y\n"line1\r\nline2",z')).toEqual([
      ['x', 'y'],
      ['line1\nline2', 'z'],
    ])
  })

  it('strips a leading BOM', () => {
    expect(parseCsv('﻿a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('drops rows that are entirely empty, including delimiter-only rows', () => {
    // A spreadsheet export can leave trailing all-empty rows (`,` or `,,,`);
    // these carry no data and would otherwise become spurious planner errors.
    expect(parseCsv('a,b\n,\n\n1,2\n,,,')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('returns empty for empty input', () => {
    expect(parseCsv('')).toEqual([])
  })

  it('round-trips through toCsv', () => {
    const rows = [
      ['artist', 'note'],
      ['A,B', 'has "quote"'],
      ['plain', 'multi\nline'],
    ]
    expect(parseCsv(toCsv(rows))).toEqual(rows)
  })
})

describe('toCsv', () => {
  it('quotes cells containing commas, quotes, or newlines', () => {
    expect(toCsv([['a,b', 'c"d', 'e\nf', 'plain']])).toBe('"a,b","c""d","e\nf",plain')
  })
})

describe('headerIndex', () => {
  it('normalises header names and maps to indices', () => {
    const idx = headerIndex(['Artist', 'Day ', 'Display Name', 'start-time'])
    expect(idx.get('artist')).toBe(0)
    expect(idx.get('day')).toBe(1)
    expect(idx.get('display_name')).toBe(2)
    expect(idx.get('start_time')).toBe(3)
  })

  it('keeps the first occurrence of a duplicate column', () => {
    const idx = headerIndex(['day', 'day'])
    expect(idx.get('day')).toBe(0)
  })
})

import { describe, expect, it } from 'vitest'
import {
  parseSessionsClipboard,
  sessionRowsToTsv,
  type SessionClipboardRow,
} from './sessions-grid.js'

const row = (p: Partial<SessionClipboardRow> = {}): SessionClipboardRow => ({
  title: 'Sunrise Yoga',
  day: 'Day 1',
  start: '07:00',
  end: '08:00',
  stage: 'Wellness',
  location: 'Wellness Tent',
  category: 'wellness',
  host: 'Jane Doe',
  description: 'Gentle flow',
  ...p,
})

describe('sessionRowsToTsv', () => {
  it('emits a header then tab-separated rows with CRLF line breaks', () => {
    const tsv = sessionRowsToTsv([row()])
    const lines = tsv.split('\r\n')
    expect(lines[0]).toBe('title\tday\tstart\tend\tstage\tlocation\tcategory\thost\tdescription')
    expect(lines[1]).toBe(
      'Sunrise Yoga\tDay 1\t07:00\t08:00\tWellness\tWellness Tent\twellness\tJane Doe\tGentle flow',
    )
  })

  it('replaces embedded tabs/newlines so cells stay aligned', () => {
    const tsv = sessionRowsToTsv([row({ title: 'A\tB', description: 'x\ny' })])
    expect(tsv.split('\r\n')[1]).toBe(
      'A B\tDay 1\t07:00\t08:00\tWellness\tWellness Tent\twellness\tJane Doe\tx y',
    )
  })
})

describe('parseSessionsClipboard', () => {
  it('parses tab-separated rows and skips a header row', () => {
    const text =
      'title\tday\tstart\tend\tstage\tlocation\tcategory\thost\tdescription\n' +
      'Cold Plunge\tDay 2\t09:00\t09:30\tRiver\tRiverside\twellness\tBo\tBrr'
    expect(parseSessionsClipboard(text)).toEqual([
      {
        title: 'Cold Plunge',
        day: 'Day 2',
        start: '09:00',
        end: '09:30',
        stage: 'River',
        location: 'Riverside',
        category: 'wellness',
        host: 'Bo',
        description: 'Brr',
      },
    ])
  })

  it('falls back to comma-splitting for lines without tabs', () => {
    const out = parseSessionsClipboard('Panel Talk,Day 1,10:00,11:00,Main')
    expect(out).toEqual([
      row({
        title: 'Panel Talk',
        day: 'Day 1',
        start: '10:00',
        end: '11:00',
        stage: 'Main',
        location: '',
        category: '',
        host: '',
        description: '',
      }),
    ])
  })

  it('drops blank lines and pads missing trailing cells with empty strings', () => {
    const out = parseSessionsClipboard('\n\nSolo Set\tDay 1\n\n')
    expect(out).toEqual([
      row({
        title: 'Solo Set',
        day: 'Day 1',
        start: '',
        end: '',
        stage: '',
        location: '',
        category: '',
        host: '',
        description: '',
      }),
    ])
  })

  it('returns an empty array for empty input', () => {
    expect(parseSessionsClipboard('')).toEqual([])
  })
})

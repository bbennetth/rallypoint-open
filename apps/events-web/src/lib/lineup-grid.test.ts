import { describe, expect, it } from 'vitest'
import { lineupRowsToTsv, parseLineupClipboard, type LineupClipboardRow } from './lineup-grid.js'

const row = (p: Partial<LineupClipboardRow> = {}): LineupClipboardRow => ({
  artist: 'Aphex Twin',
  day: 'Day 1',
  stage: 'Main',
  tier: 'headliner',
  start: '20:00',
  end: '21:30',
  displayName: '',
  ...p,
})

describe('lineupRowsToTsv', () => {
  it('emits a header then tab-separated rows with CRLF line breaks', () => {
    const tsv = lineupRowsToTsv([row()])
    const lines = tsv.split('\r\n')
    expect(lines[0]).toBe('artist\tday\tstage\ttier\tstart\tend\tdisplay_name')
    expect(lines[1]).toBe('Aphex Twin\tDay 1\tMain\theadliner\t20:00\t21:30\t')
  })

  it('replaces embedded tabs/newlines so cells stay aligned', () => {
    const tsv = lineupRowsToTsv([row({ artist: 'A\tB', displayName: 'x\ny' })])
    expect(tsv.split('\r\n')[1]).toBe('A B\tDay 1\tMain\theadliner\t20:00\t21:30\tx y')
  })
})

describe('parseLineupClipboard', () => {
  it('parses tab-separated rows and skips a header row', () => {
    const text = 'artist\tday\tstage\ttier\tstart\tend\tdisplay_name\nBoards of Canada\tDay 2\tTent B\tsupport\t18:00\t19:00\tBoC'
    expect(parseLineupClipboard(text)).toEqual([
      {
        artist: 'Boards of Canada',
        day: 'Day 2',
        stage: 'Tent B',
        tier: 'support',
        start: '18:00',
        end: '19:00',
        displayName: 'BoC',
      },
    ])
  })

  it('falls back to comma splitting when a line has no tabs', () => {
    expect(parseLineupClipboard('Caribou,Day 1')).toEqual([
      { artist: 'Caribou', day: 'Day 1', stage: '', tier: '', start: '', end: '', displayName: '' },
    ])
  })

  it('drops blank lines and trims cells', () => {
    const rows = parseLineupClipboard('  A \t Day 1 \n\n B\tDay 2\n')
    expect(rows).toEqual([
      { artist: 'A', day: 'Day 1', stage: '', tier: '', start: '', end: '', displayName: '' },
      { artist: 'B', day: 'Day 2', stage: '', tier: '', start: '', end: '', displayName: '' },
    ])
  })

  it('does not treat a data row starting with "artist..." text as a header', () => {
    // Only an exact first cell of "artist" is a header; a real artist named
    // "Artistic" must survive.
    const rows = parseLineupClipboard('Artistic\tDay 1')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.artist).toBe('Artistic')
  })

  it('round-trips through TSV', () => {
    const original = [row(), row({ artist: 'Caribou', day: 'Day 2', stage: '', tier: '' })]
    expect(parseLineupClipboard(lineupRowsToTsv(original))).toEqual(original)
  })
})

// Clipboard helpers for the Lineup grid editor (#191): copy the grid out as
// TSV (so it pastes cleanly into Excel/Sheets) and parse pasted tabular data
// back into rows. Pure + positional by column order — resolution of day
// labels / stage names / tier validity is left to the caller, which holds
// the event's days and stages.

// Column order shared by copy and paste, matching the CSV template minus
// genre (which has no grid column).
export const LINEUP_GRID_HEADER = [
  'artist',
  'day',
  'stage',
  'tier',
  'start',
  'end',
  'display_name',
] as const

export interface LineupClipboardRow {
  artist: string
  day: string
  stage: string
  tier: string
  start: string
  end: string
  displayName: string
}

function escapeTsv(s: string): string {
  // Tabs and newlines can't survive a bare TSV cell; spaces keep it readable.
  return s.replace(/[\t\r\n]+/g, ' ')
}

// Serialize rows to TSV with a leading header row.
export function lineupRowsToTsv(rows: LineupClipboardRow[]): string {
  const lines = [LINEUP_GRID_HEADER.join('\t')]
  for (const r of rows) {
    lines.push(
      [r.artist, r.day, r.stage, r.tier, r.start, r.end, r.displayName].map(escapeTsv).join('\t'),
    )
  }
  return lines.join('\r\n')
}

// Parse pasted clipboard text into rows. Splits on line breaks, then on tabs
// (spreadsheet default) or, if a line has no tab, on commas. A leading header
// row (first cell == "artist", case-insensitive) is skipped. Blank lines are
// dropped.
export function parseLineupClipboard(text: string): LineupClipboardRow[] {
  const lines = text
    .split(/\r\n|\r|\n/)
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim() !== '')

  const out: LineupClipboardRow[] = []
  lines.forEach((line, i) => {
    const cells = (line.includes('\t') ? line.split('\t') : line.split(',')).map((c) => c.trim())
    if (i === 0 && cells[0]?.toLowerCase() === 'artist') return
    out.push({
      artist: cells[0] ?? '',
      day: cells[1] ?? '',
      stage: cells[2] ?? '',
      tier: cells[3] ?? '',
      start: cells[4] ?? '',
      end: cells[5] ?? '',
      displayName: cells[6] ?? '',
    })
  })
  return out
}

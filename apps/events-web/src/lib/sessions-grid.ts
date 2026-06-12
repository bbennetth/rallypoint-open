// Clipboard helpers for the Sessions grid editor (#215): copy the grid out
// as TSV (so it pastes cleanly into Excel/Sheets) and parse pasted tabular
// data back into rows. Pure + positional by column order — resolution of
// day labels / stage names is left to the caller, which holds the event's
// days and stages. Mirrors lineup-grid.ts.

// Column order shared by copy and paste, matching the sessions CSV
// template minus id/visibility (which have no grid column).
export const SESSIONS_GRID_HEADER = [
  'title',
  'day',
  'start',
  'end',
  'stage',
  'location',
  'category',
  'host',
  'description',
] as const

export interface SessionClipboardRow {
  title: string
  day: string
  start: string
  end: string
  stage: string
  location: string
  category: string
  host: string
  description: string
}

function escapeTsv(s: string): string {
  // Tabs and newlines can't survive a bare TSV cell; spaces keep it readable.
  return s.replace(/[\t\r\n]+/g, ' ')
}

// Serialize rows to TSV with a leading header row.
export function sessionRowsToTsv(rows: SessionClipboardRow[]): string {
  const lines = [SESSIONS_GRID_HEADER.join('\t')]
  for (const r of rows) {
    lines.push(
      [r.title, r.day, r.start, r.end, r.stage, r.location, r.category, r.host, r.description]
        .map(escapeTsv)
        .join('\t'),
    )
  }
  return lines.join('\r\n')
}

// Parse pasted clipboard text into rows. Splits on line breaks, then on tabs
// (spreadsheet default) or, if a line has no tab, on commas. CSV quoting is
// NOT handled — a comma inside a cell splits it; prefer TSV (spreadsheet)
// paste. A leading header row (first cell == "title", case-insensitive) is
// skipped. Blank lines are dropped.
export function parseSessionsClipboard(text: string): SessionClipboardRow[] {
  const lines = text
    .split(/\r\n|\r|\n/)
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim() !== '')

  const out: SessionClipboardRow[] = []
  lines.forEach((line, i) => {
    const cells = (line.includes('\t') ? line.split('\t') : line.split(',')).map((c) => c.trim())
    if (i === 0 && cells[0]?.toLowerCase() === 'title') return
    out.push({
      title: cells[0] ?? '',
      day: cells[1] ?? '',
      start: cells[2] ?? '',
      end: cells[3] ?? '',
      stage: cells[4] ?? '',
      location: cells[5] ?? '',
      category: cells[6] ?? '',
      host: cells[7] ?? '',
      description: cells[8] ?? '',
    })
  })
  return out
}

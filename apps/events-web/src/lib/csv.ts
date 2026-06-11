// Minimal RFC-4180-ish CSV parse + serialize, client-side (issue #191
// Phase 3). No dependency: the import flow only needs to read a small
// spreadsheet the user exported. Handles quoted fields with embedded
// commas, quotes (doubled `""`), and CR/LF inside quotes.

// Parse CSV text into rows of string cells. A leading UTF-8 BOM is
// stripped. Fully-empty lines (e.g. a trailing newline) are dropped so a
// file saved by Excel/Sheets doesn't yield a phantom blank row.
export function parseCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)

  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false
  let i = 0

  const pushCell = () => {
    row.push(cell)
    cell = ''
  }
  const pushRow = () => {
    pushCell()
    rows.push(row)
    row = []
  }

  while (i < text.length) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      // Normalise CRLF / lone CR inside a quoted field to a bare LF so the
      // cell value doesn't carry a stray '\r'.
      if (ch === '\r') {
        cell += '\n'
        if (text[i + 1] === '\n') i++
        i++
        continue
      }
      cell += ch
      i++
      continue
    }
    if (ch === '"') {
      inQuotes = true
      i++
      continue
    }
    if (ch === ',') {
      pushCell()
      i++
      continue
    }
    if (ch === '\r') {
      // CRLF: consume the CR and let the LF below terminate the row.
      // Lone CR (old-Mac line ending): terminate the row here.
      if (text[i + 1] === '\n') {
        i++
        continue
      }
      pushRow()
      i++
      continue
    }
    if (ch === '\n') {
      pushRow()
      i++
      continue
    }
    cell += ch
    i++
  }
  // Flush a trailing cell/row that wasn't terminated by a newline.
  if (cell.length > 0 || row.length > 0) pushRow()

  return rows.filter((r) => r.some((c) => c.trim() !== ''))
}

function escapeCell(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

// Serialize rows of cells back to CSV (CRLF line endings, the safe default
// for spreadsheet apps).
export function toCsv(rows: string[][]): string {
  return rows.map((r) => r.map(escapeCell).join(',')).join('\r\n')
}

// Map a header row to normalised column keys: lowercased, trimmed, spaces
// and hyphens collapsed to underscores. Returns a name → index lookup
// (first occurrence wins).
export function headerIndex(header: string[]): Map<string, number> {
  const idx = new Map<string, number>()
  header.forEach((raw, i) => {
    const key = raw.trim().toLowerCase().replace(/[\s-]+/g, '_')
    if (key && !idx.has(key)) idx.set(key, i)
  })
  return idx
}

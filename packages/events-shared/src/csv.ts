// Shared CSV field serialization. One source of truth for the escaping
// rules used by the server export (apps/events-api attendees.csv) and the
// client template serializer (apps/events-web lib/csv.ts).
//
// Two variants, because the two call sites have different requirements:
//
//   escapeCsvField — RFC-4180 quoting PLUS a formula-injection guard. For
//   files that are downloaded and opened directly in a spreadsheet and are
//   NEVER re-parsed by our own code (the attendees export). A cell that
//   begins with =, +, -, @, TAB, or CR is executed as a formula by Excel /
//   Google Sheets / LibreOffice; untrusted values (attendee display names
//   & emails) flow into that export verbatim, so a name like
//   `=HYPERLINK(...)` would run on the organizer's machine. Prefixing such
//   a value with a single quote makes the spreadsheet treat it as text.
//
//   escapeCsvCell — RFC-4180 quoting ONLY. For round-trippable
//   serialization: the events-web lineup/sessions TEMPLATES are generated
//   with toCsv, downloaded, filled in, and re-parsed by our own parseCsv.
//   The formula-guard apostrophe is NOT part of the value and parseCsv
//   doesn't strip it, so guarding here would corrupt the round-trip for a
//   day/stage name starting with a trigger char. The template only embeds
//   the event's own (within-trust) day/stage names, so the formula-guard
//   trade-off isn't worth breaking round-trip fidelity.
//
// The formula guard runs first; the `'` prefix never introduces a
// comma/quote/newline, so the RFC-4180 check still applies correctly.

const FORMULA_TRIGGER = /^[=+\-@\t\r]/

// RFC 4180: wrap in double quotes when the value contains a comma, quote,
// CR, or LF, doubling any embedded quotes.
export function escapeCsvCell(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

// RFC 4180 + formula-injection guard. Use for exports opened directly in a
// spreadsheet and never re-parsed by our code.
export function escapeCsvField(value: string): string {
  const guarded = FORMULA_TRIGGER.test(value) ? `'${value}` : value
  return escapeCsvCell(guarded)
}

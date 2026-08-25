import type { ImportSummary } from '@rallypoint/lists-shared'

// Turns an import result into the sentence the Settings page shows. Pure so
// the wording — especially the "nothing new" case, which is the EXPECTED
// outcome of re-running an archive and must not read like a failure — is
// unit-testable without rendering the page.

const ENTITY_LABELS: Record<string, [singular: string, plural: string]> = {
  lists: ['list', 'lists'],
  listItems: ['item', 'items'],
  recurring: ['recurring task', 'recurring tasks'],
  events: ['event', 'events'],
  eventTickets: ['attachment', 'attachments'],
  customFields: ['custom field', 'custom fields'],
  statuses: ['status', 'statuses'],
  labels: ['label', 'labels'],
  comments: ['comment', 'comments'],
}

function label(entity: string, count: number): string {
  const pair = ENTITY_LABELS[entity]
  if (!pair) return `${count} ${entity}`
  return `${count} ${count === 1 ? pair[0] : pair[1]}`
}

export function formatImportSummary(summary: ImportSummary): string {
  const created = Object.entries(summary.counts)
    .filter(([, c]) => c.created > 0)
    .map(([entity, c]) => label(entity, c.created))
  const skipped = Object.values(summary.counts).reduce((n, c) => n + c.skipped, 0)

  const lines: string[] = []
  if (created.length) {
    lines.push(`Imported ${created.join(', ')}.`)
    if (skipped) lines.push(`${skipped} already here, so they were left alone.`)
  } else if (skipped) {
    // The re-run case. Say it plainly: nothing was lost, nothing was doubled.
    lines.push(`Everything in that file was already in your account — nothing was duplicated.`)
  } else {
    lines.push('That archive had nothing to import.')
  }

  if (summary.warnings.length) {
    const n = summary.warnings.length
    lines.push(`${n} item${n === 1 ? '' : 's'} could not be restored fully.`)
    // Only the first few, and only their messages — the codes are for logs.
    for (const w of summary.warnings.slice(0, 3)) lines.push(`• ${w.message}`)
    if (n > 3) lines.push(`• …and ${n - 3} more.`)
  }

  return lines.join('\n')
}

/** Filename for a downloaded export, e.g. `planner-export-2026-08-21.zip`. */
export function exportFileName(now: Date): string {
  return `planner-export-${now.toISOString().slice(0, 10)}.zip`
}

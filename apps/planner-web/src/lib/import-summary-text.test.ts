import { describe, expect, it } from 'vitest'
import { exportFileName, formatImportSummary } from './import-summary-text.js'

describe('formatImportSummary', () => {
  it('lists what was created, pluralised per entity', () => {
    const text = formatImportSummary({
      counts: {
        listItems: { created: 3, skipped: 0 },
        lists: { created: 1, skipped: 0 },
      },
      warnings: [],
    })
    expect(text).toBe('Imported 3 items, 1 list.')
  })

  it('mentions skipped rows alongside created ones', () => {
    const text = formatImportSummary({
      counts: {
        listItems: { created: 2, skipped: 0 },
        events: { created: 0, skipped: 5 },
      },
      warnings: [],
    })
    expect(text).toContain('Imported 2 items.')
    expect(text).toContain('5 already here')
  })

  it('reads as success, not failure, when a re-run created nothing', () => {
    // This is the EXPECTED outcome of importing the same archive twice, so it
    // must not look like an error to the user.
    const text = formatImportSummary({
      counts: {
        listItems: { created: 0, skipped: 4 },
        lists: { created: 0, skipped: 1 },
      },
      warnings: [],
    })
    expect(text).toBe(
      'Everything in that file was already in your account — nothing was duplicated.',
    )
    expect(text).not.toMatch(/fail|error|could not/i)
  })

  it('handles an archive with nothing in it', () => {
    expect(formatImportSummary({ counts: {}, warnings: [] })).toBe(
      'That archive had nothing to import.',
    )
  })

  it('surfaces warning messages but not their codes', () => {
    const text = formatImportSummary({
      counts: { listItems: { created: 1, skipped: 0 } },
      warnings: [
        { entity: 'lists', code: 'missing_parent', message: 'A parent item was missing.' },
      ],
    })
    expect(text).toContain('1 item could not be restored fully.')
    expect(text).toContain('• A parent item was missing.')
    expect(text).not.toContain('missing_parent')
  })

  it('truncates a long warning list', () => {
    const warnings = Array.from({ length: 7 }, (_, i) => ({
      entity: 'lists',
      code: 'missing_parent',
      message: `Problem ${i}.`,
    }))
    const text = formatImportSummary({
      counts: { listItems: { created: 1, skipped: 0 } },
      warnings,
    })
    expect(text).toContain('7 items could not be restored fully.')
    expect(text).toContain('• Problem 0.')
    expect(text).toContain('• Problem 2.')
    expect(text).not.toContain('• Problem 3.')
    expect(text).toContain('…and 4 more.')
  })

  it('falls back to the raw entity name for an unknown section', () => {
    // A newer server can send a section this client has no label for; it
    // should still render a count rather than dropping the row silently.
    const text = formatImportSummary({
      counts: { somethingNew: { created: 2, skipped: 0 } },
      warnings: [],
    })
    expect(text).toBe('Imported 2 somethingNew.')
  })
})

describe('exportFileName', () => {
  it('stamps the UTC date', () => {
    expect(exportFileName(new Date('2026-08-21T23:30:00.000Z'))).toBe('planner-export-2026-08-21.zip')
  })
})

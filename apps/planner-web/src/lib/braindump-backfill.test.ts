import { describe, expect, it } from 'vitest'
import { ApiError } from '@rallypoint/web-kit'
import {
  analyzableText,
  backfillDelayMs,
  backfillProgressLabel,
  classifyBackfillError,
  isFatalBackfillError,
  noteConversionInput,
  runBackfill,
  selectUnanalyzed,
} from './braindump-backfill.js'
import type { StreamEntry } from './braindump-helpers.js'

function entry(over: Partial<StreamEntry> & { key: string }): StreamEntry {
  return {
    id: over.key,
    source: 'braindump',
    listId: 'lst_bd',
    title: 't',
    body: null,
    day: '',
    timed: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    category: null,
    analysis: null,
    raw: null,
    ...over,
  }
}

describe('analyzableText', () => {
  it('prefers a trimmed body over the title', () => {
    expect(analyzableText(entry({ key: 'a', body: '  a long enough body  ', title: 'x' }))).toBe(
      'a long enough body',
    )
  })

  it('falls back to the trimmed title when the body is empty/whitespace/null', () => {
    expect(analyzableText(entry({ key: 'a', body: null, title: 'a decent title' }))).toBe(
      'a decent title',
    )
    expect(analyzableText(entry({ key: 'b', body: '   ', title: 'a decent title' }))).toBe(
      'a decent title',
    )
  })

  it('returns null only when both body and title are empty', () => {
    expect(analyzableText(entry({ key: 'a', body: null, title: '' }))).toBeNull()
    expect(analyzableText(entry({ key: 'b', body: '   ', title: '   ' }))).toBeNull()
  })

  it('accepts short text — no minimum length, matching the server (min 1 char)', () => {
    expect(analyzableText(entry({ key: 'a', body: 'hi', title: '' }))).toBe('hi')
    expect(analyzableText(entry({ key: 'b', body: null, title: 'x' }))).toBe('x')
  })
})

describe('selectUnanalyzed', () => {
  it('filters out already-analyzed entries', () => {
    const analyzed = entry({
      key: 'a',
      body: 'a long enough body',
      analysis: { v: 1, themes: [], entities: [], summary: null, model: 'x' },
    })
    const bare = entry({ key: 'b', body: 'another long enough body' })
    expect(selectUnanalyzed([analyzed, bare]).map((e) => e.key)).toEqual(['b'])
  })

  it('filters out entries with no analyzable text', () => {
    const empty = entry({ key: 'a', body: null, title: '' })
    const ok = entry({ key: 'b', body: 'a long enough body' })
    expect(selectUnanalyzed([empty, ok]).map((e) => e.key)).toEqual(['b'])
  })

  it('applies a 10-char floor for bulk eligibility even though analyzableText has none', () => {
    const bareHeading = entry({ key: 'a', body: null, title: 'hi' })
    const ok = entry({ key: 'b', body: 'a long enough body' })
    expect(analyzableText(bareHeading)).toBe('hi')
    expect(selectUnanalyzed([bareHeading, ok]).map((e) => e.key)).toEqual(['b'])
  })

  it('requires a listId for diary and braindump rows but not for notes', () => {
    const diaryNoList = entry({
      key: 'd1',
      source: 'diary',
      listId: null,
      body: 'a long enough body',
    })
    const bdNoList = entry({
      key: 'bd1',
      source: 'braindump',
      listId: null,
      body: 'a long enough body',
    })
    const noteNoList = entry({
      key: 'n1',
      source: 'note',
      listId: null,
      body: 'a long enough body',
    })
    expect(selectUnanalyzed([diaryNoList, bdNoList, noteNoList]).map((e) => e.key)).toEqual(['n1'])
  })

  it('preserves input (newest-first) order and caps at limit', () => {
    const entries = [
      entry({ key: '1', body: 'a long enough body one' }),
      entry({ key: '2', body: 'a long enough body two' }),
      entry({ key: '3', body: 'a long enough body three' }),
    ]
    expect(selectUnanalyzed(entries).map((e) => e.key)).toEqual(['1', '2', '3'])
    expect(selectUnanalyzed(entries, 2).map((e) => e.key)).toEqual(['1', '2'])
  })
})

describe('backfillDelayMs', () => {
  it('backs off a full minute on a 429', () => {
    expect(backfillDelayMs(new ApiError('rate_limited', 'Too many requests', 429))).toBe(60000)
  })

  it('uses the short delay for other ApiErrors', () => {
    expect(backfillDelayMs(new ApiError('unusable', 'nope', 422))).toBe(5000)
    expect(backfillDelayMs(new ApiError('unavailable', 'down', 503))).toBe(5000)
  })

  it('uses the short delay for a non-ApiError', () => {
    expect(backfillDelayMs(new Error('boom'))).toBe(5000)
    expect(backfillDelayMs(null)).toBe(5000)
  })
})

describe('isFatalBackfillError', () => {
  it('treats 401/403 as fatal', () => {
    expect(isFatalBackfillError(new ApiError('unauthorized', 'nope', 401))).toBe(true)
    expect(isFatalBackfillError(new ApiError('forbidden', 'nope', 403))).toBe(true)
  })

  it('treats other statuses and non-ApiErrors as non-fatal', () => {
    expect(isFatalBackfillError(new ApiError('unusable', 'nope', 422))).toBe(false)
    expect(isFatalBackfillError(new ApiError('unavailable', 'down', 503))).toBe(false)
    expect(isFatalBackfillError(new Error('boom'))).toBe(false)
  })
})

describe('classifyBackfillError', () => {
  it('classifies 429 as rate-limited', () => {
    expect(classifyBackfillError(new ApiError('rate_limited', 'nope', 429))).toBe('rate-limited')
  })

  it('classifies 401/403 as fatal', () => {
    expect(classifyBackfillError(new ApiError('unauthorized', 'nope', 401))).toBe('fatal')
    expect(classifyBackfillError(new ApiError('forbidden', 'nope', 403))).toBe('fatal')
  })

  it('classifies other statuses and non-ApiErrors as skip', () => {
    expect(classifyBackfillError(new ApiError('unusable', 'nope', 422))).toBe('skip')
    expect(classifyBackfillError(new Error('boom'))).toBe('skip')
    expect(classifyBackfillError(null)).toBe('skip')
  })
})

describe('backfillProgressLabel', () => {
  it('reports the in-flight entry number while running', () => {
    expect(backfillProgressLabel({ running: true, done: 2, failed: 1, total: 10 })).toBe(
      'Analyzing 4 of 10…',
    )
  })

  it('reports a clean finish, singular and plural', () => {
    expect(backfillProgressLabel({ running: false, done: 1, failed: 0, total: 1 })).toBe(
      'Analyzed 1 entry.',
    )
    expect(backfillProgressLabel({ running: false, done: 5, failed: 0, total: 5 })).toBe(
      'Analyzed 5 entries.',
    )
  })

  it('reports a finish with failures', () => {
    expect(backfillProgressLabel({ running: false, done: 3, failed: 2, total: 5 })).toBe(
      "Analyzed 3 of 5 — 2 couldn't be analyzed, try again later.",
    )
  })

  it('reports a stopped-early finish distinctly', () => {
    expect(
      backfillProgressLabel({ running: false, done: 3, failed: 0, total: 10, stopped: true }),
    ).toBe('Stopped — analyzed 3 of 10.')
  })

  it('reports a fatal-abort finish distinctly from a clean/stopped finish', () => {
    expect(
      backfillProgressLabel({ running: false, done: 2, failed: 0, total: 10, aborted: true }),
    ).toBe('Stopped due to an error — analyzed 2 of 10.')
    // aborted takes precedence over stopped when somehow both are set.
    expect(
      backfillProgressLabel({
        running: false,
        done: 2,
        failed: 0,
        total: 10,
        stopped: true,
        aborted: true,
      }),
    ).toBe('Stopped due to an error — analyzed 2 of 10.')
  })
})

describe('runBackfill', () => {
  function entries(n: number): StreamEntry[] {
    return Array.from({ length: n }, (_, i) =>
      entry({ key: `e${i}`, body: `entry body number ${i}` }),
    )
  }

  function noopSleep() {
    const calls: number[] = []
    return { sleep: (ms: number) => { calls.push(ms); return Promise.resolve() }, calls }
  }

  it('happy path: analyzes every target in order, sleeping between but not after the last', async () => {
    const targets = entries(3)
    const seen: string[] = []
    const { sleep, calls } = noopSleep()
    const result = await runBackfill({
      targets,
      analyzeOne: async (e) => {
        seen.push(e.key)
      },
      sleep,
      isCancelled: () => false,
    })
    expect(result).toEqual({ done: 3, failed: 0, cancelled: false, fatal: null })
    expect(seen).toEqual(['e0', 'e1', 'e2'])
    expect(calls).toEqual([5000, 5000])
  })

  it('counts a "skip"-classified failure as failed and continues to the next entry', async () => {
    const targets = entries(2)
    const { sleep } = noopSleep()
    const seen: string[] = []
    const result = await runBackfill({
      targets,
      analyzeOne: async (e) => {
        seen.push(e.key)
        if (e.key === 'e0') throw new Error('boom')
      },
      sleep,
      isCancelled: () => false,
    })
    expect(seen).toEqual(['e0', 'e1'])
    expect(result).toEqual({ done: 1, failed: 1, cancelled: false, fatal: null })
  })

  it('retries a 429 once on the same entry, then succeeds without counting it failed', async () => {
    const targets = entries(1)
    let calls = 0
    const sleeps: number[] = []
    const rateLimited: number[] = []
    const result = await runBackfill({
      targets,
      analyzeOne: async () => {
        calls++
        if (calls === 1) throw new ApiError('rate_limited', 'nope', 429)
      },
      sleep: (ms) => {
        sleeps.push(ms)
        return Promise.resolve()
      },
      isCancelled: () => false,
      onRateLimited: () => rateLimited.push(1),
    })
    expect(calls).toBe(2)
    expect(sleeps).toEqual([60000])
    expect(rateLimited).toEqual([1])
    expect(result).toEqual({ done: 1, failed: 0, cancelled: false, fatal: null })
  })

  it('a second 429 in a row counts the entry failed once and moves on', async () => {
    const targets = entries(2)
    let calls = 0
    const seen: string[] = []
    const result = await runBackfill({
      targets,
      analyzeOne: async (e) => {
        calls++
        seen.push(e.key)
        throw new ApiError('rate_limited', 'nope', 429)
      },
      sleep: () => Promise.resolve(),
      isCancelled: () => false,
    })
    // e0 attempted twice (initial + one retry), e1 attempted twice too.
    expect(calls).toBe(4)
    expect(seen).toEqual(['e0', 'e0', 'e1', 'e1'])
    expect(result).toEqual({ done: 0, failed: 2, cancelled: false, fatal: null })
  })

  it('paces the NEXT entry by the full backoff after a rate-limited failure', async () => {
    const targets = entries(2)
    let calls = 0
    const sleeps: number[] = []
    const result = await runBackfill({
      targets,
      analyzeOne: async (e) => {
        calls++
        // e0 fails on 429 twice; e1 succeeds.
        if (e.key === 'e0') throw new ApiError('rate_limited', 'nope', 429)
      },
      sleep: (ms) => {
        sleeps.push(ms)
        return Promise.resolve()
      },
      isCancelled: () => false,
    })
    // Backoff before e0's retry, then the inter-entry sleep is ALSO the
    // full backoff (the window is still exhausted), not the 5s delay.
    expect(sleeps).toEqual([60000, 60000])
    expect(calls).toBe(3)
    expect(result).toEqual({ done: 1, failed: 1, cancelled: false, fatal: null })
  })

  it('a fatal error aborts the run immediately, reporting the error', async () => {
    const targets = entries(3)
    const seen: string[] = []
    const err = new ApiError('unauthorized', 'nope', 401)
    const result = await runBackfill({
      targets,
      analyzeOne: async (e) => {
        seen.push(e.key)
        if (e.key === 'e1') throw err
      },
      sleep: () => Promise.resolve(),
      isCancelled: () => false,
    })
    expect(seen).toEqual(['e0', 'e1'])
    expect(result).toEqual({ done: 1, failed: 0, cancelled: false, fatal: err })
  })

  it('a second fatal (after a 429 retry) also aborts', async () => {
    const targets = entries(1)
    let calls = 0
    const err401 = new ApiError('unauthorized', 'nope', 401)
    const result = await runBackfill({
      targets,
      analyzeOne: async () => {
        calls++
        throw calls === 1 ? new ApiError('rate_limited', 'nope', 429) : err401
      },
      sleep: () => Promise.resolve(),
      isCancelled: () => false,
    })
    expect(calls).toBe(2)
    expect(result).toEqual({ done: 0, failed: 0, cancelled: false, fatal: err401 })
  })

  it('stops immediately when cancelled before starting', async () => {
    const targets = entries(3)
    const seen: string[] = []
    const result = await runBackfill({
      targets,
      analyzeOne: async (e) => {
        seen.push(e.key)
      },
      sleep: () => Promise.resolve(),
      isCancelled: () => true,
    })
    expect(seen).toEqual([])
    expect(result).toEqual({ done: 0, failed: 0, cancelled: true, fatal: null })
  })

  it('cancels mid-run after the current entry settles', async () => {
    const targets = entries(3)
    const seen: string[] = []
    let cancelled = false
    const result = await runBackfill({
      targets,
      analyzeOne: async (e) => {
        seen.push(e.key)
        if (e.key === 'e0') cancelled = true
      },
      sleep: () => Promise.resolve(),
      isCancelled: () => cancelled,
    })
    expect(seen).toEqual(['e0'])
    expect(result).toEqual({ done: 1, failed: 0, cancelled: true, fatal: null })
  })

  it('reports onProgress after each settled entry with running totals', async () => {
    const targets = entries(2)
    const progress: Array<{ done: number; failed: number }> = []
    await runBackfill({
      targets,
      analyzeOne: async (e) => {
        if (e.key === 'e1') throw new Error('boom')
      },
      sleep: () => Promise.resolve(),
      isCancelled: () => false,
      onProgress: (s) => progress.push({ ...s }),
    })
    expect(progress).toEqual([
      { done: 1, failed: 0 },
      { done: 1, failed: 1 },
    ])
  })
})

describe('noteConversionInput', () => {
  const fields = { lfd_cat: 'opt_work' }

  it('uses the trimmed entry title when present', () => {
    const e = entry({ key: 'n1', source: 'note', listId: null, title: '  My note  ', body: 'body' })
    const out = noteConversionInput(e, { title: 'AI title' }, fields)
    expect(out.title).toBe('My note')
    expect(out.notes).toBe('body')
    expect(out.customFields).toBe(fields)
  })

  it('falls back to the enrichment title when the entry title is blank', () => {
    const e = entry({ key: 'n1', source: 'note', listId: null, title: '   ', body: null })
    const out = noteConversionInput(e, { title: 'AI title' }, fields)
    expect(out.title).toBe('AI title')
    expect(out.notes).toBeNull()
  })

  it('sets dueDate from a non-empty day, omits it otherwise', () => {
    const withDay = entry({ key: 'n1', source: 'note', listId: null, day: '2026-06-01' })
    expect(noteConversionInput(withDay, { title: 'x' }, fields).dueDate).toBe('2026-06-01')

    const noDay = entry({ key: 'n2', source: 'note', listId: null, day: '' })
    expect('dueDate' in noteConversionInput(noDay, { title: 'x' }, fields)).toBe(false)
  })
})

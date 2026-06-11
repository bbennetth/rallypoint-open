import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DURATION_MS,
  MAX_QUEUE_SIZE,
  enqueue,
  expireQueue,
  makeToast,
  nextExpireDeadline,
  type Toast,
} from './toast-queue.js'

const NOW = 1_700_000_000_000

function build(overrides: Partial<Toast> = {}): Toast {
  return {
    id: overrides.id ?? 't_test',
    tone: overrides.tone ?? 'info',
    body: overrides.body ?? 'hi',
    durationMs: overrides.durationMs ?? DEFAULT_DURATION_MS,
    createdAt: overrides.createdAt ?? NOW,
  }
}

describe('makeToast', () => {
  it('uses defaults for tone + durationMs', () => {
    const t = makeToast({ body: 'hello' }, NOW, 'x')
    expect(t.tone).toBe('info')
    expect(t.durationMs).toBe(DEFAULT_DURATION_MS)
    expect(t.body).toBe('hello')
  })

  it('derives id when not supplied', () => {
    const t = makeToast({ body: 'hi' }, NOW, 'abc')
    expect(t.id).toBe(`t_${NOW}_abc`)
  })

  it('respects an explicit id', () => {
    const t = makeToast({ id: 'kept', body: 'hi' }, NOW, 'x')
    expect(t.id).toBe('kept')
  })
})

describe('enqueue', () => {
  it('appends within the cap', () => {
    const q = enqueue([], build({ id: 'a' }))
    expect(q.map((t) => t.id)).toEqual(['a'])
  })

  it('drops oldest entries when over the cap', () => {
    let q: Toast[] = []
    for (let i = 0; i < MAX_QUEUE_SIZE + 2; i += 1) {
      q = enqueue(q, build({ id: `t${i}` }))
    }
    expect(q.length).toBe(MAX_QUEUE_SIZE)
    expect(q[0]!.id).toBe('t2')
    expect(q[q.length - 1]!.id).toBe(`t${MAX_QUEUE_SIZE + 1}`)
  })

  it('dedups by id — same id replaces the prior copy with a fresh timer', () => {
    // Models the "Copied!" UX: repeatedly tapping the copy button
    // fires the same id; we want one banner with a refreshed
    // expiration, not a stack of identical banners.
    let q: Toast[] = []
    q = enqueue(q, build({ id: 'copied', createdAt: NOW }))
    q = enqueue(q, build({ id: 'other', createdAt: NOW + 100 }))
    q = enqueue(q, build({ id: 'copied', createdAt: NOW + 500 }))
    expect(q.map((t) => t.id)).toEqual(['other', 'copied'])
    expect(q[q.length - 1]!.createdAt).toBe(NOW + 500)
  })
})

describe('expireQueue', () => {
  it('keeps toasts still inside their duration window', () => {
    const q = [build({ id: 'a', createdAt: NOW, durationMs: 5000 })]
    expect(expireQueue(q, NOW + 4000)).toEqual(q)
  })

  it('drops expired toasts', () => {
    const q = [
      build({ id: 'old', createdAt: NOW, durationMs: 1000 }),
      build({ id: 'new', createdAt: NOW + 500, durationMs: 5000 }),
    ]
    const out = expireQueue(q, NOW + 2000)
    expect(out.map((t) => t.id)).toEqual(['new'])
  })

  it('treats durationMs<=0 as manual-dismiss only', () => {
    const q = [build({ id: 'forever', createdAt: NOW, durationMs: 0 })]
    expect(expireQueue(q, NOW + 999_999)).toEqual(q)
  })
})

describe('nextExpireDeadline', () => {
  it('returns null when nothing auto-expires', () => {
    expect(nextExpireDeadline([], NOW)).toBeNull()
    expect(
      nextExpireDeadline(
        [build({ id: 'manual', createdAt: NOW, durationMs: 0 })],
        NOW,
      ),
    ).toBeNull()
  })

  it('returns the earliest future deadline', () => {
    const q = [
      build({ id: 'a', createdAt: NOW, durationMs: 5000 }),
      build({ id: 'b', createdAt: NOW + 500, durationMs: 1000 }), // expires sooner
      build({ id: 'c', createdAt: NOW, durationMs: 10_000 }),
    ]
    expect(nextExpireDeadline(q, NOW)).toBe(NOW + 1500)
  })

  it('ignores toasts already past their deadline', () => {
    const q = [
      build({ id: 'expired', createdAt: NOW, durationMs: 500 }),
      build({ id: 'fresh', createdAt: NOW + 1000, durationMs: 2000 }),
    ]
    expect(nextExpireDeadline(q, NOW + 1000)).toBe(NOW + 3000)
  })
})

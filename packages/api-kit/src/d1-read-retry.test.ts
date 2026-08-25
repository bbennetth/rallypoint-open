import { describe, it, expect, vi } from 'vitest'
import { withD1ReadRetry } from './d1-read-retry.js'

// Tests the decorator itself with a hand-rolled fake binding. Real-D1
// coverage comes for free from every app's test:d1 suite, which now runs
// all queries through this wrapper via each app's createDb.

const TRANSIENT = () =>
  new Error('D1_ERROR: D1 DB storage operation exceeded timeout which caused object to be reset.')

function fakeD1(allImpl: (...args: unknown[]) => Promise<unknown>) {
  const all = vi.fn(allImpl)
  const run = vi.fn(allImpl)
  const stmt = {
    bind: vi.fn((..._values: unknown[]) => stmt),
    all,
    run,
    raw: vi.fn(allImpl),
    first: vi.fn(allImpl),
  }
  const prepare = vi.fn((_sql: string) => stmt)
  return { d1: { prepare, batch: vi.fn(), exec: vi.fn() }, stmt, prepare }
}

describe('withD1ReadRetry', () => {
  it('retries a transient failure on a SELECT and returns the eventual result', async () => {
    let calls = 0
    const { d1, stmt } = fakeD1(async () => {
      calls++
      if (calls === 1) throw TRANSIENT()
      return { results: [{ id: 1 }] }
    })
    const wrapped = withD1ReadRetry(d1, { baseDelayMs: 0 })

    const result = await wrapped.prepare('select * from t where id = ?').bind(1).all()

    expect(result).toEqual({ results: [{ id: 1 }] })
    expect(stmt.all).toHaveBeenCalledTimes(2)
  })

  it('retries WITH … SELECT (CTE reads)', async () => {
    let calls = 0
    const { stmt, d1 } = fakeD1(async () => {
      calls++
      if (calls === 1) throw TRANSIENT()
      return { results: [] }
    })
    const wrapped = withD1ReadRetry(d1, { baseDelayMs: 0 })

    await wrapped.prepare('WITH x AS (select 1) select * from x').all()

    expect(stmt.all).toHaveBeenCalledTimes(2)
  })

  it('does NOT retry a write statement', async () => {
    const { d1, stmt } = fakeD1(async () => {
      throw TRANSIENT()
    })
    const wrapped = withD1ReadRetry(d1, { baseDelayMs: 0 })

    await expect(
      wrapped.prepare('insert into t (id) values (?)').bind(1).run(),
    ).rejects.toThrow(/caused object to be reset/)
    expect(stmt.run).toHaveBeenCalledTimes(1)
  })

  it('does NOT retry a deterministic error on a SELECT', async () => {
    const { d1, stmt } = fakeD1(async () => {
      throw new Error('D1_ERROR: no such column: nope')
    })
    const wrapped = withD1ReadRetry(d1, { baseDelayMs: 0 })

    await expect(wrapped.prepare('select nope from t').all()).rejects.toThrow(/no such column/)
    expect(stmt.all).toHaveBeenCalledTimes(1)
  })

  it('preserves bind chaining and passes batch/exec through to the target', async () => {
    const { d1, prepare } = fakeD1(async () => ({ results: [] }))
    const wrapped = withD1ReadRetry(d1)

    await wrapped.prepare('select * from t where a = ? and b = ?').bind('x', 'y').first()
    expect(prepare).toHaveBeenCalledWith('select * from t where a = ? and b = ?')
    // batch is passed through untouched (bound to the target).
    expect(typeof wrapped.batch).toBe('function')
  })

  it('batch receives the NATIVE statements, not the SELECT proxies', async () => {
    const seen: unknown[] = []
    const { d1, stmt } = fakeD1(async () => ({ results: [] }))
    ;(d1 as { batch: unknown }).batch = vi.fn(async (stmts: unknown[]) => {
      seen.push(...stmts)
      return []
    })
    const wrapped = withD1ReadRetry(d1)

    const selectStmt = wrapped.prepare('select * from t').bind()
    const writeStmt = wrapped.prepare('update t set a = ?').bind(1)
    await (wrapped as { batch(s: unknown[]): Promise<unknown> }).batch([selectStmt, writeStmt])

    // The proxied SELECT is unwrapped back to the underlying native
    // statement; workerd brand-checks would reject a Proxy.
    expect(seen[0]).toBe(stmt)
    expect(seen[1]).toBe(stmt)
  })
})

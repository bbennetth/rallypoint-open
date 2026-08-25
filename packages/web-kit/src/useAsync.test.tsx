// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, cleanup, act } from '@testing-library/react'
import { createGenerationGate, useAsync, useAsyncTask } from './useAsync.js'

describe('createGenerationGate (pure core)', () => {
  it('marks the previous generation stale when a new one begins', () => {
    const gate = createGenerationGate()
    const a = gate.begin()
    expect(a.stale()).toBe(false)
    const b = gate.begin()
    expect(a.stale()).toBe(true)
    expect(b.stale()).toBe(false)
  })

  it('aborts the superseded generation signal', () => {
    const gate = createGenerationGate()
    const a = gate.begin()
    expect(a.signal.aborted).toBe(false)
    gate.begin()
    expect(a.signal.aborted).toBe(true)
  })

  it('close() stales and aborts the live generation', () => {
    const gate = createGenerationGate()
    const a = gate.begin()
    gate.close()
    expect(a.stale()).toBe(true)
    expect(a.signal.aborted).toBe(true)
  })
})

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('useAsync', () => {
  function Harness({ fn, dep }: { fn: (signal: AbortSignal) => Promise<string>; dep: string }) {
    const { data, error, loading } = useAsync(fn, [dep])
    return (
      <div data-testid="out">
        {loading ? 'loading' : error ? `error:${String(error)}` : `data:${data}`}
      </div>
    )
  }
  const out = () => screen.getByTestId('out').textContent

  it('loads data on mount', async () => {
    render(<Harness fn={async () => 'hello'} dep="a" />)
    await waitFor(() => expect(out()).toBe('data:hello'))
    cleanup()
  })

  it('commits errors from the latest run', async () => {
    render(
      <Harness
        fn={async () => {
          throw new Error('boom')
        }}
        dep="a"
      />,
    )
    await waitFor(() => expect(out()).toBe('error:Error: boom'))
    cleanup()
  })

  it('drops the stale resolution when deps change mid-flight (the race)', async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    let call = 0
    const fn = vi.fn(() => (++call === 1 ? first.promise : second.promise))

    const { rerender } = render(<Harness fn={fn} dep="a" />)
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(1))

    rerender(<Harness fn={fn} dep="b" />)
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(2))

    // Newer run settles first…
    await act(async () => second.resolve('fresh'))
    await waitFor(() => expect(out()).toBe('data:fresh'))

    // …then the stale run resolves late: it must NOT overwrite.
    await act(async () => first.resolve('stale'))
    expect(out()).toBe('data:fresh')
    cleanup()
  })

  it('aborts the superseded run signal on deps change', async () => {
    const seen: AbortSignal[] = []
    const never = deferred<string>()
    const fn = (signal: AbortSignal) => {
      seen.push(signal)
      return never.promise
    }
    const { rerender } = render(<Harness fn={fn} dep="a" />)
    await waitFor(() => expect(seen.length).toBe(1))
    rerender(<Harness fn={fn} dep="b" />)
    await waitFor(() => expect(seen.length).toBe(2))
    expect(seen[0]!.aborted).toBe(true)
    expect(seen[1]!.aborted).toBe(false)
    cleanup()
  })
})

describe('useAsyncTask', () => {
  it('swallows rejections from superseded runs but rethrows live ones', async () => {
    let run!: (task: Parameters<ReturnType<typeof useAsyncTask>>[0]) => Promise<void>
    function Harness() {
      run = useAsyncTask()
      return null
    }
    render(<Harness />)

    const first = deferred<never>()
    const p1 = run(async () => first.promise)
    const p2 = run(async () => undefined) // supersedes run 1
    await p2
    // Stale run rejecting must not surface.
    first.reject(new Error('aborted fetch'))
    await expect(p1).resolves.toBeUndefined()

    // A live (latest) run rejecting still surfaces to the caller.
    await expect(
      run(async () => {
        throw new Error('real failure')
      }),
    ).rejects.toThrow('real failure')
    cleanup()
  })
})

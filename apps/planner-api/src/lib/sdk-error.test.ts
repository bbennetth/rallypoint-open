import { describe, it, expect, vi } from 'vitest'
import { ListsClientError } from '@rallypoint/lists-client'
import { EventsClientError } from '@rallypoint/events-client'
import { ApiError } from '../errors.js'
import { proxyLists, proxyEvents, bestEffort } from './sdk-error.js'
import type { Logger } from '../logger.js'

// The SDK gate's anti-fingerprint sentinel: zero peer keys configured on the
// upstream worker → 404 / not_found / "Route not found.". proxyLists/
// proxyEvents must remap THIS (and only this) to a 502 bad_gateway so a
// secrets gap doesn't masquerade as a missing planner route. Every other
// upstream error — including genuine resource-404s with a different message —
// must pass through with its status/code/message intact.

describe('proxyLists', () => {
  it('passes a successful value through unchanged', async () => {
    await expect(proxyLists(async () => 42)).resolves.toBe(42)
  })

  it('remaps the SDK gate miss (404 "Route not found.") to 502 bad_gateway', async () => {
    const gateMiss = () =>
      proxyLists(async () => {
        throw new ListsClientError(404, 'not_found', 'Route not found.')
      })
    await expect(gateMiss()).rejects.toBeInstanceOf(ApiError)
    await expect(gateMiss()).rejects.toMatchObject({ status: 502, code: 'bad_gateway' })
  })

  it('passes a genuine resource 404 through unchanged (different message)', async () => {
    await expect(
      proxyLists(async () => {
        throw new ListsClientError(404, 'not_found', 'List not found.')
      }),
    ).rejects.toMatchObject({ status: 404, code: 'not_found', message: 'List not found.' })
  })

  it('passes a 403 through unchanged', async () => {
    await expect(
      proxyLists(async () => {
        throw new ListsClientError(403, 'forbidden', 'App API authentication required.')
      }),
    ).rejects.toMatchObject({ status: 403, code: 'forbidden' })
  })

  it('lets a non-ListsClientError (transport failure) bubble unwrapped', async () => {
    const e = await proxyLists(async () => {
      throw new Error('connection reset')
    }).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(Error)
    expect(e).not.toBeInstanceOf(ApiError)
    expect((e as Error).message).toBe('connection reset')
  })
})

describe('proxyEvents', () => {
  it('passes a successful value through unchanged', async () => {
    await expect(proxyEvents(async () => 'ok')).resolves.toBe('ok')
  })

  it('remaps the SDK gate miss (404 "Route not found.") to 502 bad_gateway', async () => {
    const gateMiss = () =>
      proxyEvents(async () => {
        throw new EventsClientError(404, 'not_found', 'Route not found.')
      })
    await expect(gateMiss()).rejects.toBeInstanceOf(ApiError)
    await expect(gateMiss()).rejects.toMatchObject({ status: 502, code: 'bad_gateway' })
  })

  it('passes a genuine resource 404 through unchanged (different message)', async () => {
    await expect(
      proxyEvents(async () => {
        throw new EventsClientError(404, 'not_found', 'Personal event not found.')
      }),
    ).rejects.toMatchObject({ status: 404, code: 'not_found', message: 'Personal event not found.' })
  })

  it('passes a 403 through unchanged', async () => {
    await expect(
      proxyEvents(async () => {
        throw new EventsClientError(403, 'forbidden', 'App API authentication required.')
      }),
    ).rejects.toMatchObject({ status: 403, code: 'forbidden' })
  })

  it('lets a non-EventsClientError (transport failure) bubble unwrapped', async () => {
    const e = await proxyEvents(async () => {
      throw new Error('connection reset')
    }).catch((x: unknown) => x)
    expect(e).not.toBeInstanceOf(ApiError)
    expect((e as Error).message).toBe('connection reset')
  })
})

describe('bestEffort', () => {
  it('returns the value on success', async () => {
    await expect(bestEffort(async () => [1, 2, 3], [])).resolves.toEqual([1, 2, 3])
  })

  it('swallows ANY failure (incl. the gate miss) and returns the fallback', async () => {
    await expect(
      bestEffort(async () => {
        throw new EventsClientError(404, 'not_found', 'Route not found.')
      }, []),
    ).resolves.toEqual([])
  })

  it('does not require a logger — still returns fallback when none is provided', async () => {
    await expect(
      bestEffort(async () => {
        throw new TypeError('unexpected programmer error')
      }, null),
    ).resolves.toBeNull()
  })

  it('calls logger.warn with the error when a logger is supplied', async () => {
    const warn = vi.fn()
    const fakeLogger = { warn } as unknown as Logger
    const err = new TypeError('boom')
    await expect(
      bestEffort(async () => {
        throw err
      }, 'fallback', fakeLogger),
    ).resolves.toBe('fallback')
    expect(warn).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith({ err }, 'bestEffort: swallowed failure, returning fallback')
  })
})

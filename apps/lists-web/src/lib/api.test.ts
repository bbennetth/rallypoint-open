// @vitest-environment jsdom
// The real @rallypoint/ui theme store touches document + localStorage, so this
// file needs a DOM even under the root (node) vitest runner.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useThemeStore, sanitizeTheme, sanitizeColor } from '@rallypoint/ui'
import { ApiError, getSession } from './api.js'

// createCsrfClient (used by api.ts at module load) captures globalThis.fetch BY
// VALUE at client-creation time, so a post-import reassignment is ignored. The
// vi.hoisted factory runs before this file's imports, so the stub is in place
// before api.ts builds its client. Each test sets the next response.
const { setNextResponse } = vi.hoisted(() => {
  let next: Partial<Response> | null = null
  globalThis.fetch = (async () => {
    if (!next) throw new Error('no stubbed fetch response queued')
    // Single-use: clear after consuming so a test that forgets
    // setNextResponse fails loudly instead of reusing a stale response.
    const resp = next
    next = null
    return resp as Response
  }) as unknown as typeof fetch
  return {
    setNextResponse: (resp: Partial<Response>) => {
      next = resp
    },
  }
})

function jsonResp(body: unknown, status = 200): Partial<Response> {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    clone() {
      return this as Response
    },
  }
}

describe('getSession theme hydration', () => {
  beforeEach(() => {
    // Known baseline that differs from every hydration target below, so any
    // store change is observable.
    useThemeStore.getState().setMode('light')
    useThemeStore.getState().setColor('green')
  })

  it('hydrates the theme store from the session settings doc', async () => {
    setNextResponse(
      jsonResp({ user_id: 'user_abc', settings: { themeMode: 'dark', themeColor: 'orange' } }),
    )

    const session = await getSession()

    expect(session.user_id).toBe('user_abc')
    expect(useThemeStore.getState().mode).toBe('dark')
    expect(useThemeStore.getState().color).toBe('orange')
  })

  it('leaves the theme store untouched when the session has no settings', async () => {
    setNextResponse(jsonResp({ user_id: 'user_xyz' }))

    await getSession()

    expect(useThemeStore.getState().mode).toBe('light')
    expect(useThemeStore.getState().color).toBe('green')
  })

  it('sanitizes malformed settings rather than applying them verbatim', async () => {
    setNextResponse(
      jsonResp({ user_id: 'user_bad', settings: { themeMode: 'bogus', themeColor: 'nope' } }),
    )

    await getSession()

    // Real sanitize path: unknown mode → dark, unknown color → blue.
    expect(useThemeStore.getState().mode).toBe(sanitizeTheme('bogus'))
    expect(useThemeStore.getState().color).toBe(sanitizeColor('nope'))
  })

  it('rejects with ApiError on a non-2xx session response', async () => {
    setNextResponse(jsonResp({ error: { code: 'internal' } }, 500))

    await expect(getSession()).rejects.toBeInstanceOf(ApiError)
  })
})

import { describe, it, expect, vi } from 'vitest'
import { createRequireAllowedOrigin } from './origin.js'

const FORBIDDEN = (message: string) => Object.assign(new Error('forbidden-sentinel'), { message })

function makeCtx(params: { method: string; origin?: string; env?: Record<string, unknown> }) {
  return {
    var: { env: params.env ?? { UI_ORIGIN: 'https://app.example' } },
    req: {
      method: params.method,
      header: (name: string) => (name.toLowerCase() === 'origin' ? params.origin : undefined),
    },
  }
}

const single = { allowedOriginEnvKeys: ['UI_ORIGIN'], errors: { forbidden: FORBIDDEN } }

describe('createRequireAllowedOrigin — hardened variant', () => {
  it('allows a safe method (GET) with no Origin header', async () => {
    const next = vi.fn(async () => {})
    await createRequireAllowedOrigin(single)(makeCtx({ method: 'GET' }) as never, next)
    expect(next).toHaveBeenCalledOnce()
  })

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'rejects a state-changing %s with no Origin header (the admin/fitness fix)',
    async (method) => {
      const next = vi.fn(async () => {})
      await expect(
        createRequireAllowedOrigin(single)(makeCtx({ method }) as never, next),
      ).rejects.toThrow('Origin header required for state-changing requests.')
      expect(next).not.toHaveBeenCalled()
    },
  )

  it('allows any method when the Origin matches an allowed value', async () => {
    const next = vi.fn(async () => {})
    await createRequireAllowedOrigin(single)(
      makeCtx({ method: 'POST', origin: 'https://app.example' }) as never,
      next,
    )
    expect(next).toHaveBeenCalledOnce()
  })

  it('rejects a present but disallowed Origin', async () => {
    const next = vi.fn(async () => {})
    await expect(
      createRequireAllowedOrigin(single)(
        makeCtx({ method: 'POST', origin: 'https://evil.example' }) as never,
        next,
      ),
    ).rejects.toThrow('Origin not allowed: https://evil.example')
    expect(next).not.toHaveBeenCalled()
  })

  it('accepts either origin under a multi-key config (id-api UI_ORIGIN + PUBLIC_BASE_URL)', async () => {
    const multi = {
      allowedOriginEnvKeys: ['UI_ORIGIN', 'PUBLIC_BASE_URL'],
      errors: { forbidden: FORBIDDEN },
    }
    const env = { UI_ORIGIN: 'https://id.example', PUBLIC_BASE_URL: 'https://api.example' }
    for (const origin of ['https://id.example', 'https://api.example']) {
      const next = vi.fn(async () => {})
      await createRequireAllowedOrigin(multi)(
        makeCtx({ method: 'POST', origin, env }) as never,
        next,
      )
      expect(next).toHaveBeenCalledOnce()
    }
    // A third origin is still rejected.
    await expect(
      createRequireAllowedOrigin(multi)(
        makeCtx({ method: 'POST', origin: 'https://other.example', env }) as never,
        vi.fn(),
      ),
    ).rejects.toThrow(/not allowed/)
  })
})

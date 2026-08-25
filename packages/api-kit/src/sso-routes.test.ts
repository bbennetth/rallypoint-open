import { describe, it, expect, vi, afterEach } from 'vitest'
import { hashToken } from '@rallypoint/crypto'
import { createSignoutHandler } from './sso-routes.js'

// The signout handler is best-effort: a hung RPID single-logout (now bounded by
// withTimeout) must never block clearing the LOCAL session. Prove the row is
// still deleted and the cookie still cleared when signoutRpidBearer never
// resolves.

const COOKIE_NAME = 'rpl_session'
const RAW = 'rpl_sess_signout_token'
const ID_HASH = hashToken(RAW)

function makeCtx(idClient: { signoutRpidBearer: (b: string) => Promise<void> }) {
  const sessions = {
    findByIdHash: vi.fn(async () => ({
      rpidBearerCiphertext: Buffer.from('ct'),
      rpidBearerNonce: Buffer.from('nonce'),
      rpidBearerKeyVersion: 1,
    })),
    deleteByIdHash: vi.fn(async () => {}),
  }
  const headers: Array<[string, string]> = []
  const vars = {
    env: { [COOKIE_NAME]: COOKIE_NAME, NODE_ENV: 'test' },
    repos: { sessions },
    services: { idClient },
    logger: { warn: vi.fn() },
  }
  const c = {
    var: vars,
    req: { header: (name: string) => (name === 'cookie' ? `${COOKIE_NAME}=${RAW}` : undefined) },
    header: vi.fn((name: string, value: string) => headers.push([name, value])),
    body: vi.fn((_: unknown, status: number) => ({ status })),
  }
  return { c, sessions, headers, logger: vars.logger }
}

describe('createSignoutHandler — RPC timeout behaviour', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('still deletes the local row and clears the cookie when RPID logout hangs', async () => {
    vi.useFakeTimers()
    const idClient = { signoutRpidBearer: () => new Promise<void>(() => {}) } // never resolves
    const { c, sessions, headers, logger } = makeCtx(idClient)
    const handler = createSignoutHandler({
      sessionCookieEnvKey: COOKIE_NAME,
      keyV1EnvKey: 'RPL_KEY_V1',
      decryptBearer: () => 'rpid-bearer',
    })

    const done = handler(c as never)
    await vi.advanceTimersByTimeAsync(5_000)
    const res = (await done) as { status: number }

    expect(res.status).toBe(204)
    expect(sessions.deleteByIdHash).toHaveBeenCalledWith(ID_HASH)
    // Best-effort: the hang is logged, not fatal.
    expect(logger.warn).toHaveBeenCalledOnce()
    // The clear-cookie Set-Cookie header is still written.
    expect(headers.some(([name]) => name === 'Set-Cookie')).toBe(true)
  })
})

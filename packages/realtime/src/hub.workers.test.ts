import { env, runInDurableObject } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import { mintChannelToken } from './channel-token.js'
import type { RealtimeEnvelope } from './types.js'

// RealtimeHub Durable Object tests — run in a real workerd isolate
// (Miniflare) via vitest.workers.config.ts, which binds HUB to the
// RealtimeHub exported by test/hub-worker.ts. Validates the Phase 3
// realtime mechanism on lists channel names: WS auth on connect, broadcast
// fan-out, refresh rejection, and the expiry sweep.

// Must match REALTIME_TOKEN_HMAC_KEY in vitest.workers.config.ts.
const KEY = 'test-realtime-hmac-key-not-a-real-secret'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const HUB = (env as any).HUB as {
  idFromName(name: string): unknown
  get(id: unknown): { fetch(input: string, init?: RequestInit): Promise<Response> }
}

function stubFor(channel: string) {
  return HUB.get(HUB.idFromName(channel))
}

function envelope(id: string): RealtimeEnvelope {
  return { resource: 'list_items', operation: 'update', payload: { id }, ts: '2026-06-06T00:00:00Z' }
}

interface OpenSocket {
  ws: WebSocket
  messages: string[]
  closeCode: number | null
}

async function connect(channel: string, token: string): Promise<Response> {
  return stubFor(channel).fetch(`https://hub/api/v1/ui/realtime?token=${encodeURIComponent(token)}`, {
    headers: { Upgrade: 'websocket' },
  })
}

async function openSocket(channel: string, token: string): Promise<OpenSocket> {
  const res = await connect(channel, token)
  expect(res.status).toBe(101)
  const ws = res.webSocket as WebSocket
  const state: OpenSocket = { ws, messages: [], closeCode: null }
  ws.accept()
  ws.addEventListener('message', (e: MessageEvent) => {
    state.messages.push(e.data as string)
  })
  ws.addEventListener('close', (e: CloseEvent) => {
    state.closeCode = e.code
  })
  return state
}

async function broadcast(channel: string, env_: RealtimeEnvelope): Promise<Response> {
  return stubFor(channel).fetch('https://hub/broadcast', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(env_),
  })
}

const tick = (ms = 50): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('RealtimeHub', () => {
  it('accepts a socket with a valid token and delivers a broadcast', async () => {
    const channel = 'lists:list:lst_accept'
    const sock = await openSocket(channel, mintChannelToken({ channel, key: KEY }))

    const res = await broadcast(channel, envelope('li_1'))
    expect(res.status).toBe(204)
    await tick()

    expect(sock.messages).toHaveLength(1)
    expect(JSON.parse(sock.messages[0] as string)).toEqual(envelope('li_1'))
  })

  it('rejects a missing or malformed token with 401', async () => {
    const channel = 'lists:list:lst_notoken'
    expect((await connect(channel, '')).status).toBe(401)
    expect((await connect(channel, 'garbage')).status).toBe(401)
  })

  it('rejects an expired token with 401', async () => {
    const channel = 'lists:list:lst_expired'
    const token = mintChannelToken({ channel, key: KEY, now: Date.now() - 10_000, ttlMs: 1000 })
    expect((await connect(channel, token)).status).toBe(401)
  })

  it('rejects a token signed with the wrong key with 401', async () => {
    const channel = 'lists:scope:list_group:grp_x'
    const token = mintChannelToken({ channel, key: 'wrong-key-wrong-key-wrong-key-xx' })
    expect((await connect(channel, token)).status).toBe(401)
  })

  it('fans a broadcast out to every socket on the channel', async () => {
    const channel = 'lists:scope:list_group:grp_fanout'
    const a = await openSocket(channel, mintChannelToken({ channel, key: KEY }))
    const b = await openSocket(channel, mintChannelToken({ channel, key: KEY }))

    await broadcast(channel, envelope('li_fan'))
    await tick()

    expect(a.messages).toHaveLength(1)
    expect(b.messages).toHaveLength(1)
  })

  it('closes a socket that pushes an invalid refresh token', async () => {
    const channel = 'lists:list:lst_badrefresh'
    const sock = await openSocket(channel, mintChannelToken({ channel, key: KEY }))

    sock.ws.send(JSON.stringify({ type: 'token', token: 'not-valid' }))
    await tick()

    expect(sock.closeCode).toBe(1008)
  })

  it('the alarm sweep closes a socket whose token has lapsed', async () => {
    const channel = 'lists:list:lst_sweep'
    // Valid at connect (exp ~1.2s out) but not refreshed; lapses shortly.
    const token = mintChannelToken({ channel, key: KEY, ttlMs: 1200 })
    const sock = await openSocket(channel, token)

    await tick(1300) // let the token expire in real time
    // Trigger the periodic sweep directly rather than waiting 60s.
    await runInDurableObject(stubFor(channel), async (instance: { alarm(): Promise<void> }) => {
      await instance.alarm()
    })
    await tick()

    expect(sock.closeCode).toBe(1008)
  })

  it('reclaims a socket promptly when the client disconnects (webSocketClose)', async () => {
    const channel = 'lists:list:lst_clientclose'
    const sock = await openSocket(channel, mintChannelToken({ channel, key: KEY }))

    await runInDurableObject(
      stubFor(channel),
      async (_i: unknown, state: { getWebSockets(): WebSocket[] }) => {
        expect(state.getWebSockets().filter((w) => w.readyState === 1)).toHaveLength(1)
      },
    )

    sock.ws.close()
    await tick(100)

    // The webSocketClose handler completed the close, so no OPEN socket
    // remains — the disconnect is observed without waiting for the sweep.
    await runInDurableObject(
      stubFor(channel),
      async (_i: unknown, state: { getWebSockets(): WebSocket[] }) => {
        expect(state.getWebSockets().filter((w) => w.readyState === 1)).toHaveLength(0)
      },
    )
  })

  it('alarm does not reschedule the sweep once no open socket remains (#324)', async () => {
    const channel = 'lists:list:lst_noresched'
    const sock = await openSocket(channel, mintChannelToken({ channel, key: KEY }))
    sock.ws.close()
    await tick(100) // webSocketClose reclaims the disconnected socket

    await runInDurableObject(
      stubFor(channel),
      async (
        instance: { alarm(): Promise<void> },
        state: { storage: { getAlarm(): Promise<number | null>; deleteAlarm(): Promise<void> } },
      ) => {
        await state.storage.deleteAlarm() // clear the connect-time alarm
        await instance.alarm() // sweep finds no open socket
        expect(await state.storage.getAlarm()).toBeNull() // no spare reschedule
      },
    )
  })
})

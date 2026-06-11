import { describe, it, expect, vi } from 'vitest'
import { createMoneyClient, MoneyClientError } from './index.js'

// Unit tests for the typed client using a fake fetch. Cover the
// happy path (correct method/path/body/auth) and the error envelope
// (parsed into MoneyClientError).

function makeFakeFetch(handler: (req: Request) => Promise<Response> | Response) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const req = new Request(url, init)
    return handler(req)
  })
}

describe('createMoneyClient', () => {
  it('sends the bearer header and parses listLedgers response', async () => {
    const fakeFetch = makeFakeFetch((req) => {
      expect(req.method).toBe('GET')
      expect(req.url).toBe('https://money.example/api/v1/sdk/money/ledgers?scope_type=group&scope_id=c1')
      expect(req.headers.get('authorization')).toBe('Bearer test-key')
      return new Response(
        JSON.stringify([
          {
            id: 'led_1',
            scopeType: 'group',
            scopeId: 'c1',
            ownerUserId: 'u1',
            name: 'L',
            currency: 'USD',
            description: null,
            createdAt: '2026-05-30T00:00:00.000Z',
            updatedAt: '2026-05-30T00:00:00.000Z',
          },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    const client = createMoneyClient({
      baseUrl: 'https://money.example',
      apiKey: 'test-key',
      fetch: fakeFetch as unknown as typeof fetch,
    })

    const rows = await client.listLedgers({ scopeType: 'group', scopeId: 'c1' })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe('led_1')
  })

  it('ensureGroupLedger POSTs the right body shape', async () => {
    const fakeFetch = makeFakeFetch(async (req) => {
      expect(req.method).toBe('POST')
      expect(req.url).toBe(
        'https://money.example/api/v1/sdk/money/ledgers/ensure-for-group',
      )
      const body = (await req.json()) as Record<string, unknown>
      expect(body).toEqual({
        scopeId: 'grp_abc',
        ownerUserId: 'user_owner',
        name: 'Custom name',
        currency: 'EUR',
      })
      return new Response(
        JSON.stringify({
          id: 'led_new',
          scopeType: 'group',
          scopeId: 'grp_abc',
          ownerUserId: 'user_owner',
          name: 'Custom name',
          currency: 'EUR',
          description: null,
          createdAt: '2026-05-30T00:00:00.000Z',
          updatedAt: '2026-05-30T00:00:00.000Z',
          created: true,
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      )
    })

    const client = createMoneyClient({
      baseUrl: 'https://money.example/',
      apiKey: 'k',
      fetch: fakeFetch as unknown as typeof fetch,
    })
    const result = await client.ensureGroupLedger({
      groupId: 'grp_abc',
      ownerUserId: 'user_owner',
      name: 'Custom name',
      currency: 'EUR',
    })
    expect(result.created).toBe(true)
    expect(result.id).toBe('led_new')
  })

  it('omits undefined optional fields from ensureGroupLedger body', async () => {
    const fakeFetch = makeFakeFetch(async (req) => {
      const body = (await req.json()) as Record<string, unknown>
      // No `name`, `currency`, `description` keys at all.
      expect(Object.keys(body).sort()).toEqual(['ownerUserId', 'scopeId'])
      return new Response(
        JSON.stringify({
          id: 'led_min',
          scopeType: 'group',
          scopeId: 'c2',
          ownerUserId: 'u2',
          name: 'Group expenses',
          currency: 'USD',
          description: null,
          createdAt: 'x',
          updatedAt: 'x',
          created: true,
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      )
    })
    const client = createMoneyClient({
      baseUrl: 'https://money.example',
      apiKey: 'k',
      fetch: fakeFetch as unknown as typeof fetch,
    })
    await client.ensureGroupLedger({ groupId: 'c2', ownerUserId: 'u2' })
  })

  it('throws MoneyClientError carrying the envelope on non-2xx', async () => {
    const fakeFetch = makeFakeFetch(
      () =>
        new Response(
          JSON.stringify({
            error: { code: 'forbidden', message: 'No.', details: { reason: 'r' } },
          }),
          { status: 403, headers: { 'content-type': 'application/json' } },
        ),
    )
    const client = createMoneyClient({
      baseUrl: 'https://money.example',
      apiKey: 'bad',
      fetch: fakeFetch as unknown as typeof fetch,
    })
    await expect(
      client.listLedgers({ scopeType: 'group', scopeId: 'c' }),
    ).rejects.toMatchObject({
      name: 'MoneyClientError',
      status: 403,
      code: 'forbidden',
      message: 'No.',
    })
  })

  it('listExpenses URL-encodes the ledgerId', async () => {
    const fakeFetch = makeFakeFetch((req) => {
      expect(req.url).toBe('https://money.example/api/v1/sdk/money/ledgers/led_a%2Fb/expenses')
      return new Response('[]', { status: 200 })
    })
    const client = createMoneyClient({
      baseUrl: 'https://money.example',
      apiKey: 'k',
      fetch: fakeFetch as unknown as typeof fetch,
    })
    await client.listExpenses('led_a/b')
  })

  it('getBalances passes viewer_user_id as a query param', async () => {
    const fakeFetch = makeFakeFetch((req) => {
      expect(req.url).toBe(
        'https://money.example/api/v1/sdk/money/ledgers/led_x/balances?viewer_user_id=user_v',
      )
      return new Response(
        JSON.stringify({
          ledgerId: 'led_x',
          currency: 'USD',
          viewerUserId: 'user_v',
          items: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    const client = createMoneyClient({
      baseUrl: 'https://money.example',
      apiKey: 'k',
      fetch: fakeFetch as unknown as typeof fetch,
    })
    const bal = await client.getBalances('led_x', 'user_v')
    expect(bal.viewerUserId).toBe('user_v')
  })

  it('exposes a default error code when the envelope is missing', async () => {
    const fakeFetch = makeFakeFetch(() => new Response('', { status: 500 }))
    const client = createMoneyClient({
      baseUrl: 'https://money.example',
      apiKey: 'k',
      fetch: fakeFetch as unknown as typeof fetch,
    })
    try {
      await client.health()
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(MoneyClientError)
      expect((err as MoneyClientError).status).toBe(500)
      expect((err as MoneyClientError).code).toBe('unknown_error')
    }
  })
})

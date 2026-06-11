import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import type { Hono } from 'hono'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { encryptBearer } from '../crypto/encryption.js'
import { MONEY_SESSION_BEARER_PREFIX } from '../middleware/session.js'

// D1 integration tests for the expense-categories surface.
// Replaces expense-categories.it.test.ts.

const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

describe('D1 integration — expense categories + tagging', () => {
  let repos: Repos
  let envVars: Env
  let app: Hono<HonoApp>

  const services: Services = {
    idClient: {
      verifyRpidBearer: async (bearer: string) => ({ ok: true as const, userId: bearer }),
      signoutRpidBearer: async () => {},
    },
    rpidSso: {
      exchange: async () => ({ ok: false as const, reason: 'invalid' as const }),
    },
    settings: {
      get: async () => ({}),
      patch: async (_u, _n, p) => p,
    },
  }

  beforeAll(() => {
    repos = buildD1Repos(createDb(env.DB))
    envVars = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
    app = buildApp({ env: envVars, logger: undefined, repos, services })
  })

  async function loginAs(userId: string): Promise<string> {
    const rawBearer = generateRawToken(MONEY_SESSION_BEARER_PREFIX)
    const idHash = hashToken(rawBearer)
    const sealed = encryptBearer({
      plaintext: userId,
      aad: idHash,
      env: { MONEY_SESSION_KEY_V1: envVars.MONEY_SESSION_KEY_V1 },
      keyVersion: envVars.MONEY_SESSION_KEY_VERSION,
    })
    await repos.sessions.create({
      idHash,
      userId,
      rpidBearerCiphertext: sealed.ciphertext,
      rpidBearerNonce: sealed.nonce,
      rpidBearerKeyVersion: sealed.keyVersion,
      absoluteExpiresAt: new Date(Date.now() + 3_600_000),
      ipHash: '',
      uaHash: '',
    })
    return rawBearer
  }

  function headers(bearer: string): Record<string, string> {
    return {
      cookie: `${envVars.MONEY_SESSION_COOKIE_NAME}=${bearer}; ${envVars.MONEY_CSRF_COOKIE_NAME}=${CSRF}`,
      'x-rp-csrf': CSRF,
      'content-type': 'application/json',
    }
  }

  async function req(
    bearer: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    return app.request(`http://localhost${path}`, {
      method,
      headers: headers(bearer),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  }

  async function createLedger(bearer: string, owner: string): Promise<string> {
    const created = (await (await req(bearer, 'POST', '/api/v1/ui/ledgers', {
      name: 'Category test',
      currency: 'USD',
      scopeType: 'personal',
      scopeId: owner,
    })).json()) as { id: string }
    return created.id
  }

  it('creates a category, lists it back ordered by sort_order, normalises color to lowercase', async () => {
    const owner = `user_${Date.now()}_cat_owner`
    const ownerBearer = await loginAs(owner)
    const ledgerId = await createLedger(ownerBearer, owner)

    await req(ownerBearer, 'POST', `/api/v1/ui/ledgers/${ledgerId}/categories`, {
      name: 'Groceries',
      color: '#1ABC9C',
      sortOrder: 2,
    })
    const second = (await (await req(ownerBearer, 'POST', `/api/v1/ui/ledgers/${ledgerId}/categories`, {
      name: 'Travel',
      color: '#3498db',
      sortOrder: 1,
    })).json()) as { id: string; color: string }
    expect(second.color).toBe('#3498db')

    const list = (await (await req(ownerBearer, 'GET', `/api/v1/ui/ledgers/${ledgerId}/categories`)).json()) as {
      items: Array<{ name: string; color: string; sort_order: number }>
    }
    expect(list.items.map((i) => i.name)).toEqual(['Travel', 'Groceries'])
    // Color was normalised to lowercase by the validator.
    expect(list.items[1]!.color).toBe('#1abc9c')
  })

  it('rejects a duplicate name on the same ledger with category_name_taken', async () => {
    const owner = `user_${Date.now()}_dup_owner`
    const ownerBearer = await loginAs(owner)
    const ledgerId = await createLedger(ownerBearer, owner)

    await req(ownerBearer, 'POST', `/api/v1/ui/ledgers/${ledgerId}/categories`, {
      name: 'Food',
      color: '#ff0000',
    })
    const dup = await req(ownerBearer, 'POST', `/api/v1/ui/ledgers/${ledgerId}/categories`, {
      name: 'Food',
      color: '#00ff00',
    })
    expect(dup.status).toBe(409)
    expect(((await dup.json()) as { error: { code: string } }).error.code).toBe('category_name_taken')
  })

  it('rejects a non-hex color at the validator boundary', async () => {
    const owner = `user_${Date.now()}_color_owner`
    const ownerBearer = await loginAs(owner)
    const ledgerId = await createLedger(ownerBearer, owner)

    const res = await req(ownerBearer, 'POST', `/api/v1/ui/ledgers/${ledgerId}/categories`, {
      name: 'BadColor',
      color: 'tomato',
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('validation_failed')
  })

  it('patches a category and 404s a non-existent one', async () => {
    const owner = `user_${Date.now()}_pat_owner`
    const ownerBearer = await loginAs(owner)
    const ledgerId = await createLedger(ownerBearer, owner)

    const cat = (await (await req(ownerBearer, 'POST', `/api/v1/ui/ledgers/${ledgerId}/categories`, {
      name: 'Coffee',
      color: '#000000',
    })).json()) as { id: string }

    const patch = await req(ownerBearer, 'PATCH', `/api/v1/ui/ledgers/${ledgerId}/categories/${cat.id}`, {
      name: 'Caffeine',
      sortOrder: 5,
    })
    expect(patch.status).toBe(200)
    const updated = (await patch.json()) as { name: string; sort_order: number }
    expect(updated.name).toBe('Caffeine')
    expect(updated.sort_order).toBe(5)

    const missing = await req(ownerBearer, 'PATCH', `/api/v1/ui/ledgers/${ledgerId}/categories/cat_nope`, {
      name: 'Nope',
    })
    expect(missing.status).toBe(404)
  })

  it('attaches a category at create-time and surfaces it in the response + list', async () => {
    const owner = `user_${Date.now()}_attach_owner`
    const ownerBearer = await loginAs(owner)
    const ledgerId = await createLedger(ownerBearer, owner)
    const cat = (await (await req(ownerBearer, 'POST', `/api/v1/ui/ledgers/${ledgerId}/categories`, {
      name: 'Groceries',
      color: '#00cc88',
    })).json()) as { id: string }

    const exp = (await (await req(ownerBearer, 'POST', `/api/v1/ui/ledgers/${ledgerId}/expenses`, {
      paidByUserId: owner,
      totalCents: 100,
      description: 'Apples',
      splitMode: 'equal',
      spentAt: '2026-05-30',
      categoryId: cat.id,
      splits: [{ userId: owner }],
    })).json()) as { id: string; category_id: string }
    expect(exp.category_id).toBe(cat.id)

    const list = (await (await req(ownerBearer, 'GET', `/api/v1/ui/ledgers/${ledgerId}/expenses`)).json()) as {
      items: Array<{ id: string; category_id: string | null }>
    }
    expect(list.items.find((i) => i.id === exp.id)?.category_id).toBe(cat.id)
  })

  it('PATCH expense with categoryId=null explicitly unsets the category', async () => {
    const owner = `user_${Date.now()}_unset_owner`
    const ownerBearer = await loginAs(owner)
    const ledgerId = await createLedger(ownerBearer, owner)
    const cat = (await (await req(ownerBearer, 'POST', `/api/v1/ui/ledgers/${ledgerId}/categories`, {
      name: 'Misc',
      color: '#999999',
    })).json()) as { id: string }
    const exp = (await (await req(ownerBearer, 'POST', `/api/v1/ui/ledgers/${ledgerId}/expenses`, {
      paidByUserId: owner,
      totalCents: 100,
      description: 'Item',
      splitMode: 'equal',
      spentAt: '2026-05-30',
      categoryId: cat.id,
      splits: [{ userId: owner }],
    })).json()) as { id: string; category_id: string }
    expect(exp.category_id).toBe(cat.id)

    const patched = (await (await req(ownerBearer, 'PATCH', `/api/v1/ui/ledgers/${ledgerId}/expenses/${exp.id}`, {
      categoryId: null,
    })).json()) as { category_id: string | null }
    expect(patched.category_id).toBeNull()
  })

  it('rejects a categoryId from a different ledger on create (category_wrong_ledger)', async () => {
    const owner = `user_${Date.now()}_xledger_owner`
    const ownerBearer = await loginAs(owner)
    const ledgerA = await createLedger(ownerBearer, owner)
    const ledgerB = await createLedger(ownerBearer, owner)
    const catB = (await (await req(ownerBearer, 'POST', `/api/v1/ui/ledgers/${ledgerB}/categories`, {
      name: 'Other',
      color: '#abcdef',
    })).json()) as { id: string }

    const res = await req(ownerBearer, 'POST', `/api/v1/ui/ledgers/${ledgerA}/expenses`, {
      paidByUserId: owner,
      totalCents: 100,
      description: 'Wrong ledger',
      splitMode: 'equal',
      spentAt: '2026-05-30',
      categoryId: catB.id,
      splits: [{ userId: owner }],
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('category_wrong_ledger')
  })

  it('deleting a category nulls out the category_id on its expenses (set-null FK)', async () => {
    const owner = `user_${Date.now()}_setnull_owner`
    const ownerBearer = await loginAs(owner)
    const ledgerId = await createLedger(ownerBearer, owner)
    const cat = (await (await req(ownerBearer, 'POST', `/api/v1/ui/ledgers/${ledgerId}/categories`, {
      name: 'Soon-gone',
      color: '#ff00ff',
    })).json()) as { id: string }
    const exp = (await (await req(ownerBearer, 'POST', `/api/v1/ui/ledgers/${ledgerId}/expenses`, {
      paidByUserId: owner,
      totalCents: 100,
      description: 'Tag me',
      splitMode: 'equal',
      spentAt: '2026-05-30',
      categoryId: cat.id,
      splits: [{ userId: owner }],
    })).json()) as { id: string }

    const del = await req(ownerBearer, 'DELETE', `/api/v1/ui/ledgers/${ledgerId}/categories/${cat.id}`)
    expect(del.status).toBe(204)

    const after = (await (await req(ownerBearer, 'GET', `/api/v1/ui/ledgers/${ledgerId}/expenses/${exp.id}`)).json()) as { category_id: string | null }
    expect(after.category_id).toBeNull()

    // Activity captures the delete.
    const activity = (await (await req(ownerBearer, 'GET', `/api/v1/ui/ledgers/${ledgerId}/activity`)).json()) as {
      items: Array<{ event_type: string }>
    }
    expect(activity.items.some((a) => a.event_type === 'category.deleted')).toBe(true)
  })

  it('rejects a non-member trying to CRUD categories (404)', async () => {
    const owner = `user_${Date.now()}_acl_owner`
    const ownerBearer = await loginAs(owner)
    const ledgerId = await createLedger(ownerBearer, owner)

    const stranger = `user_${Date.now()}_acl_stranger`
    const strangerBearer = await loginAs(stranger)
    const list = await req(strangerBearer, 'GET', `/api/v1/ui/ledgers/${ledgerId}/categories`)
    expect(list.status).toBe(404)
    const post = await req(strangerBearer, 'POST', `/api/v1/ui/ledgers/${ledgerId}/categories`, {
      name: 'Sneaky',
      color: '#222222',
    })
    expect(post.status).toBe(404)
  })
})

import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import type { R2Bucket } from '@cloudflare/workers-types'
import type { Hono } from 'hono'
import { createBindingObjectStore } from '@rallypoint/object-store'
import { RECEIPT_MAX_BYTES } from '@rallypoint/money-shared'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { encryptBearer } from '../crypto/encryption.js'
import { MONEY_SESSION_BEARER_PREFIX } from '../middleware/session.js'

// D1 + real Miniflare R2 binding integration tests for the receipt upload
// flow (#409). No store mocking — bytes actually land in R2 and stream
// back out, same as production.

const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'
const bucket = env.OBJECT_STORE as unknown as R2Bucket

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0])
const WEBP_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50])

describe('D1 integration — expense receipts', () => {
  let repos: Repos
  let envVars: Env
  let app: Hono<HonoApp>

  const baseServices: Omit<Services, 'objectStore'> = {
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
    const services: Services = {
      ...baseServices,
      objectStore: createBindingObjectStore(bucket),
    }
    app = buildApp({ env: envVars, logger: undefined, repos, services })
  })

  // Clear R2 objects between tests so state doesn't leak across cases.
  beforeEach(async () => {
    const listed = await bucket.list()
    await Promise.all(listed.objects.map((o) => bucket.delete(o.key)))
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

  function headers(bearer: string, contentType = 'application/json'): Record<string, string> {
    return {
      cookie: `${envVars.MONEY_SESSION_COOKIE_NAME}=${bearer}; ${envVars.MONEY_CSRF_COOKIE_NAME}=${CSRF}`,
      'x-rp-csrf': CSRF,
      'content-type': contentType,
    }
  }

  async function jsonReq(
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

  async function uploadReq(
    bearer: string,
    path: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<Response> {
    return app.request(`http://localhost${path}`, {
      method: 'POST',
      headers: headers(bearer, contentType),
      body: bytes,
    })
  }

  async function setupExpense(owner: string, bearer: string): Promise<{ ledgerId: string; expenseId: string }> {
    const ledger = (await (await jsonReq(bearer, 'POST', '/api/v1/ui/ledgers', {
      name: 'Receipts',
      currency: 'USD',
      scopeType: 'personal',
      scopeId: owner,
    })).json()) as { id: string }
    const expense = (await (await jsonReq(bearer, 'POST', `/api/v1/ui/ledgers/${ledger.id}/expenses`, {
      paidByUserId: owner,
      totalCents: 100,
      description: 'Dinner',
      splitMode: 'equal',
      spentAt: '2026-05-30',
      splits: [{ userId: owner }],
    })).json()) as { id: string }
    return { ledgerId: ledger.id, expenseId: expense.id }
  }

  it('upload happy path: bytes land in R2 and metadata is written', async () => {
    const owner = `user_${Date.now()}_upload_ok`
    const bearer = await loginAs(owner)
    const { ledgerId, expenseId } = await setupExpense(owner, bearer)

    const res = await uploadReq(
      bearer,
      `/api/v1/ui/ledgers/${ledgerId}/expenses/${expenseId}/receipt`,
      PNG_BYTES,
      'image/png',
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { expense_id: string; object_key: string; content_type: string; bytes: number }
    expect(body.expense_id).toBe(expenseId)
    expect(body.object_key).toBe(`expense-receipts/${ledgerId}/${expenseId}.png`)
    expect(body.content_type).toBe('image/png')
    expect(body.bytes).toBe(PNG_BYTES.byteLength)

    // Bytes actually landed in R2.
    const stored = await bucket.get(`expense-receipts/${ledgerId}/${expenseId}.png`)
    expect(stored).not.toBeNull()

    // The expense detail carries the receipt fields.
    const detail = (await (await jsonReq(bearer, 'GET', `/api/v1/ui/ledgers/${ledgerId}/expenses/${expenseId}`)).json()) as {
      receipt_object_key: string
      receipt_content_type: string
      receipt_bytes: number
    }
    expect(detail.receipt_object_key).toBe(body.object_key)
    expect(detail.receipt_content_type).toBe('image/png')
    expect(detail.receipt_bytes).toBe(PNG_BYTES.byteLength)
  })

  it('serve: bytes stream back with correct content-type', async () => {
    const owner = `user_${Date.now()}_serve`
    const bearer = await loginAs(owner)
    const { ledgerId, expenseId } = await setupExpense(owner, bearer)

    await uploadReq(
      bearer,
      `/api/v1/ui/ledgers/${ledgerId}/expenses/${expenseId}/receipt`,
      JPEG_BYTES,
      'image/jpeg',
    )

    const get = await jsonReq(bearer, 'GET', `/api/v1/ui/ledgers/${ledgerId}/expenses/${expenseId}/receipt`)
    expect(get.status).toBe(200)
    expect(get.headers.get('content-type')).toBe('image/jpeg')
    const got = new Uint8Array(await get.arrayBuffer())
    expect(got).toEqual(JPEG_BYTES)
  })

  it('overwrite: replaces old object and row atomically', async () => {
    const owner = `user_${Date.now()}_overwrite`
    const bearer = await loginAs(owner)
    const { ledgerId, expenseId } = await setupExpense(owner, bearer)

    // First upload (png).
    await uploadReq(bearer, `/api/v1/ui/ledgers/${ledgerId}/expenses/${expenseId}/receipt`, PNG_BYTES, 'image/png')
    const pngKey = `expense-receipts/${ledgerId}/${expenseId}.png`

    // Second upload (webp). The png key should be reaped.
    const res = await uploadReq(bearer, `/api/v1/ui/ledgers/${ledgerId}/expenses/${expenseId}/receipt`, WEBP_BYTES, 'image/webp')
    expect(res.status).toBe(200)
    const webpKey = `expense-receipts/${ledgerId}/${expenseId}.webp`
    expect(await bucket.get(pngKey)).toBeNull()
    expect(await bucket.get(webpKey)).not.toBeNull()
  })

  it('rejects unsupported content-type (400)', async () => {
    const owner = `user_${Date.now()}_bad_ct`
    const bearer = await loginAs(owner)
    const { ledgerId, expenseId } = await setupExpense(owner, bearer)

    const res = await uploadReq(
      bearer,
      `/api/v1/ui/ledgers/${ledgerId}/expenses/${expenseId}/receipt`,
      PNG_BYTES,
      'application/pdf',
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('unsupported_receipt_type')
    // Nothing was stored.
    const listed = await bucket.list()
    expect(listed.objects.length).toBe(0)
  })

  it('rejects oversize body (400)', async () => {
    const owner = `user_${Date.now()}_oversize`
    const bearer = await loginAs(owner)
    const { ledgerId, expenseId } = await setupExpense(owner, bearer)

    const res = await uploadReq(
      bearer,
      `/api/v1/ui/ledgers/${ledgerId}/expenses/${expenseId}/receipt`,
      new Uint8Array(RECEIPT_MAX_BYTES + 1),
      'image/png',
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('receipt_too_large')
  })

  it('serve 404s before any receipt is uploaded', async () => {
    const owner = `user_${Date.now()}_get_404`
    const bearer = await loginAs(owner)
    const { ledgerId, expenseId } = await setupExpense(owner, bearer)

    const get = await jsonReq(bearer, 'GET', `/api/v1/ui/ledgers/${ledgerId}/expenses/${expenseId}/receipt`)
    expect(get.status).toBe(404)
  })

  it('DELETE drops the columns, deletes the R2 object, and records activity', async () => {
    const owner = `user_${Date.now()}_del`
    const bearer = await loginAs(owner)
    const { ledgerId, expenseId } = await setupExpense(owner, bearer)

    await uploadReq(bearer, `/api/v1/ui/ledgers/${ledgerId}/expenses/${expenseId}/receipt`, PNG_BYTES, 'image/png')
    const objectKey = `expense-receipts/${ledgerId}/${expenseId}.png`

    const del = await jsonReq(bearer, 'DELETE', `/api/v1/ui/ledgers/${ledgerId}/expenses/${expenseId}/receipt`)
    expect(del.status).toBe(204)
    expect(await bucket.get(objectKey)).toBeNull()

    // Subsequent GET 404s.
    const get = await jsonReq(bearer, 'GET', `/api/v1/ui/ledgers/${ledgerId}/expenses/${expenseId}/receipt`)
    expect(get.status).toBe(404)

    const activity = (await (await jsonReq(bearer, 'GET', `/api/v1/ui/ledgers/${ledgerId}/activity`)).json()) as { items: Array<{ event_type: string }> }
    expect(activity.items.some((a) => a.event_type === 'expense.receipt_uploaded')).toBe(true)
    expect(activity.items.some((a) => a.event_type === 'expense.receipt_deleted')).toBe(true)
  })

  it('non-member cannot upload (404)', async () => {
    const owner = `user_${Date.now()}_acl_owner`
    const ownerBearer = await loginAs(owner)
    const { ledgerId, expenseId } = await setupExpense(owner, ownerBearer)

    const stranger = `user_${Date.now()}_acl_stranger`
    const strangerBearer = await loginAs(stranger)
    const res = await uploadReq(
      strangerBearer,
      `/api/v1/ui/ledgers/${ledgerId}/expenses/${expenseId}/receipt`,
      PNG_BYTES,
      'image/png',
    )
    expect(res.status).toBe(404)
  })

  // --- Magic-byte (file signature) gate ------------------------------------

  it('rejects HTML bytes declared as image/png — polyglot attack (400)', async () => {
    const owner = `user_${Date.now()}_magic_png`
    const bearer = await loginAs(owner)
    const { ledgerId, expenseId } = await setupExpense(owner, bearer)

    const htmlBytes = new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e]) // <html>
    const res = await uploadReq(
      bearer,
      `/api/v1/ui/ledgers/${ledgerId}/expenses/${expenseId}/receipt`,
      htmlBytes,
      'image/png',
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('unsupported_receipt_type')
    // Nothing should have landed in R2.
    const listed = await bucket.list()
    expect(listed.objects.length).toBe(0)
  })

  it('rejects HTML bytes declared as image/jpeg (400)', async () => {
    const owner = `user_${Date.now()}_magic_jpeg`
    const bearer = await loginAs(owner)
    const { ledgerId, expenseId } = await setupExpense(owner, bearer)

    const htmlBytes = new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e]) // <html>
    const res = await uploadReq(
      bearer,
      `/api/v1/ui/ledgers/${ledgerId}/expenses/${expenseId}/receipt`,
      htmlBytes,
      'image/jpeg',
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('unsupported_receipt_type')
  })

  it('accepts valid PNG magic bytes declared as image/png (control)', async () => {
    const owner = `user_${Date.now()}_magic_ok_png`
    const bearer = await loginAs(owner)
    const { ledgerId, expenseId } = await setupExpense(owner, bearer)

    const res = await uploadReq(
      bearer,
      `/api/v1/ui/ledgers/${ledgerId}/expenses/${expenseId}/receipt`,
      PNG_BYTES,
      'image/png',
    )
    expect(res.status).toBe(200)
  })
})

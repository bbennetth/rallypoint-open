import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { env as testEnv } from 'cloudflare:test'
import type { Hono } from 'hono'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { encryptBearer } from '../crypto/encryption.js'
import { PLANNER_SESSION_BEARER_PREFIX } from '../middleware/session.js'

// Integration tests for the AI Assist BFF. A real planner session lives in a
// Miniflare D1; the Workers AI binding + ai-api trace RPC are injected as fakes
// via the request-env arg (c.env). The point is to exercise the route's
// behaviour — auth gating, request validation, model-output parsing → 422,
// per-category coercion, and feedback forwarding — without a live model.

const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

// A mutable fake Workers AI binding: each test sets what the "model" returns.
// `fail` throws a hard (non-capacity) error → no retry. `failCapacityTimes`
// throws a transient 429 that many times before succeeding → exercises the
// bounded capacity retry in runAssist.
interface FakeAi {
  run: (model: string, input: Record<string, unknown>, options?: unknown) => Promise<unknown>
  calls: { model: string; input: Record<string, unknown> }[]
  next: unknown
  fail: boolean
  failCapacityTimes: number
}
function makeFakeAi(): FakeAi {
  const fake: FakeAi = {
    calls: [],
    next: null,
    fail: false,
    failCapacityTimes: 0,
    run: async (model, input) => {
      fake.calls.push({ model, input })
      if (fake.failCapacityTimes > 0) {
        fake.failCapacityTimes -= 1
        throw Object.assign(new Error('Capacity temporarily exceeded'), { code: 3040 })
      }
      if (fake.fail) throw new Error('boom')
      return { response: fake.next }
    },
  }
  return fake
}

// A fake ai-api trace RPC that records feedback calls.
interface FakeTraces {
  recordTrace: (...args: unknown[]) => Promise<void>
  recordFeedback: (fb: unknown) => Promise<{ ok: boolean }>
  feedback: unknown[]
}
function makeFakeTraces(): FakeTraces {
  const fake: FakeTraces = {
    feedback: [],
    recordTrace: async () => {},
    recordFeedback: async (fb) => {
      fake.feedback.push(fb)
      return { ok: true }
    },
  }
  return fake
}

// A fake fitness client: the food-log write proxy forwards to it. Records
// calls so tests assert the actor + entry pass through; `fail` makes both
// methods throw (→ the proxy route 503s).
interface FakeFitnessClient {
  createCalls: { actor: string; entry: unknown }[]
  deleteCalls: { actor: string; id: string }[]
  fail: boolean
  deleteResult: boolean
  createFoodLogEntry: (opts: { actor: string; entry: unknown }) => Promise<unknown>
  deleteFoodLogEntry: (opts: { actor: string; id: string }) => Promise<boolean>
}
function makeFakeFitness(): FakeFitnessClient {
  const fake: FakeFitnessClient = {
    createCalls: [],
    deleteCalls: [],
    fail: false,
    deleteResult: true,
    createFoodLogEntry: async (opts) => {
      fake.createCalls.push(opts)
      if (fake.fail) throw new Error('fitness down')
      return { id: 'fl_test', name: (opts.entry as { name: string }).name, kcal: 25 }
    },
    deleteFoodLogEntry: async (opts) => {
      fake.deleteCalls.push(opts)
      if (fake.fail) throw new Error('fitness down')
      return fake.deleteResult
    },
  }
  return fake
}

// Minimal services — the assist route reads settings.get (opt-out), the
// food-log proxy uses fitnessClient, and session middleware needs idClient.
// Test files are excluded from tsc, so a partial shape is fine at runtime.
function baseServices(fitness?: FakeFitnessClient): Services {
  return {
    idClient: {
      verifyRpidBearer: async (bearer: string) => ({ ok: true as const, userId: bearer }),
      signoutRpidBearer: async () => {},
    },
    settings: {
      get: async () => ({}),
      patch: async () => ({}),
    },
    ...(fitness ? { fitnessClient: fitness } : {}),
  } as unknown as Services
}

describe('D1 integration — AI Assist BFF', () => {
  let repos: Repos
  let env: Env
  let app: Hono<HonoApp>
  let ai: FakeAi
  let traces: FakeTraces

  beforeAll(() => {
    repos = buildD1Repos(createDb(testEnv.DB))
    env = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
  })

  beforeEach(() => {
    ai = makeFakeAi()
    traces = makeFakeTraces()
    app = buildApp({ env, logger: undefined, repos, services: baseServices() })
  })

  async function loginAs(userId: string): Promise<string> {
    const rawBearer = generateRawToken(PLANNER_SESSION_BEARER_PREFIX)
    const idHash = hashToken(rawBearer)
    const sealed = encryptBearer({
      plaintext: userId,
      aad: idHash,
      env: { PLANNER_SESSION_KEY_V1: env.PLANNER_SESSION_KEY_V1 },
      keyVersion: env.PLANNER_SESSION_KEY_VERSION,
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

  function headers(bearer: string, extra?: Record<string, string>): Record<string, string> {
    return {
      cookie: `${env.PLANNER_SESSION_COOKIE_NAME}=${bearer}; ${env.PLANNER_CSRF_COOKIE_NAME}=${CSRF}`,
      'x-rp-csrf': CSRF,
      origin: env.PLANNER_UI_ORIGIN,
      ...extra,
    }
  }

  const bindings = () => ({ AI: ai, AI_TRACES: traces })

  function parseReq(bearer: string, body: unknown) {
    return app.request(
      'http://localhost/api/v1/ui/assist/parse',
      {
        method: 'POST',
        headers: headers(bearer, { 'content-type': 'application/json' }),
        body: JSON.stringify(body),
      },
      bindings(),
    )
  }

  const goodBody = { text: 'Buy strawberries', clientNow: '2026-07-20T14:03:00Z', tz: 'UTC' }

  it('requires a session', async () => {
    // Valid origin + CSRF (so those guards pass) but no session cookie.
    const res = await app.request(
      'http://localhost/api/v1/ui/assist/parse',
      {
        method: 'POST',
        headers: {
          cookie: `${env.PLANNER_CSRF_COOKIE_NAME}=${CSRF}`,
          'x-rp-csrf': CSRF,
          origin: env.PLANNER_UI_ORIGIN,
          'content-type': 'application/json',
        },
        body: JSON.stringify(goodBody),
      },
      bindings(),
    )
    expect(res.status).toBe(401)
  })

  it('503s when no AI binding is present', async () => {
    const bearer = await loginAs('user_no_ai')
    const res = await app.request(
      'http://localhost/api/v1/ui/assist/parse',
      {
        method: 'POST',
        headers: headers(bearer, { 'content-type': 'application/json' }),
        body: JSON.stringify(goodBody),
      },
      { AI_TRACES: traces }, // no AI
    )
    expect(res.status).toBe(503)
  })

  it('rate-limits parse per user (429 + Retry-After) before calling the model', async () => {
    const bearer = await loginAs('user_assist_rl')
    // Stub repos.rateLimit to deny rather than loop 15 real requests; assert
    // the exact per-user bucket key and that the model is never reached.
    const seen: string[] = []
    const stubbedRateLimit = {
      async takeToken(input: { bucketKey: string }) {
        seen.push(input.bucketKey)
        return { allowed: false, retryAfterSeconds: 25, blendedCount: 16 }
      },
      async reset() {},
      async pruneOldBuckets() {
        return 0
      },
    }
    const hybridApp = buildApp({
      env,
      logger: undefined,
      repos: { ...repos, rateLimit: stubbedRateLimit } as unknown as Repos,
      services: baseServices(),
    })
    const res = await hybridApp.request(
      'http://localhost/api/v1/ui/assist/parse',
      {
        method: 'POST',
        headers: headers(bearer, { 'content-type': 'application/json' }),
        body: JSON.stringify(goodBody),
      },
      bindings(),
    )
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('25')
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('rate_limited')
    expect(seen).toEqual(['user:user_assist_rl:ai-assist'])
    // The Workers AI binding is present but must not be called once denied.
    expect(ai.calls.length).toBe(0)
  })

  it('400s on a malformed request body', async () => {
    const bearer = await loginAs('user_bad')
    ai.next = JSON.stringify({ category: 'shopping', title: 'x', confidence: 'high' })
    const res = await parseReq(bearer, { text: '', clientNow: 'nope', tz: '' })
    expect(res.status).toBe(400)
    // The model must not be called on invalid input.
    expect(ai.calls.length).toBe(0)
  })

  it('parses a shopping capture', async () => {
    const bearer = await loginAs('user_s')
    ai.next = JSON.stringify({ category: 'shopping', title: 'Strawberries', confidence: 'high' })
    const res = await parseReq(bearer, goodBody)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.category).toBe('shopping')
    expect(body.title).toBe('Strawberries')
    expect(body.responseId).toBeTruthy()
    expect(body.traceId).toBeTruthy()
    expect(ai.calls[0]?.model).toContain('mistral')
  })

  it('parses an event capture into a real instant', async () => {
    const bearer = await loginAs('user_e')
    ai.next = JSON.stringify({
      category: 'event',
      title: 'Dental cleaning',
      date: '2027-03-05',
      time: '09:00',
      confidence: 'high',
    })
    const res = await parseReq(bearer, {
      text: 'Dental cleaning 3/5/2027 at 9am',
      clientNow: '2026-07-20T14:03:00Z',
      tz: 'America/Chicago',
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.category).toBe('event')
    expect(body.allDay).toBe(false)
    expect(body.startAt).toBe('2027-03-05T15:00:00.000Z') // CST, UTC-6
  })

  it('parses a diary capture with mood', async () => {
    const bearer = await loginAs('user_d')
    ai.next = JSON.stringify({
      category: 'diary',
      title: 'Rough day',
      notes: 'work stress',
      mood: 2,
      confidence: 'high',
    })
    const res = await parseReq(bearer, {
      text: "I'm really upset right now because of work",
      clientNow: '2026-07-20T14:03:00Z',
      tz: 'UTC',
    })
    const body = (await res.json()) as Record<string, unknown>
    expect(body.category).toBe('diary')
    expect(body.mood).toBe(2)
  })

  it('parses a food capture into items (single call — nutrition inline)', async () => {
    const bearer = await loginAs('user_food')
    ai.next = JSON.stringify({
      category: 'food',
      title: '5 cherries',
      items: [
        { name: 'Cherries', grams: 40, kcal: 25, proteinG: 0.4, carbsG: 6, fatG: 0.1 },
      ],
      confidence: 'high',
    })
    const res = await parseReq(bearer, {
      text: 'I ate 5 cherries',
      clientNow: '2026-07-20T14:03:00Z',
      tz: 'UTC',
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.category).toBe('food')
    expect(body.items).toEqual([
      { name: 'Cherries', grams: 40, kcal: 25, proteinG: 0.4, carbsG: 6, fatG: 0.1 },
    ])
    // The food category resolves nutrition in the SAME model call — no
    // second AI hop.
    expect(ai.calls.length).toBe(1)
  })

  it('degrades a food capture with no loggable items to a low-confidence note', async () => {
    const bearer = await loginAs('user_food_empty')
    ai.next = JSON.stringify({ category: 'food', title: 'something', items: [], confidence: 'high' })
    const res = await parseReq(bearer, goodBody)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.category).toBe('note')
    expect(body.confidence).toBe('low')
  })

  it('uses the ASSIST_MODEL override when set', async () => {
    const bearer = await loginAs('user_model_override')
    const overrideEnv = parseEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      ASSIST_MODEL: '@cf/mistral/mistral-7b-instruct-v0.2',
    })
    const overrideApp = buildApp({
      env: overrideEnv,
      logger: undefined,
      repos,
      services: baseServices(),
    })
    ai.next = JSON.stringify({ category: 'shopping', title: 'Milk', confidence: 'high' })
    const res = await overrideApp.request(
      'http://localhost/api/v1/ui/assist/parse',
      {
        method: 'POST',
        headers: headers(bearer, { 'content-type': 'application/json' }),
        body: JSON.stringify(goodBody),
      },
      bindings(),
    )
    expect(res.status).toBe(200)
    expect(ai.calls[0]?.model).toBe('@cf/mistral/mistral-7b-instruct-v0.2')
  })

  it('422s when the model returns unusable output', async () => {
    const bearer = await loginAs('user_g')
    ai.next = 'I could not understand that.'
    const res = await parseReq(bearer, goodBody)
    expect(res.status).toBe(422)
  })

  it('503s when the model call throws a hard error (no retry)', async () => {
    const bearer = await loginAs('user_f')
    ai.fail = true
    const res = await parseReq(bearer, goodBody)
    expect(res.status).toBe(503)
    expect(ai.calls.length).toBe(1) // non-capacity error is not retried
  })

  it('retries a transient capacity error, then succeeds', async () => {
    const bearer = await loginAs('user_r')
    ai.failCapacityTimes = 2
    ai.next = JSON.stringify({ category: 'shopping', title: 'Milk', confidence: 'high' })
    const res = await parseReq(bearer, goodBody)
    expect(res.status).toBe(200)
    expect(ai.calls.length).toBe(3) // 2 failures + 1 success
  })

  it('forwards feedback to the trace RPC', async () => {
    const bearer = await loginAs('user_fb')
    const res = await app.request(
      'http://localhost/api/v1/ui/assist/feedback',
      {
        method: 'POST',
        headers: headers(bearer, { 'content-type': 'application/json' }),
        body: JSON.stringify({ responseId: 'resp_123', verdict: 'edited', edited: { title: 'Fixed' } }),
      },
      bindings(),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(traces.feedback).toEqual([
      { responseId: 'resp_123', userId: 'user_fb', action: 'edited', finalValue: { title: 'Fixed' } },
    ])
  })

  it('feedback is a no-op (ok:false) when trace RPC is unconfigured', async () => {
    const bearer = await loginAs('user_fb2')
    const res = await app.request(
      'http://localhost/api/v1/ui/assist/feedback',
      {
        method: 'POST',
        headers: headers(bearer, { 'content-type': 'application/json' }),
        body: JSON.stringify({ responseId: 'resp_9', verdict: 'accepted' }),
      },
      { AI: ai }, // no AI_TRACES
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: false })
  })

  // --- fitness food-log write proxy (the food save/undo) ---------------
  describe('POST/DELETE /api/v1/ui/fitness/food-log', () => {
    let fitness: FakeFitnessClient
    let foodApp: Hono<HonoApp>

    beforeEach(() => {
      fitness = makeFakeFitness()
      foodApp = buildApp({ env, logger: undefined, repos, services: baseServices(fitness) })
    })

    const goodEntry = {
      loggedAt: '2026-07-20T18:00:00.000Z',
      name: 'Cherries',
      quantityGrams: 40,
      kcal: 25,
      proteinG: 0.4,
      carbsG: 6,
      fatG: 0.1,
      source: 'text',
      scanResponseId: 'resp_1',
    }

    function foodReq(bearer: string, method: string, path: string, body?: unknown) {
      return foodApp.request(
        `http://localhost${path}`,
        {
          method,
          headers: headers(bearer, { 'content-type': 'application/json' }),
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        },
        bindings(),
      )
    }

    it('forwards a valid entry to the fitness client with the session actor', async () => {
      const bearer = await loginAs('user_flog')
      const res = await foodReq(bearer, 'POST', '/api/v1/ui/fitness/food-log', goodEntry)
      expect(res.status).toBe(201)
      expect(fitness.createCalls.length).toBe(1)
      expect(fitness.createCalls[0]?.actor).toBe('user_flog')
      expect((fitness.createCalls[0]?.entry as { name: string }).name).toBe('Cherries')
    })

    it('requires a session (401)', async () => {
      const res = await foodApp.request(
        'http://localhost/api/v1/ui/fitness/food-log',
        {
          method: 'POST',
          headers: {
            cookie: `${env.PLANNER_CSRF_COOKIE_NAME}=${CSRF}`,
            'x-rp-csrf': CSRF,
            origin: env.PLANNER_UI_ORIGIN,
            'content-type': 'application/json',
          },
          body: JSON.stringify(goodEntry),
        },
        bindings(),
      )
      expect(res.status).toBe(401)
    })

    it('400s on a malformed entry', async () => {
      const bearer = await loginAs('user_flog_bad')
      const res = await foodReq(bearer, 'POST', '/api/v1/ui/fitness/food-log', {
        ...goodEntry,
        name: '',
      })
      expect(res.status).toBe(400)
      expect(fitness.createCalls.length).toBe(0)
    })

    it('rejects cache-contribution fields (403-worthy shapes → 400)', async () => {
      const bearer = await loginAs('user_flog_forbidden')
      const res = await foodReq(bearer, 'POST', '/api/v1/ui/fitness/food-log', {
        ...goodEntry,
        source: 'manual',
        saveAsCustom: true,
      })
      expect(res.status).toBe(400)
      expect(fitness.createCalls.length).toBe(0)
    })

    it('503s when the fitness client throws (outage)', async () => {
      const bearer = await loginAs('user_flog_down')
      fitness.fail = true
      const res = await foodReq(bearer, 'POST', '/api/v1/ui/fitness/food-log', goodEntry)
      expect(res.status).toBe(503)
    })

    it('deletes an entry (undo) and 404s an unknown id', async () => {
      const bearer = await loginAs('user_flog_del')
      const ok = await foodReq(bearer, 'DELETE', '/api/v1/ui/fitness/food-log/fl_abc')
      expect(ok.status).toBe(204)
      expect(fitness.deleteCalls[0]).toEqual({ actor: 'user_flog_del', id: 'fl_abc' })

      fitness.deleteResult = false
      const missing = await foodReq(bearer, 'DELETE', '/api/v1/ui/fitness/food-log/fl_missing')
      expect(missing.status).toBe(404)
    })
  })
})

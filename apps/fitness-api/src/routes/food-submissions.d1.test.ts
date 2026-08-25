import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll, vi } from 'vitest'
import type { Hono } from 'hono'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import type { FoodLogEntryDto } from '@rallypoint/fitness-shared'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb, type Db } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'
import { encryptBearer } from '../crypto/encryption.js'
import { FITNESS_SESSION_BEARER_PREFIX } from '../middleware/session.js'
import {
  approveFoodSubmission,
  rejectFoodSubmission,
} from '../services/food-submission-review.js'

// Food submissions — the admin review queue for AI nutrition-label UPC
// contributions (see routes/food.ts saveAsUpc). Covers the full
// lifecycle: private-row-only logging while a submission is pending
// (own + a second user hitting "already pending"), admin approve
// (creating or linking a global row + offering migration), reject with
// a note, the user-facing list + migrate accept/decline, and the
// re-migrate-after-resolution 409.

const CSRF = 'csrf_token_value_food_submissions_aaaaaaaaaaaaaaaaaa'

const services: Services = {
  idClient: {
    verifyRpidBearer: async (bearer: string) => ({ ok: true as const, userId: bearer }),
    signoutRpidBearer: async () => {},
  },
  rpidSso: { exchange: async () => ({ ok: false as const, reason: 'invalid' as const }) },
  profiles: { lookup: async () => null },
  settings: { get: async () => ({}), patch: async (_u, _n, p) => p },
  offClient: { lookup: vi.fn().mockResolvedValue(null), search: vi.fn().mockResolvedValue([]) },
  foodVision: {
    analyzeFoodImage: vi.fn(),
    analyzeDrinkImage: vi.fn(),
    analyzeNutritionLabel: vi.fn(),
  },
}

const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

describe('D1 integration — food submissions review queue', () => {
  let repos: Repos
  let envVars: Env
  let app: Hono<HonoApp>
  let _db: Db

  beforeAll(() => {
    _db = createDb(env.DB)
    repos = buildD1Repos(_db)
    envVars = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
    app = buildApp({ env: envVars, logger: undefined, repos, services })
  })

  async function loginAs(userId: string): Promise<string> {
    const rawBearer = generateRawToken(FITNESS_SESSION_BEARER_PREFIX)
    const idHash = hashToken(rawBearer)
    const sealed = encryptBearer({
      plaintext: userId,
      aad: idHash,
      env: { FITNESS_SESSION_KEY_V1: envVars.FITNESS_SESSION_KEY_V1 },
      keyVersion: envVars.FITNESS_SESSION_KEY_VERSION,
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
      cookie: `${envVars.FITNESS_SESSION_COOKIE_NAME}=${bearer}; ${envVars.FITNESS_CSRF_COOKIE_NAME}=${CSRF}`,
      'x-rp-csrf': CSRF,
      'content-type': 'application/json',
      origin: envVars.FITNESS_UI_ORIGIN,
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
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  let counter = 0
  function nextId(): string {
    counter += 1
    return `${Date.now()}_${counter}`
  }

  // Drives a real /food/label + saveAsUpc /food/log write for `userId`
  // and `upc`, returning the logged diary DTO. Mirrors the flow the
  // fitness-web confirm sheet drives.
  async function scanAndLog(
    bearer: string,
    userId: string,
    upc: string,
    opts?: { name?: string },
  ): Promise<FoodLogEntryDto & { contributionStatus?: string }> {
    const label = {
      name: opts?.name ?? 'Granola Bar',
      brand: 'Store',
      servingGrams: 50,
      servingUnit: 'g' as const,
      perServing: { kcal: 200, proteinG: 20, carbsG: 20, fatG: 10 },
    }
    ;(services.foodVision!.analyzeNutritionLabel as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      label,
    )
    const scan = await req(bearer, 'POST', '/api/v1/ui/food/label', {
      upc,
      imageBase64: TINY_PNG_B64,
      mimeType: 'image/png',
    })
    const { item, contributionToken } = (await scan.json()) as {
      item: { name: string; brand: string | null; servingGrams: number; servingUnit: string; isLiquid: boolean }
      contributionToken: string
    }
    const logged = await req(bearer, 'POST', '/api/v1/ui/food/log', {
      loggedAt: '2026-07-15T12:00:00.000Z',
      name: item.name,
      quantityGrams: 50,
      kcal: 200,
      proteinG: 20,
      carbsG: 20,
      fatG: 10,
      source: 'barcode',
      saveAsUpc: {
        upc,
        token: contributionToken,
        brand: item.brand,
        servingGrams: item.servingGrams,
        servingUnit: item.servingUnit,
        isLiquid: item.isLiquid,
      },
    })
    expect(logged.status).toBe(201)
    return (await logged.json()) as FoodLogEntryDto & { contributionStatus?: string }
  }

  it('logging an unknown-upc contribution creates a private row + pending submission, no global row', async () => {
    const upc = '900000000001'
    const bearer = await loginAs('user_fs_first')
    const logged = await scanAndLog(bearer, 'user_fs_first', upc)

    expect(logged.contributionStatus).toBe('submitted')
    expect(logged.foodItemId).toMatch(/^ff_/)

    const privateItem = await repos.foodItems.getForActor('user_fs_first', logged.foodItemId!)
    expect(privateItem).not.toBeNull()
    expect(privateItem!.upc).toBeNull()
    expect(privateItem!.ownerUserId).toBe('user_fs_first')

    expect(await repos.foodItems.getByUpc(upc)).toBeNull()

    const submission = await repos.foodSubmissions.getPendingByUpc(upc)
    expect(submission).not.toBeNull()
    expect(submission!.privateFoodItemId).toBe(logged.foodItemId)
    expect(submission!.status).toBe('pending')
  })

  it('a second user contributing the same pending upc gets a private row only, no second submission', async () => {
    const upc = '900000000002'
    const first = await loginAs('user_fs_dup_a')
    await scanAndLog(first, 'user_fs_dup_a', upc)

    const second = await loginAs('user_fs_dup_b')
    const logged = await scanAndLog(second, 'user_fs_dup_b', upc)

    expect(logged.contributionStatus).toBe('already_pending')
    const secondPrivate = await repos.foodItems.getForActor('user_fs_dup_b', logged.foodItemId!)
    expect(secondPrivate).not.toBeNull()
    expect(secondPrivate!.ownerUserId).toBe('user_fs_dup_b')
    expect(secondPrivate!.upc).toBeNull()

    // Still only one pending submission for this upc.
    const rows = await env.DB.prepare(
      'SELECT count(*) as n FROM food_submissions WHERE upc = ? AND status = ?',
    )
      .bind(upc, 'pending')
      .first<{ n: number }>()
    expect(rows?.n).toBe(1)
  })

  it('approve links to an existing global upc row instead of creating a duplicate', async () => {
    const upc = '900000000003'
    const bearer = await loginAs('user_fs_approve_link')
    const logged = await scanAndLog(bearer, 'user_fs_approve_link', upc)
    const submission = await repos.foodSubmissions.getPendingByUpc(upc)
    expect(submission).not.toBeNull()

    // A global row for this upc already exists (e.g. contributed via OFF).
    const existingGlobal = await repos.foodItems.create({
      id: `ff_existing_${nextId()}`,
      upc,
      source: 'off',
      name: 'Existing Global Product',
      servingGrams: 50,
      servingQuantity: 50,
      servingUnit: 'g',
      isLiquid: false,
      per100g: { kcal: 400, proteinG: 40, carbsG: 40, fatG: 20 },
    })

    const approved = await approveFoodSubmission(repos, submission!.id)
    expect(approved.status).toBe('approved')
    expect(approved.migrationStatus).toBe('offered')
    expect(approved.globalFoodItemId).toBe(existingGlobal.id)

    // No duplicate global row was created.
    const allGlobalForUpc = await env.DB.prepare(
      'SELECT count(*) as n FROM food_items WHERE upc = ?',
    )
      .bind(upc)
      .first<{ n: number }>()
    expect(allGlobalForUpc?.n).toBe(1)

    void logged
  })

  it('approve without an existing global row creates one from the snapshot; GET lists it; migrate accept re-points the diary', async () => {
    const upc = '900000000004'
    const userId = 'user_fs_full_cycle'
    const bearer = await loginAs(userId)
    const logged = await scanAndLog(bearer, userId, upc, { name: 'Full Cycle Bar' })
    const submission = await repos.foodSubmissions.getPendingByUpc(upc)
    expect(submission).not.toBeNull()

    const approved = await approveFoodSubmission(repos, submission!.id)
    expect(approved.status).toBe('approved')
    expect(approved.migrationStatus).toBe('offered')
    expect(approved.globalFoodItemId).toBeTruthy()

    const globalItem = await repos.foodItems.getById(approved.globalFoodItemId!)
    expect(globalItem).not.toBeNull()
    expect(globalItem!.ownerUserId).toBeNull()
    expect(globalItem!.source).toBe('ai')
    expect(globalItem!.upc).toBe(upc)
    expect(globalItem!.name).toBe('Full Cycle Bar')

    // GET lists it for the actor.
    const list = await req(bearer, 'GET', '/api/v1/ui/food-submissions')
    const listBody = (await list.json()) as { submissions: { id: string; status: string }[] }
    expect(listBody.submissions.map((s) => s.id)).toContain(submission!.id)
    const listed = listBody.submissions.find((s) => s.id === submission!.id)!
    expect(listed.status).toBe('approved')

    // Migrate accept: diary entry re-pointed to the global row, private
    // row deleted, migration marked accepted.
    const migrate = await req(bearer, 'POST', `/api/v1/ui/food-submissions/${submission!.id}/migrate`, {
      accept: true,
    })
    expect(migrate.status).toBe(200)
    const migrateBody = (await migrate.json()) as { migrationStatus: string }
    expect(migrateBody.migrationStatus).toBe('accepted')

    const entryAfter = await repos.foodLog.getForActor(userId, logged.id)
    expect(entryAfter?.foodItemId).toBe(approved.globalFoodItemId)

    const privateAfter = await repos.foodItems.getForActor(userId, logged.foodItemId!)
    expect(privateAfter).toBeNull()

    // Re-migrating an already-resolved submission is a 409.
    const again = await req(bearer, 'POST', `/api/v1/ui/food-submissions/${submission!.id}/migrate`, {
      accept: true,
    })
    expect(again.status).toBe(409)
  })

  it('migrate decline leaves the private row intact and marks declined', async () => {
    const upc = '900000000005'
    const userId = 'user_fs_decline'
    const bearer = await loginAs(userId)
    const logged = await scanAndLog(bearer, userId, upc)
    const submission = await repos.foodSubmissions.getPendingByUpc(upc)
    await approveFoodSubmission(repos, submission!.id)

    const migrate = await req(bearer, 'POST', `/api/v1/ui/food-submissions/${submission!.id}/migrate`, {
      accept: false,
    })
    expect(migrate.status).toBe(200)
    const body = (await migrate.json()) as { migrationStatus: string }
    expect(body.migrationStatus).toBe('declined')

    const stillPrivate = await repos.foodItems.getForActor(userId, logged.foodItemId!)
    expect(stillPrivate).not.toBeNull()

    // A stale re-decline (or accept) after resolution is a 409.
    const again = await req(bearer, 'POST', `/api/v1/ui/food-submissions/${submission!.id}/migrate`, {
      accept: false,
    })
    expect(again.status).toBe(409)
  })

  it('acceptMigration raced by a committed decline is a full no-op (TOCTOU guard)', async () => {
    const upc = '900000000008'
    const userId = 'user_fs_toctou'
    const bearer = await loginAs(userId)
    const logged = await scanAndLog(bearer, userId, upc)
    const submission = await repos.foodSubmissions.getPendingByUpc(upc)
    const approved = await approveFoodSubmission(repos, submission!.id)

    // Simulate a decline committing BETWEEN acceptMigration's pre-check
    // and its batch: hand the repo a stale 'offered' snapshot via a
    // getById override while the real row is already 'declined'. The
    // EXISTS guards inside the batch must turn every statement into a
    // no-op — no re-point, no private-row delete, no status clobber.
    const { D1FoodSubmissionsRepo } = await import('../repos/d1/food-submissions.js')
    class StalePrecheckRepo extends D1FoodSubmissionsRepo {
      staleReads = 0
      override async getById(id: string) {
        const real = await super.getById(id)
        if (this.staleReads++ === 0 && real?.migrationStatus === 'declined') {
          return { ...real, migrationStatus: 'offered' as const }
        }
        return real
      }
    }
    await repos.foodSubmissions.declineMigration(submission!.id)

    const stale = new StalePrecheckRepo(_db)
    const result = await stale.acceptMigration({
      submissionId: submission!.id,
      userId,
      privateFoodItemId: logged.foodItemId!,
      globalFoodItemId: approved.globalFoodItemId!,
    })

    expect(result?.migrationStatus).toBe('declined')
    const entryAfter = await repos.foodLog.getForActor(userId, logged.id)
    expect(entryAfter?.foodItemId).toBe(logged.foodItemId)
    const stillPrivate = await repos.foodItems.getForActor(userId, logged.foodItemId!)
    expect(stillPrivate).not.toBeNull()
  })

  it('reject with a note leaves the private row untouched and is visible to the user', async () => {
    const upc = '900000000006'
    const userId = 'user_fs_reject'
    const bearer = await loginAs(userId)
    const logged = await scanAndLog(bearer, userId, upc)
    const submission = await repos.foodSubmissions.getPendingByUpc(upc)

    const rejected = await rejectFoodSubmission(repos, submission!.id, {
      note: 'Nutrition values look off — please rescan.',
    })
    expect(rejected.status).toBe('rejected')
    expect(rejected.adminNote).toBe('Nutrition values look off — please rescan.')
    expect(rejected.migrationStatus).toBe('none')

    const stillPrivate = await repos.foodItems.getForActor(userId, logged.foodItemId!)
    expect(stillPrivate).not.toBeNull()

    const list = await req(bearer, 'GET', '/api/v1/ui/food-submissions')
    const listBody = (await list.json()) as {
      submissions: { id: string; status: string; adminNote: string | null }[]
    }
    const listed = listBody.submissions.find((s) => s.id === submission!.id)!
    expect(listed.status).toBe('rejected')
    expect(listed.adminNote).toBe('Nutrition values look off — please rescan.')
  })

  it('migrate is 404 for a caller who is not the original submitter', async () => {
    const upc = '900000000007'
    const userId = 'user_fs_owner'
    const intruder = 'user_fs_intruder'
    const bearer = await loginAs(userId)
    await scanAndLog(bearer, userId, upc)
    const submission = await repos.foodSubmissions.getPendingByUpc(upc)
    await approveFoodSubmission(repos, submission!.id)

    const intruderBearer = await loginAs(intruder)
    const res = await req(
      intruderBearer,
      'POST',
      `/api/v1/ui/food-submissions/${submission!.id}/migrate`,
      { accept: true },
    )
    expect(res.status).toBe(404)
  })
})

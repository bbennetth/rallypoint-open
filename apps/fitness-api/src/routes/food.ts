import { Hono } from 'hono'
import type { Context } from 'hono'
import { ulid } from 'ulid'
import { TENANT_DEFAULT } from '@rallypoint/shared'
import {
  barcodeLookupSchema,
  computePortionBias,
  createFoodLogEntrySchema,
  foodGramsCorrected,
  foodLabelScanSchema,
  foodScanSchema,
  foodSearchMemoFresh,
  foodTextScanSchema,
  mergeFoodSearchResults,
  normalizeFoodSearchQuery,
  readNutritionLabel,
  FOOD_SEARCH_LIMIT,
  patchFoodLogEntrySchema,
  type FoodItemDto,
  type FoodLogEntryDto,
  type NutritionLabelRejection,
} from '@rallypoint/fitness-shared'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import { captureServerException } from '../middleware/error-handler.js'
import { AI_SCAN_RATE_LIMIT, applyPerUserRateLimit } from '../middleware/rate-limit.js'
import { buildScanTrace } from '../lib/ai-trace.js'
import { aiErrorCode, isCapacityError } from '../lib/ai-retry.js'
import { contributionToken } from '../lib/contribution-token.js'
import { buildFoodLogCreate } from '../lib/food-log-create.js'
import {
  createFoodLogWithContribution,
  ContributionForbiddenError,
  ImplausibleMacrosError,
} from '../services/food-log-contribution.js'
import type { FoodItemRecord, FoodLogEntryRecord } from '../repos/types.js'
import { fireSubmissionScan } from './submissions.js'
import { readJsonBody } from './_body.js'
import { parseDateRangeQuery } from './_query.js'

// Food logger (issue #700): the barcode lookup, the AI photo scan, and
// the diary CRUD. Session-gated in build-app. Lookup/scan NEVER write a
// diary row — logging is always an explicit POST /log after the user
// confirms in the UI.

const MAX_IMAGE_BYTES = 4 * 1024 * 1024 // matches routes/scan.ts
const MAX_BASE64_CHARS = Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4

// Manual-add name search (issue #713). Local-first: we only reach OFF
// when the local cache is thin AND the same query wasn't fetched inside
// the TTL (foodSearchMemoFresh — empty results expire on a much shorter
// TTL so a weak/failed OFF match doesn't suppress retries for a day). A
// small global token bucket protects OFF's ~10 req/min search limit
// across all users (the search endpoint is shared infrastructure, not
// per-user).
const SEARCH_LOCAL_THIN = 5
const SEARCH_OFF_RATE = { limit: 8, windowSeconds: 60 }
// How long "OFF has no serving data for this UPC" suppresses the barcode
// route's serving-heal re-fetch (negative cache; success needs no memo —
// a healed row stops being serving-less).
const SERVING_MEMO_TTL_MS = 24 * 60 * 60 * 1000

// Per-gate user guidance when a label read is rejected (422). "Retake a
// sharper photo" is only right advice for a genuinely unreadable panel;
// a missing gram serving line or name needs different framing, not focus.
const LABEL_REJECTION_MESSAGES: Record<NutritionLabelRejection, string> = {
  no_name:
    "Couldn't read the product name — add a photo of the product front, or include the name in the shot.",
  no_serving:
    "Couldn't find the serving size in grams or ml — make sure the serving size line (e.g. “2/3 cup (55g)”) is in frame.",
  no_macros:
    "Couldn't read the nutrition values — retake with the full Nutrition Facts panel sharp and in frame.",
  implausible:
    "The serving size or values didn't read correctly — retake a sharper photo of the panel.",
}

function itemToDto(r: FoodItemRecord): FoodItemDto {
  return {
    id: r.id,
    upc: r.upc,
    source: r.source,
    name: r.name,
    brand: r.brand,
    servingGrams: r.servingGrams,
    servingQuantity: r.servingQuantity,
    servingUnit: r.servingUnit,
    // null = cached before the units migration; degrade to non-liquid
    // (mass units only) rather than guessing.
    isLiquid: r.isLiquid === true,
    per100g: r.per100g,
  }
}

export function entryToDto(r: FoodLogEntryRecord): FoodLogEntryDto {
  return {
    id: r.id,
    loggedAt: r.loggedAt.toISOString(),
    foodItemId: r.foodItemId,
    name: r.name,
    quantityGrams: r.quantityGrams,
    quantityUnit: r.quantityUnit,
    quantityAmount: r.quantityAmount,
    estimatedGrams: r.estimatedGrams,
    preparedMealId: r.preparedMealId,
    kcal: r.kcal,
    proteinG: r.proteinG,
    carbsG: r.carbsG,
    fatG: r.fatG,
    source: r.source,
    note: r.note,
    createdAt: r.createdAt.toISOString(),
  }
}

function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
}

// Decode + size-gate one base64 image field. Checks the base64 char
// length (cheap, before allocating) and the decoded byte length against
// the 4 MiB cap, and rejects an empty image. `path` names the field for
// the validation error. Shared by /scan and /label.
// Fire-and-forget `edited` feedback into the AI trace corpus when the
// user's confirmed/weighed grams diverge from what the scan estimated —
// the tuning label for future estimation work. Never blocks or fails the
// diary write; ai-api itself enforces trace ownership and the content
// opt-out (finalValue is nulled server-side for opted-out traces).
function recordGramsCorrection(
  c: Context<HonoApp>,
  responseId: string,
  finalValue: { estimatedGrams: number | null; quantityGrams: number },
): void {
  const aiTraces = c.var.services.aiTraces
  if (!aiTraces) return
  const p = aiTraces
    .recordFeedback({
      responseId,
      userId: c.var.session!.userId,
      action: 'edited',
      finalValue: { kind: 'food-grams-correction', ...finalValue },
    })
    .catch(() => {
      // Best-effort telemetry only.
    })
  try {
    c.executionCtx.waitUntil(p)
  } catch {
    void p
  }
}

function decodeImageField(imageBase64: string, path: (string | number)[]): Uint8Array {
  if (imageBase64.length > MAX_BASE64_CHARS) throw errors.imageTooLarge(MAX_IMAGE_BYTES)
  const bytes = base64ToBytes(imageBase64)
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw errors.imageTooLarge(MAX_IMAGE_BYTES)
  if (bytes.byteLength === 0) {
    throw errors.validation({ issues: [{ code: 'custom', path, message: 'Empty image.' }] })
  }
  return bytes
}

export const foodRoutes = new Hono<HonoApp>()
  // --- barcode lookup (cache → Open Food Facts → cache) ---------------
  .post('/api/v1/ui/food/barcode', async (c) => {
    const parsed = barcodeLookupSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const upc = parsed.data.upc

    const cached = await c.var.repos.foodItems.getByUpc(upc)
    if (cached) {
      // Search write-throughs come from Search-a-licious, whose index has
      // no serving fields — heal such rows here with a full OFF product
      // read so a picked search item can default to "1 serving". Only the
      // global 'off' row is ever refreshed (never private rows or 'user'
      // corrections); on OFF failure the cached row serves as-is.
      const healable =
        cached.ownerUserId === null && cached.source === 'off' && cached.servingGrams === null
      // Negative cache: when OFF itself has no serving data for this
      // product, remember that (namespaced key in the search-memo table)
      // so repeat scans don't burn an OFF fetch each time.
      const memoKey = `serving:${upc}`
      if (healable) {
        const memo = await c.var.repos.foodSearchQueries.get(memoKey)
        const memoFresh =
          memo !== null && Date.now() - memo.fetchedAt.getTime() < SERVING_MEMO_TTL_MS
        if (!memoFresh) {
          try {
            const hit = await c.var.services.offClient.lookup(upc)
            // The FDC fallback may answer here too — its serving data is
            // just as good for healing, and the row keeps source 'off'
            // (refreshOffByUpc only touches the global OFF row).
            const product = hit?.product ?? null
            if (product) {
              const refreshed = await c.var.repos.foodItems.refreshOffByUpc(upc, {
                name: product.name,
                brand: product.brand,
                servingGrams: product.servingGrams,
                servingQuantity: product.servingQuantity,
                servingUnit: product.servingUnit,
                isLiquid: product.isLiquid,
                per100g: product.per100g,
                raw: null,
              })
              if (product.servingGrams === null) {
                // OFF has the product but no serving size — durable enough
                // to suppress re-fetching for the TTL.
                await c.var.repos.foodSearchQueries.record(memoKey, 0, new Date())
              }
              if (refreshed) return c.json({ item: itemToDto(refreshed), cached: true })
            } else {
              await c.var.repos.foodSearchQueries.record(memoKey, 0, new Date())
            }
          } catch (err) {
            // Transient OFF failure: no memo, so the next scan retries.
            c.var.logger.warn(
              { err: err instanceof Error ? err.message : String(err), upc },
              'off serving refresh failed',
            )
          }
        }
      }
      return c.json({ item: itemToDto(cached), cached: true })
    }

    let hit
    try {
      hit = await c.var.services.offClient.lookup(upc)
    } catch (err) {
      c.var.logger.warn(
        { err: err instanceof Error ? err.message : String(err), upc },
        'off lookup failed',
      )
      // Enveloped (code + message) so the browser client can render the
      // real message — a bare `{error: string}` body only ever shows as
      // "Request failed (5xx)." (see errors.scanFailed's comment).
      throw errors.upstreamUnavailable('Barcode lookup is unavailable right now.')
    }
    if (!hit) {
      // Unknown to OFF/FDC (or no usable nutrition) — the UI offers
      // manual / photo entry instead.
      return c.json({ item: null, cached: false })
    }

    const product = hit.product
    const item = await c.var.repos.foodItems.upsertByUpc({
      id: `ff_${ulid()}`,
      upc,
      source: hit.source,
      name: product.name,
      brand: product.brand,
      servingGrams: product.servingGrams,
      servingQuantity: product.servingQuantity,
      servingUnit: product.servingUnit,
      isLiquid: product.isLiquid,
      per100g: product.per100g,
      createdBy: c.var.session!.userId,
    })
    return c.json({ item: itemToDto(item), cached: false })
  })
  // --- name search (local cache + Open Food Facts, write-through) ------
  .get('/api/v1/ui/food/search', async (c) => {
    const query = normalizeFoodSearchQuery(c.req.query('q'))
    if (query === '') return c.json({ items: [], external: false })

    const local = await c.var.repos.foodItems.searchForActor(
      c.var.session!.userId,
      query,
      FOOD_SEARCH_LIMIT,
    )
    const localDtos = local.map(itemToDto)

    // Only spend an OFF fetch when the local cache is thin AND we haven't
    // fetched this query inside the TTL (products are cached in
    // food_items by then, so the next local search covers it).
    const memoKey = query.toLowerCase()
    const memo = await c.var.repos.foodSearchQueries.get(memoKey)
    if (localDtos.length >= SEARCH_LOCAL_THIN || foodSearchMemoFresh(memo, new Date())) {
      return c.json({ items: localDtos, external: false })
    }

    // Global bucket — OFF's search endpoint is shared infrastructure.
    const decision = await c.var.repos.rateLimit.takeToken({
      tenantId: TENANT_DEFAULT,
      bucketKey: 'off:search',
      limit: SEARCH_OFF_RATE.limit,
      windowSeconds: SEARCH_OFF_RATE.windowSeconds,
    })
    if (!decision.allowed) {
      // Budget spent — serve what we have rather than 429ing a search box.
      return c.json({ items: localDtos, external: false })
    }

    let products
    try {
      products = await c.var.services.offClient.search(query)
    } catch (err) {
      c.var.logger.warn(
        { err: err instanceof Error ? err.message : String(err), query },
        'off search failed',
      )
      return c.json({ items: localDtos, external: false })
    }

    // Write-through: cache every hit (even if the user picks none) so the
    // next search for it is served locally. upsertByUpc is race-safe.
    const externalDtos: FoodItemDto[] = []
    for (const product of products) {
      const item = await c.var.repos.foodItems.upsertByUpc({
        id: `ff_${ulid()}`,
        upc: product.upc,
        source: 'off',
        name: product.name,
        brand: product.brand,
        servingGrams: product.servingGrams,
        servingQuantity: product.servingQuantity,
        servingUnit: product.servingUnit,
        isLiquid: product.isLiquid,
        per100g: product.per100g,
        createdBy: c.var.session!.userId,
      })
      externalDtos.push(itemToDto(item))
    }
    await c.var.repos.foodSearchQueries.record(memoKey, products.length, new Date())

    const items = mergeFoodSearchResults(localDtos, externalDtos, FOOD_SEARCH_LIMIT)
    return c.json({ items, external: externalDtos.length > 0 })
  })
  // --- AI photo scan ---------------------------------------------------
  .post('/api/v1/ui/food/scan', async (c) => {
    const foodVision = c.var.services.foodVision
    if (!foodVision) {
      throw errors.notFound('Photo scan is not configured for this deployment.')
    }
    await applyPerUserRateLimit(c, { userId: c.var.session!.userId, ...AI_SCAN_RATE_LIMIT })
    const raw = await readJsonBody(c)
    const parsed = foodScanSchema.safeParse(raw)
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const bytes = decodeImageField(parsed.data.imageBase64, ['imageBase64'])
    let supporting: { image: Uint8Array; mimeType: string } | undefined
    if (parsed.data.supportingImage) {
      supporting = {
        image: decodeImageField(parsed.data.supportingImage.imageBase64, [
          'supportingImage',
          'imageBase64',
        ]),
        mimeType: parsed.data.supportingImage.mimeType,
      }
    }
    // ?mode=drink runs the mixed-drink pass (issue #713): same image
    // plumbing, a different prompt/schema, spirit+mixer guesses out.
    const mode = c.req.query('mode')
    const trace = await buildScanTrace(c, parsed.data.parentResponseId)
    try {
      if (mode === 'drink') {
        const drink = await foodVision.analyzeDrinkImage(
          bytes,
          parsed.data.mimeType,
          parsed.data.context,
          trace,
        )
        return c.json({ drink, responseId: trace.lastResponseId ?? null })
      }
      const result = await foodVision.analyzeFoodImage(
        bytes,
        parsed.data.mimeType,
        parsed.data.context,
        supporting,
        trace,
      )
      // Per-user calibration: how this user's confirmed/weighed grams
      // have historically compared to the raw AI estimates. The client
      // multiplies the raw estimate by this for the prefill; the raw
      // estimate stays what gets persisted, so the factor never
      // compounds. Best-effort — a failed read means no correction.
      let portionBias = 1.0
      try {
        const pairs = await c.var.repos.foodLog.recentEstimatePairs(c.var.session!.userId, 50)
        portionBias = computePortionBias(pairs)
      } catch (err) {
        c.var.logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'portion-bias read failed — defaulting to 1.0',
        )
      }
      return c.json({ scan: result, portionBias, responseId: trace.lastResponseId ?? null })
    } catch (err) {
      const capacity = isCapacityError(err)
      c.var.logger.error(
        {
          err: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
          capacity,
        },
        'food vision failed',
      )
      // Keep the underlying error (real AiError code, e.g. 3040) in
      // PostHog error tracking, but hand the client a typed envelope so
      // parseError() surfaces a real code + message instead of a bare 502.
      // Feature/scan_step mirror the client capture so the two $exception
      // events join in error tracking.
      captureServerException(c, err, {
        status: capacity ? 503 : 502,
        feature: 'food-scan',
        scan_step: mode === 'drink' ? 'drink-scan' : 'photo-scan',
        ai_error_code: aiErrorCode(err),
      })
      throw capacity
        ? errors.aiCapacity()
        : errors.scanFailed(
            mode === 'drink'
              ? 'Could not read the drink from that photo.'
              : 'Could not read the food from that photo.',
          )
    }
  })
  // --- AI text scan ("I ate 5 cherries" — the photo scanner, text only) -
  .post('/api/v1/ui/food/text', async (c) => {
    const foodVision = c.var.services.foodVision
    if (!foodVision) {
      throw errors.notFound('AI food estimation is not configured for this deployment.')
    }
    await applyPerUserRateLimit(c, { userId: c.var.session!.userId, ...AI_SCAN_RATE_LIMIT })
    const parsed = foodTextScanSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const trace = await buildScanTrace(c, parsed.data.parentResponseId)
    try {
      const scan = await foodVision.analyzeFoodText(parsed.data.text, parsed.data.context, trace)
      // No portionBias: that calibrates photo-size estimates; text
      // quantities are user-stated.
      return c.json({ scan, responseId: trace.lastResponseId ?? null })
    } catch (err) {
      const capacity = isCapacityError(err)
      c.var.logger.error(
        {
          err: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
          capacity,
        },
        'food text estimation failed',
      )
      captureServerException(c, err, {
        status: capacity ? 503 : 502,
        feature: 'food-scan',
        scan_step: 'text-scan',
        ai_error_code: aiErrorCode(err),
      })
      throw capacity
        ? errors.aiCapacity()
        : errors.scanFailed('Could not estimate the food from that description.')
    }
  })
  // --- AI nutrition-label read (unknown-UPC fallback) ------------------
  // When a barcode misses our cache AND Open Food Facts, the user
  // photographs the Nutrition Facts panel; Workers AI transcribes it and
  // we normalize to our per-100g shape keyed by the upc. Like /scan this
  // NEVER writes — it returns an unsaved candidate; the row is persisted
  // only on the follow-up POST /log with saveAsUpc, after the user
  // reviews the numbers.
  .post('/api/v1/ui/food/label', async (c) => {
    const foodVision = c.var.services.foodVision
    if (!foodVision) {
      throw errors.notFound('Photo scan is not configured for this deployment.')
    }
    await applyPerUserRateLimit(c, { userId: c.var.session!.userId, ...AI_SCAN_RATE_LIMIT })
    const parsed = foodLabelScanSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const { upc, mimeType, context } = parsed.data
    const bytes = decodeImageField(parsed.data.imageBase64, ['imageBase64'])
    let product: { image: Uint8Array; mimeType: string } | undefined
    if (parsed.data.productImage) {
      product = {
        image: decodeImageField(parsed.data.productImage.imageBase64, ['productImage', 'imageBase64']),
        mimeType: parsed.data.productImage.mimeType,
      }
    }

    const trace = await buildScanTrace(c)
    let label
    try {
      label = await foodVision.analyzeNutritionLabel(bytes, mimeType, product, context, trace)
    } catch (err) {
      const capacity = isCapacityError(err)
      c.var.logger.error(
        {
          err: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
          capacity,
        },
        'food label vision failed',
      )
      captureServerException(c, err, {
        status: capacity ? 503 : 502,
        feature: 'food-scan',
        scan_step: 'label-scan',
        ai_error_code: aiErrorCode(err),
      })
      throw capacity
        ? errors.aiCapacity()
        : errors.scanFailed('Could not read the nutrition facts from that photo.')
    }

    const read = readNutritionLabel(upc, label)
    if (!read.ok) {
      // The vision pass succeeded but a normalization gate rejected it.
      // Log the failing gate + the raw read (small, non-image) so error
      // triage can tell a blurry photo from a label our prompt can't
      // handle (e.g. per-100g-only panels with no gram serving line).
      c.var.logger.warn(
        { reason: read.reason, upc, label },
        'nutrition label read rejected',
      )
      throw errors.scanUnreadable(LABEL_REJECTION_MESSAGES[read.reason], {
        reason: read.reason,
      })
    }
    const normalized = read.product

    // Unsaved candidate (fresh id, source 'ai'); the confirm sheet logs
    // it with saveAsUpc, which is what actually persists the shared row.
    const item: FoodItemDto = {
      id: `ff_${ulid()}`,
      upc: normalized.upc,
      source: 'ai',
      name: normalized.name,
      brand: normalized.brand,
      servingGrams: normalized.servingGrams,
      servingQuantity: normalized.servingQuantity,
      servingUnit: normalized.servingUnit,
      isLiquid: normalized.isLiquid,
      per100g: normalized.per100g,
    }
    // Token binds the eventual saveAsUpc write to this real vision read
    // (verified server-side in /food/log), so the shared row can't be
    // forged without actually scanning the label.
    const token = await contributionToken(
      c.var.session!.userId,
      normalized.upc,
      c.var.env.FITNESS_SESSION_KEY_V1,
    )
    return c.json({ item, contributionToken: token, responseId: trace.lastResponseId ?? null })
  })
  // --- food-item read (edit flow) --------------------------------------
  // The edit sheet re-derives the unit options (serving size, liquid
  // flag, per-100g) from the entry's foodItemId; the diary row itself
  // only carries the snapshot.
  .get('/api/v1/ui/food/items/:id', async (c) => {
    const item = await c.var.repos.foodItems.getForActor(c.var.session!.userId, c.req.param('id'))
    if (!item) throw errors.notFound('Food item not found.')
    return c.json({ item: itemToDto(item) })
  })
  // --- diary CRUD ------------------------------------------------------
  .post('/api/v1/ui/food/log', async (c) => {
    const userId = c.var.session!.userId
    const parsed = createFoodLogEntrySchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const body = parsed.data

    if (body.foodItemId !== undefined) {
      // Soft provenance pointer — reject ids that don't resolve so the
      // diary never references a phantom cache row.
      const item = await c.var.repos.foodItems.getForActor(userId, body.foodItemId)
      if (!item) throw errors.notFound('Food item not found.')
    }

    const create = buildFoodLogCreate(userId, `fl_${ulid()}`, body)

    // Estimated-vs-actual: the user reviewed a photo-scan prefill of
    // estimatedGrams × portionBias and logged quantityGrams. A diverging
    // amount is a correction worth labeling in the trace corpus. The
    // comparison is against the CALIBRATED prefill, not the raw
    // estimate — otherwise every accepted prefill would read as an edit
    // once the bias moves off 1 and poison the calibration history.
    if (
      body.scanResponseId !== undefined &&
      body.estimatedGrams !== undefined &&
      body.quantityGrams !== undefined &&
      foodGramsCorrected(body.quantityGrams, body.estimatedGrams, body.portionBias ?? 1.0)
    ) {
      recordGramsCorrection(c, body.scanResponseId, {
        estimatedGrams: body.estimatedGrams,
        quantityGrams: body.quantityGrams,
      })
    }

    // The write itself (plain / custom / UPC-contribution branches) lives
    // in services/food-log-contribution.ts; the route only maps its typed
    // errors onto wire shapes.
    let result: Awaited<ReturnType<typeof createFoodLogWithContribution>>
    try {
      result = await createFoodLogWithContribution(
        c.var.repos,
        userId,
        c.var.env.FITNESS_SESSION_KEY_V1,
        body,
        create,
      )
    } catch (err) {
      if (err instanceof ContributionForbiddenError) {
        throw errors.forbidden('This product contribution could not be verified — rescan the label.')
      }
      if (err instanceof ImplausibleMacrosError) {
        return c.json(
          { error: 'Those macros look off for this amount — double-check them before saving.' },
          422,
        )
      }
      throw err
    }
    // The write above committed (createWithUpcSubmission is one
    // db.batch()), so the submission row exists — triage it.
    if (result.submissionId) fireSubmissionScan(c, 'food', result.submissionId)
    return c.json(
      result.contributionStatus !== undefined
        ? { ...entryToDto(result.created), contributionStatus: result.contributionStatus }
        : entryToDto(result.created),
      201,
    )
  })
  .get('/api/v1/ui/food/log', async (c) => {
    const userId = c.var.session!.userId
    const url = new URL(c.req.url)
    const filter: { from?: Date; to?: Date; limit?: number } = parseDateRangeQuery(url)
    const limitParam = url.searchParams.get('limit')
    if (limitParam) {
      const n = parseInt(limitParam, 10)
      if (!isNaN(n) && n > 0) filter.limit = n
    }
    const rows = await c.var.repos.foodLog.listForActor(userId, filter)
    return c.json({ entries: rows.map(entryToDto) })
  })
  // Per-local-day kcal/macro sums for the calorie dashboard. `tz` is
  // the client's UTC offset in minutes east (JS `-getTimezoneOffset()`)
  // so the SQL day buckets match the diary's client-supplied windows.
  .get('/api/v1/ui/food/summary', async (c) => {
    const userId = c.var.session!.userId
    const url = new URL(c.req.url)
    const filter = parseDateRangeQuery(url)
    const tzParam = url.searchParams.get('tz')
    let tz = 0
    if (tzParam !== null) {
      tz = parseInt(tzParam, 10)
      // Real-world offsets span UTC-12:00..UTC+14:00.
      if (isNaN(tz) || tz < -720 || tz > 840) {
        throw errors.validation({
          issues: [
            {
              code: 'custom',
              path: ['tz'],
              message: 'Query param "tz" must be a UTC offset in minutes (-720..840).',
            },
          ],
        })
      }
    }
    const rows = await c.var.repos.foodLog.sumByLocalDay(userId, filter, tz)
    // Round like sumFoodDay so the dashboard agrees with the diary
    // header for the same day.
    const r1 = (v: number) => Math.round(v * 10) / 10
    const days = rows.map((row) => ({
      date: row.day,
      kcal: Math.round(row.kcal),
      proteinG: r1(row.proteinG),
      carbsG: r1(row.carbsG),
      fatG: r1(row.fatG),
      entries: row.entries,
    }))
    return c.json({ days })
  })
  .patch('/api/v1/ui/food/log/:id', async (c) => {
    const userId = c.var.session!.userId
    const parsed = patchFoodLogEntrySchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const body = parsed.data

    const fields: import('../repos/types.js').PatchFoodLogEntryFields = {}
    if (body.loggedAt !== undefined) fields.loggedAt = new Date(body.loggedAt)
    if (body.name !== undefined) fields.name = body.name
    if ('quantityGrams' in body) fields.quantityGrams = body.quantityGrams ?? null
    if ('quantityUnit' in body) fields.quantityUnit = body.quantityUnit ?? null
    if ('quantityAmount' in body) fields.quantityAmount = body.quantityAmount ?? null
    // A patch that touches quantityGrams without restating the unit
    // pair would leave a stale "1.5 cup" label on a different gram
    // value — clear the pair unless the same patch provides it.
    if ('quantityGrams' in body && !('quantityUnit' in body)) {
      fields.quantityUnit = null
      fields.quantityAmount = null
    }
    if (body.kcal !== undefined) fields.kcal = body.kcal
    if (body.proteinG !== undefined) fields.proteinG = body.proteinG
    if (body.carbsG !== undefined) fields.carbsG = body.carbsG
    if (body.fatG !== undefined) fields.fatG = body.fatG
    if ('note' in body) fields.note = body.note ?? null

    // The "weighed it later" correction path: changing the amount on a
    // photo-scanned entry is the strongest estimated-vs-actual label we
    // get (the user put the food on a scale). Compare against the row's
    // CURRENT grams — the value the user last confirmed — so re-saves
    // with an unchanged amount stay silent. Read before update; both are
    // best-effort ordered (no transaction needed, feedback is advisory).
    let priorForCorrection: FoodLogEntryRecord | null = null
    if (fields.quantityGrams !== undefined && fields.quantityGrams !== null) {
      priorForCorrection = await c.var.repos.foodLog.getForActor(userId, c.req.param('id'))
    }

    const updated = await c.var.repos.foodLog.update(userId, c.req.param('id'), fields)
    if (!updated) throw errors.notFound('Food log entry not found.')

    if (
      priorForCorrection?.scanResponseId &&
      typeof fields.quantityGrams === 'number' &&
      (priorForCorrection.quantityGrams === null ||
        foodGramsCorrected(fields.quantityGrams, priorForCorrection.quantityGrams, 1.0))
    ) {
      recordGramsCorrection(c, priorForCorrection.scanResponseId, {
        estimatedGrams: priorForCorrection.estimatedGrams,
        quantityGrams: fields.quantityGrams,
      })
    }
    return c.json(entryToDto(updated))
  })
  .delete('/api/v1/ui/food/log/:id', async (c) => {
    const userId = c.var.session!.userId
    const ok = await c.var.repos.foodLog.delete(userId, c.req.param('id'))
    if (!ok) throw errors.notFound('Food log entry not found.')
    return c.json({ ok: true })
  })

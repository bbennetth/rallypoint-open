import {
  FOOD_SEARCH_LIMIT,
  normalizeFdcProduct,
  normalizeOffProduct,
  normalizeOffSearchHits,
  normalizeOffSearchPage,
  type NormalizedOffProduct,
} from '@rallypoint/fitness-shared'
import type { FoodLookupHit, OffClientService } from './types.js'

// Open Food Facts product lookup + full-text search for the food logger
// (issues #700, #713). One outbound fetch per cache miss; hits are
// served from our own food_items table so we stay well under OFF's rate
// expectations. OFF asks API consumers to send an identifying User-Agent
// (https://openfoodfacts.github.io/openfoodfacts-server/api/).

const OFF_BASE = 'https://world.openfoodfacts.org/api/v2/product'
// Free-text search: Search-a-licious (OFF's dedicated search service —
// far better relevance for brand/product-name queries than the legacy
// CGI token match), with the legacy CGI endpoint kept as a fallback for
// when the search service is down.
const OFF_SEARCH_ALICIOUS_BASE = 'https://search.openfoodfacts.org/search'
const OFF_SEARCH_LEGACY_BASE = 'https://world.openfoodfacts.org/cgi/search.pl'
// USDA FoodData Central — the barcode-lookup fallback for OFF outages
// (Branded Foods carry gtinUpc; data is public domain). Requires an API
// key (free, api.data.gov); when none is configured the tier is skipped.
const FDC_SEARCH_BASE = 'https://api.nal.usda.gov/fdc/v1/foods/search'
const USER_AGENT = 'RallypointFitness/1.0 (hello@rallypt.app)'
const TIMEOUT_MS = 5000
// One bounded retry of the OFF product fetch before falling back — most
// OFF failures are single slow/dropped requests, not outages.
const LOOKUP_RETRY_DELAY_MS = 250
// OFF fields we need for the normalizer — keeps the search page small.
const SEARCH_FIELDS = 'code,product_name,brands,serving_size,serving_quantity,serving_quantity_unit,product_quantity_unit,nutriments'

export interface OffClientOptions {
  /** api.data.gov key for the USDA FDC fallback; unset skips that tier. */
  fdcApiKey?: string | undefined
}

export function createOffClient(
  fetchFn: typeof fetch = fetch,
  options: OffClientOptions = {},
): OffClientService {
  // One OFF product-read attempt: null = definitively unknown (a real
  // answer, never retried), throw = transport/HTTP failure (retryable).
  async function offLookupAttempt(upc: string): Promise<NormalizedOffProduct | null> {
    const res = await fetchFn(
      `${OFF_BASE}/${encodeURIComponent(upc)}.json?fields=code,product_name,brands,serving_size,serving_quantity,serving_quantity_unit,product_quantity_unit,nutriments`,
      {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    )
    // OFF returns 404 for unknown barcodes; anything else non-OK is a
    // transport error the route maps to an enveloped 502.
    if (res.status === 404) return null
    if (!res.ok) {
      throw new Error(`Open Food Facts responded ${res.status}`)
    }
    const payload: unknown = await res.json()
    // status 0 = "product not found" served with HTTP 200 on some paths.
    if (
      typeof payload === 'object' &&
      payload !== null &&
      (payload as { status?: unknown }).status === 0
    ) {
      return null
    }
    return normalizeOffProduct(payload)
  }

  // FDC Branded-Foods fallback: null = no matching product (a real
  // answer), throw = transport failure (the caller surfaces the
  // original OFF error instead).
  async function fdcLookup(upc: string, apiKey: string): Promise<NormalizedOffProduct | null> {
    const params = new URLSearchParams({
      api_key: apiKey,
      query: upc,
      dataType: 'Branded',
      pageSize: '5',
    })
    const res = await fetchFn(`${FDC_SEARCH_BASE}?${params.toString()}`, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) {
      throw new Error(`FoodData Central responded ${res.status}`)
    }
    return normalizeFdcProduct(await res.json(), upc)
  }

  return {
    async lookup(upc: string): Promise<FoodLookupHit | null> {
      // OFF first (best international coverage, our normal write-through
      // source), with one bounded retry; then the FDC fallback so a
      // sustained OFF outage degrades to US-branded coverage instead of
      // a hard 502.
      let offError: unknown
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, LOOKUP_RETRY_DELAY_MS))
        try {
          const product = await offLookupAttempt(upc)
          return product === null ? null : { product, source: 'off' }
        } catch (err) {
          offError = err
        }
      }
      const fdcApiKey = options.fdcApiKey
      if (fdcApiKey !== undefined && fdcApiKey !== '') {
        try {
          const product = await fdcLookup(upc, fdcApiKey)
          return product === null ? null : { product, source: 'fdc' }
        } catch {
          // Fall through to the OFF error — it names the primary source.
        }
      }
      throw offError
    },

    async search(terms: string): Promise<NormalizedOffProduct[]> {
      // Search-a-licious first; fall back to the legacy CGI search only
      // on transport/HTTP failure (an empty-but-OK result is a real
      // answer, not a reason to double-spend the rate budget).
      try {
        const params = new URLSearchParams({
          q: terms,
          page_size: String(FOOD_SEARCH_LIMIT),
          fields: SEARCH_FIELDS,
        })
        const res = await fetchFn(`${OFF_SEARCH_ALICIOUS_BASE}?${params.toString()}`, {
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        })
        if (!res.ok) {
          throw new Error(`Open Food Facts search responded ${res.status}`)
        }
        const payload: unknown = await res.json()
        return normalizeOffSearchHits(payload)
      } catch {
        const params = new URLSearchParams({
          search_terms: terms,
          search_simple: '1',
          action: 'process',
          json: '1',
          page_size: String(FOOD_SEARCH_LIMIT),
          fields: SEARCH_FIELDS,
        })
        const res = await fetchFn(`${OFF_SEARCH_LEGACY_BASE}?${params.toString()}`, {
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        })
        if (!res.ok) {
          throw new Error(`Open Food Facts search responded ${res.status}`)
        }
        const payload: unknown = await res.json()
        return normalizeOffSearchPage(payload)
      }
    },
  }
}

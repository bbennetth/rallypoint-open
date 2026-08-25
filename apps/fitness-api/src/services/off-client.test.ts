import { describe, expect, it, vi } from 'vitest'
import { createOffClient } from './off-client.js'

// Unit tests for the Open Food Facts HTTP wrapper: 404 → null,
// status:0-with-HTTP-200 → null, non-OK → retry once then the USDA FDC
// fallback (when configured) then throw, OK → normalized hit.

const OFF_OK = {
  code: '737628064502',
  status: 1,
  product: {
    code: '737628064502',
    product_name: 'Rice Noodles',
    brands: 'Thai Kitchen',
    serving_size: '45 g',
    nutriments: { 'energy-kcal_100g': 360, proteins_100g: 7.1, carbohydrates_100g: 80, fat_100g: 1.2 },
  },
}

function fetchReturning(status: number, body?: unknown) {
  return vi.fn().mockResolvedValue(
    new Response(body === undefined ? null : JSON.stringify(body), { status }),
  ) as unknown as typeof fetch
}

// A minimal FDC Branded search response matching UPC 737628064502.
const FDC_OK = {
  foods: [
    {
      dataType: 'Branded',
      gtinUpc: '00737628064502', // zero-padded GTIN-14 form of the queried UPC
      description: 'RICE NOODLES',
      brandName: 'Thai Kitchen',
      servingSize: 45,
      servingSizeUnit: 'g',
      foodNutrients: [
        { nutrientNumber: '208', value: 360 },
        { nutrientNumber: '203', value: 7.1 },
        { nutrientNumber: '205', value: 80 },
        { nutrientNumber: '204', value: 1.2 },
      ],
    },
  ],
}

describe('createOffClient', () => {
  it('normalizes a found product and sends an identifying User-Agent', async () => {
    const fetchFn = fetchReturning(200, OFF_OK)
    const client = createOffClient(fetchFn)
    const out = await client.lookup('737628064502')
    expect(out?.source).toBe('off')
    expect(out?.product.name).toBe('Rice Noodles')
    expect(out?.product.per100g.kcal).toBe(360)
    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(String(url)).toContain('/api/v2/product/737628064502.json')
    expect((init as RequestInit).headers).toMatchObject({
      'User-Agent': expect.stringContaining('RallypointFitness'),
    })
  })

  it('returns null on 404 and on status:0 payloads', async () => {
    expect(await createOffClient(fetchReturning(404)).lookup('1')).toBeNull()
    expect(
      await createOffClient(fetchReturning(200, { status: 0 })).lookup('1'),
    ).toBeNull()
  })

  it('retries the OFF fetch once, then throws when no FDC key is set', async () => {
    const fetchFn = fetchReturning(500)
    await expect(createOffClient(fetchFn).lookup('1')).rejects.toThrow('500')
    expect((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2)
  })

  it('a transient OFF failure succeeds on the retry', async () => {
    const fetchFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('network blip'))
      .mockResolvedValueOnce(new Response(JSON.stringify(OFF_OK), { status: 200 })) as unknown as typeof fetch
    const out = await createOffClient(fetchFn).lookup('737628064502')
    expect(out?.source).toBe('off')
    expect(out?.product.name).toBe('Rice Noodles')
  })

  it('does not retry a 404 (a real answer)', async () => {
    const fetchFn = fetchReturning(404)
    expect(await createOffClient(fetchFn).lookup('1')).toBeNull()
    expect((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1)
  })

  it('falls back to FDC when OFF is down (both attempts)', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(FDC_OK), { status: 200 })) as unknown as typeof fetch
    const out = await createOffClient(fetchFn, { fdcApiKey: 'k' }).lookup('737628064502')
    expect(out?.source).toBe('fdc')
    expect(out?.product.name).toBe('RICE NOODLES')
    expect(out?.product.upc).toBe('737628064502')
    const calls = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls
    expect(calls).toHaveLength(3)
    expect(String(calls[2]![0])).toContain('api.nal.usda.gov/fdc/v1/foods/search')
    expect(String(calls[2]![0])).toContain('dataType=Branded')
  })

  it('OFF down + FDC no-match → null (unknown product, manual entry flow)', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ foods: [] }), { status: 200 })) as unknown as typeof fetch
    expect(await createOffClient(fetchFn, { fdcApiKey: 'k' }).lookup('1')).toBeNull()
  })

  it('OFF down + FDC also failing → throws the original OFF error', async () => {
    const fetchFn = fetchReturning(500)
    await expect(createOffClient(fetchFn, { fdcApiKey: 'k' }).lookup('1')).rejects.toThrow(
      'Open Food Facts responded 500',
    )
    expect((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3)
  })

  it('returns null for payloads with no usable nutrition', async () => {
    expect(
      await createOffClient(
        fetchReturning(200, { code: '1', status: 1, product: { product_name: 'X' } }),
      ).lookup('1'),
    ).toBeNull()
  })

  const JIF = {
    code: '111',
    product_name: 'Peanut Butter',
    brands: 'Jif',
    nutriments: {
      'energy-kcal_100g': 588,
      proteins_100g: 22,
      carbohydrates_100g: 22,
      fat_100g: 50,
    },
  }
  const NO_NUTRITION = { code: '222', product_name: 'No nutrition' } // dropped by the normalizer

  it('search hits Search-a-licious and normalizes the hits page', async () => {
    const fetchFn = fetchReturning(200, { hits: [JIF, NO_NUTRITION] })
    const out = await createOffClient(fetchFn).search('peanut butter')
    expect(out).toHaveLength(1)
    expect(out[0]!.name).toBe('Peanut Butter')
    const calls = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls
    expect(calls).toHaveLength(1)
    const [url] = calls[0]!
    expect(String(url)).toContain('search.openfoodfacts.org/search')
    expect(String(url)).toContain('q=peanut+butter')
  })

  it('search falls back to the legacy CGI endpoint when Search-a-licious fails', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ products: [JIF, NO_NUTRITION] }), { status: 200 }),
      ) as unknown as typeof fetch
    const out = await createOffClient(fetchFn).search('peanut butter')
    expect(out).toHaveLength(1)
    expect(out[0]!.name).toBe('Peanut Butter')
    const calls = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls
    expect(calls).toHaveLength(2)
    expect(String(calls[0]![0])).toContain('search.openfoodfacts.org/search')
    const [legacyUrl] = calls[1]!
    expect(String(legacyUrl)).toContain('/cgi/search.pl')
    expect(String(legacyUrl)).toContain('search_terms=peanut+butter')
    expect(String(legacyUrl)).toContain('json=1')
  })

  it('search throws when both endpoints fail (route degrades to local)', async () => {
    await expect(createOffClient(fetchReturning(500)).search('x')).rejects.toThrow('500')
  })
})

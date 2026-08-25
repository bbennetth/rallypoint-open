import { describe, expect, it, vi } from 'vitest'
import { createFoodVisionService, FOOD_VISION_MODEL } from './food-vision.js'
import { VISION_MODEL } from './vision-chat.js'

// Unit tests for the food-photo Workers AI wrapper: prompt/context
// plumbing, JSON extraction from prose-wrapped model output, and the
// throw-on-garbage contract the route maps to a 502.

const VALID = {
  mealName: 'Lean ground beef plate',
  estimatedServings: 1,
  items: [
    { name: 'Lean ground beef', estimatedGrams: 300, kcal: 750, proteinG: 78, carbsG: 0, fatG: 45 },
  ],
  questions: [],
}

interface VisionInput {
  messages: Array<{
    role: string
    content: Array<{ type: string; text?: string; image_url?: { url: string } }>
  }>
  max_tokens: number
  guided_json?: Record<string, unknown>
}

function aiReturning(text: string) {
  return { run: vi.fn().mockResolvedValue({ response: text }) }
}

function contentOf(input: unknown) {
  return (input as VisionInput).messages[0]!.content
}

describe('createFoodVisionService', () => {
  it('parses a clean JSON response and sends a messages-shaped vision input', async () => {
    const ai = aiReturning(JSON.stringify(VALID))
    const svc = createFoodVisionService(ai)
    const out = await svc.analyzeFoodImage(new Uint8Array([1, 2, 3]), 'image/png')
    expect(out).toEqual(VALID)
    const [model, input] = ai.run.mock.calls[0]!
    // Policy: no Meta/Llama models — shared model constant, non-Meta.
    expect(model).toBe(FOOD_VISION_MODEL)
    expect(model).toBe(VISION_MODEL)
    expect(model).not.toContain('@cf/meta/')
    const image = contentOf(input).find((p) => p.type === 'image_url')
    expect(image?.image_url?.url).toBe(`data:image/png;base64,${btoa('\x01\x02\x03')}`)
    expect(
      contentOf(input).find((p) => p.type === 'text' && p.text?.includes('FOOD PHOTO')),
    ).toBeTruthy()
  })

  it('extracts JSON wrapped in prose and appends user context to the prompt', async () => {
    const ai = aiReturning(
      `Sure! Here is the analysis:\n${JSON.stringify(VALID)}\nHope that helps.`,
    )
    const svc = createFoodVisionService(ai)
    const out = await svc.analyzeFoodImage(
      new Uint8Array([0]),
      'image/jpeg',
      '300g total, lean ground beef',
    )
    expect(out.items).toHaveLength(1)
    const [, input] = ai.run.mock.calls[0]!
    const text = contentOf(input).find((p) => p.type === 'text')
    expect(text?.text).toContain('300g total, lean ground beef')
  })

  it('throws on no-JSON, malformed JSON, and schema-invalid output', async () => {
    for (const text of [
      'I cannot see any food.',
      '{ "items": [ broken',
      JSON.stringify({ items: [{ name: '', estimatedGrams: -1 }], questions: [] }),
    ]) {
      const svc = createFoodVisionService(aiReturning(text))
      await expect(svc.analyzeFoodImage(new Uint8Array([0]), 'image/png')).rejects.toThrow()
    }
  })

  it('distinguishes truncated JSON (unbalanced braces) from no JSON at all', async () => {
    const truncated = createFoodVisionService(
      aiReturning('{"items": [{"name": "Rice", "estimatedGrams": 200'),
    )
    await expect(truncated.analyzeFoodImage(new Uint8Array([0]), 'image/png')).rejects.toThrow(
      /truncated JSON/,
    )
    const noJson = createFoodVisionService(aiReturning('I cannot see any food.'))
    await expect(noJson.analyzeFoodImage(new Uint8Array([0]), 'image/png')).rejects.toThrow(
      /no JSON object/,
    )
  })

  it('labels a truncated answer as truncated even when reasoning had a stray object', async () => {
    // Model disobeys "no braces in reasoning" AND its answer is cut off: the
    // last balanced object is the stray one, which fails schema — but the
    // dangling trailing `{` means the real failure is truncation, not a bad
    // schema. The error label must reflect that.
    const reply =
      'Analysis {"complete": true} — now the result:\n' +
      '{"mealName": "Eggs", "estimatedServings": 1, "items": [{"name": "Fried egg"'
    const svc = createFoodVisionService(aiReturning(reply))
    await expect(svc.analyzeFoodImage(new Uint8Array([1]), 'image/png')).rejects.toThrow(
      /truncated JSON/,
    )
  })

  it('runs the food pass WITHOUT guided_json and with a 3072-token cap', async () => {
    // The food pass reasons before emitting the JSON; guided_json would
    // straitjacket that into lazy round-number weights, so it is omitted and
    // the cap is raised to fit the reasoning preamble.
    const ai = aiReturning(JSON.stringify(VALID))
    const svc = createFoodVisionService(ai)
    await svc.analyzeFoodImage(new Uint8Array([1]), 'image/png')
    const [, input] = ai.run.mock.calls[0]!
    const typed = input as VisionInput
    expect(typed.max_tokens).toBe(3072)
    expect(typed.guided_json).toBeUndefined()
  })

  it('prompts the model to reason first and emit the JSON last', async () => {
    const ai = aiReturning(JSON.stringify(VALID))
    const svc = createFoodVisionService(ai)
    await svc.analyzeFoodImage(new Uint8Array([1]), 'image/png')
    const [, input] = ai.run.mock.calls[0]!
    const prompt = contentOf(input).find((p) => p.type === 'text')?.text ?? ''
    expect(prompt).toMatch(/STEP 1/)
    expect(prompt).toMatch(/STEP 2/)
    // No fake-precision directive — the model should give honest estimates.
    expect(prompt).toMatch(/HONEST/)
  })

  it('extracts the LAST balanced JSON object from a reason-then-JSON reply', async () => {
    // A stray "{" in the reasoning prose must not derail extraction — the
    // answer is the final balanced object.
    const reasoned =
      'Looking at the plate {roughly}, I see two eggs on a 27 cm plate.\n' +
      'Two eggs at ~55 g each.\n' +
      JSON.stringify(VALID)
    const svc = createFoodVisionService(aiReturning(reasoned))
    const out = await svc.analyzeFoodImage(new Uint8Array([1]), 'image/png')
    expect(out).toEqual(VALID)
  })

  it('grounds a countable item on its reference weight (2 eggs → 110 g)', async () => {
    // The model counts well but weighs lazily (round 100 g). aggregate-side
    // grounding via applyReferenceWeight is exercised end-to-end here.
    const withCount = {
      mealName: 'Two eggs',
      estimatedServings: 1,
      items: [
        { name: 'Fried egg', count: 2, unit: 'egg', estimatedGrams: 100, kcal: 140, proteinG: 12, carbsG: 2, fatG: 10 },
      ],
      questions: [],
    }
    const svc = createFoodVisionService(aiReturning(JSON.stringify(withCount)))
    const out = await svc.analyzeFoodImage(new Uint8Array([1]), 'image/png')
    // analyzeFoodImage returns the raw model items; grounding happens in
    // aggregateFoodScanResult (tested in fitness-shared). Here we just assert
    // the count/unit pair survives the reasoning-mode extraction.
    expect(out.items[0]).toMatchObject({ count: 2, unit: 'egg' })
  })

  it('accepts a response that is an already-parsed object', async () => {
    // Workers AI sometimes returns `response` as the parsed object itself
    // rather than a JSON string (verified live 2026-07-14) — visionResultObject
    // handles it before the text-extraction fallback runs.
    const svc = createFoodVisionService({ run: vi.fn().mockResolvedValue({ response: VALID }) })
    await expect(svc.analyzeFoodImage(new Uint8Array([0]), 'image/png')).resolves.toEqual(VALID)
  })

  it('rejects an object-shaped response that fails schema validation', async () => {
    const svc = createFoodVisionService({
      run: vi.fn().mockResolvedValue({ response: { items: 'not-an-array', questions: [] } }),
    })
    await expect(svc.analyzeFoodImage(new Uint8Array([0]), 'image/png')).rejects.toThrow(
      /schema validation/,
    )
  })

  it('reads choices-shaped and legacy description-shaped results', async () => {
    const fromChoices = createFoodVisionService({
      run: vi
        .fn()
        .mockResolvedValue({ choices: [{ message: { content: JSON.stringify(VALID) } }] }),
    })
    await expect(fromChoices.analyzeFoodImage(new Uint8Array([0]), 'image/png')).resolves.toEqual(
      VALID,
    )
    const fromDescription = createFoodVisionService({
      run: vi.fn().mockResolvedValue({ description: JSON.stringify(VALID) }),
    })
    await expect(
      fromDescription.analyzeFoodImage(new Uint8Array([0]), 'image/png'),
    ).resolves.toEqual(VALID)
  })

  it('routes through the AI Gateway when a gateway id is configured', async () => {
    const ai = aiReturning(JSON.stringify(VALID))
    const svc = createFoodVisionService(ai, 'rallypoint-ai')
    await svc.analyzeFoodImage(new Uint8Array([1]), 'image/png')
    expect(ai.run.mock.calls[0]![2]).toEqual({ gateway: { id: 'rallypoint-ai' } })
  })

  it('omits gateway options when no gateway id is configured', async () => {
    const ai = aiReturning(JSON.stringify(VALID))
    const svc = createFoodVisionService(ai)
    await svc.analyzeFoodImage(new Uint8Array([1]), 'image/png')
    expect(ai.run.mock.calls[0]![2]).toBeUndefined()
  })

  it('orders and labels the required food image before the optional supporting image', async () => {
    const ai = aiReturning(JSON.stringify(VALID))
    const svc = createFoodVisionService(ai)
    await svc.analyzeFoodImage(new Uint8Array([1]), 'image/jpeg', 'one restaurant serving', {
      image: new Uint8Array([2]),
      mimeType: 'image/png',
    })
    const [, input] = ai.run.mock.calls[0]!
    const content = contentOf(input)
    expect(content.map((part) => part.type)).toEqual([
      'text',
      'text',
      'image_url',
      'text',
      'image_url',
    ])
    expect(content[1]?.text).toContain('FOOD PHOTO')
    expect(content[2]?.image_url?.url).toContain('data:image/jpeg;base64,')
    expect(content[3]?.text).toContain('MENU OR INGREDIENT PHOTO')
    expect(content[4]?.image_url?.url).toContain('data:image/png;base64,')
    expect(content[0]?.text).toContain('one restaurant serving')
  })
})

describe('createFoodVisionService — analyzeDrinkImage', () => {
  const DRINK = { spirit: 'vodka', mixer: 'cola', confidence: 'high' as const }

  it('parses a drink guess and requests a spirit/mixer/confidence schema', async () => {
    const ai = aiReturning(JSON.stringify(DRINK))
    const svc = createFoodVisionService(ai)
    const out = await svc.analyzeDrinkImage(new Uint8Array([1]), 'image/png')
    expect(out).toEqual(DRINK)
    const [, input] = ai.run.mock.calls[0]!
    const typed = input as VisionInput
    expect(typed.guided_json).toMatchObject({
      type: 'object',
      required: ['spirit', 'mixer', 'confidence'],
    })
    // Smaller cap than the food pass — the object is tiny.
    expect(typed.max_tokens).toBe(256)
  })

  it('accepts null spirit/mixer and appends context', async () => {
    const ai = aiReturning(JSON.stringify({ spirit: null, mixer: null, confidence: 'low' }))
    const svc = createFoodVisionService(ai)
    const out = await svc.analyzeDrinkImage(new Uint8Array([0]), 'image/jpeg', 'grey goose bottle')
    expect(out.spirit).toBeNull()
    const [, input] = ai.run.mock.calls[0]!
    const text = contentOf(input).find((p) => p.type === 'text')
    expect(text?.text).toContain('grey goose bottle')
  })

  it('throws (route → 502) when the drink output fails schema validation', async () => {
    const svc = createFoodVisionService({
      run: vi.fn().mockResolvedValue({ response: { spirit: 'vodka', confidence: 'sure' } }),
    })
    await expect(svc.analyzeDrinkImage(new Uint8Array([0]), 'image/png')).rejects.toThrow(
      /schema validation/,
    )
  })
})

describe('createFoodVisionService — analyzeNutritionLabel', () => {
  const LABEL = {
    name: 'Protein Bar',
    brand: 'Acme',
    servingGrams: 55,
    servingUnit: 'g' as const,
    perServing: { kcal: 210, proteinG: 20, carbsG: 23, fatG: 8 },
  }

  it('parses a label read and requests the label schema + a small cap', async () => {
    const ai = aiReturning(JSON.stringify(LABEL))
    const svc = createFoodVisionService(ai)
    const out = await svc.analyzeNutritionLabel(new Uint8Array([1, 2, 3]), 'image/png')
    expect(out).toEqual(LABEL)
    const [model, input] = ai.run.mock.calls[0]!
    expect(model).toBe(FOOD_VISION_MODEL)
    const typed = input as VisionInput
    expect(typed.max_tokens).toBe(512)
    expect(typed.guided_json).toMatchObject({
      type: 'object',
      required: ['name', 'brand', 'servingGrams', 'servingUnit', 'perServing'],
    })
    expect(
      contentOf(input).find((p) => p.type === 'text' && p.text?.includes('NUTRITION FACTS LABEL')),
    ).toBeTruthy()
  })

  it('accepts the guided_json object shape and an all-null read', async () => {
    const parsed = createFoodVisionService({ run: vi.fn().mockResolvedValue({ response: LABEL }) })
    await expect(
      parsed.analyzeNutritionLabel(new Uint8Array([0]), 'image/png'),
    ).resolves.toEqual(LABEL)
    const nulls = {
      name: null,
      brand: null,
      servingGrams: null,
      servingUnit: null,
      perServing: null,
    }
    const svc = createFoodVisionService({ run: vi.fn().mockResolvedValue({ response: nulls }) })
    await expect(svc.analyzeNutritionLabel(new Uint8Array([0]), 'image/png')).resolves.toEqual(nulls)
  })

  it('labels the panel photo before the optional product-front photo, appends context', async () => {
    const ai = aiReturning(JSON.stringify(LABEL))
    const svc = createFoodVisionService(ai)
    await svc.analyzeNutritionLabel(
      new Uint8Array([1]),
      'image/jpeg',
      { image: new Uint8Array([2]), mimeType: 'image/png' },
      'store brand granola',
    )
    const [, input] = ai.run.mock.calls[0]!
    const content = contentOf(input)
    expect(content.map((part) => part.type)).toEqual(['text', 'text', 'image_url', 'text', 'image_url'])
    expect(content[1]?.text).toContain('NUTRITION FACTS LABEL')
    expect(content[3]?.text).toContain('PRODUCT FRONT')
    expect(content[0]?.text).toContain('store brand granola')
  })

  it('throws (route → 502) on unparseable or schema-invalid output', async () => {
    const noJson = createFoodVisionService(aiReturning('I cannot read the label.'))
    await expect(noJson.analyzeNutritionLabel(new Uint8Array([0]), 'image/png')).rejects.toThrow(
      /no JSON object/,
    )
    const badShape = createFoodVisionService({
      run: vi.fn().mockResolvedValue({ response: { name: 'X', servingGrams: 'lots' } }),
    })
    await expect(badShape.analyzeNutritionLabel(new Uint8Array([0]), 'image/png')).rejects.toThrow(
      /schema validation/,
    )
  })
})

describe('createFoodVisionService.analyzeFoodText', () => {
  const CHERRIES = {
    mealName: '5 cherries',
    estimatedServings: 1,
    items: [
      { name: 'Cherries', count: 5, unit: 'cherry', estimatedGrams: 40, kcal: 25, proteinG: 0.4, carbsG: 6, fatG: 0.1 },
    ],
    questions: [],
  }

  // Text mode uses a system+user chat shape (no image), so the user message
  // content is a plain string, not the multimodal parts array.
  interface TextInput {
    messages: Array<{ role: string; content: string }>
    max_tokens: number
    guided_json?: Record<string, unknown>
  }

  it('sends a text-only chat input (system prompt + user text), no image', async () => {
    const ai = aiReturning(JSON.stringify(CHERRIES))
    const svc = createFoodVisionService(ai)
    const out = await svc.analyzeFoodText('I ate 5 cherries')
    expect(out).toEqual(CHERRIES)
    const [model, input] = ai.run.mock.calls[0]!
    expect(model).toBe(FOOD_VISION_MODEL)
    expect(model).not.toContain('@cf/meta/')
    const typed = input as TextInput
    expect(typed.messages[0]?.role).toBe('system')
    expect(typed.messages[0]?.content).toContain('TEXT')
    expect(typed.messages[1]).toEqual({ role: 'user', content: 'I ate 5 cherries' })
    // No image part anywhere.
    expect(JSON.stringify(input)).not.toContain('image_url')
    // Text mode CAN use guided_json (no reasoning to preserve).
    expect(typed.guided_json).toBeTruthy()
  })

  it('appends user context (clarify-loop answers) to the prompt', async () => {
    const ai = aiReturning(JSON.stringify(CHERRIES))
    const svc = createFoodVisionService(ai)
    await svc.analyzeFoodText('some rice', 'Was the rice cooked? → yes, 1 cup cooked')
    const [, input] = ai.run.mock.calls[0]!
    expect((input as TextInput).messages[0]?.content).toContain('1 cup cooked')
  })

  it('throws (route → 502) on unparseable or schema-invalid output', async () => {
    const noJson = createFoodVisionService(aiReturning('I could not understand that.'))
    await expect(noJson.analyzeFoodText('asdfghjkl')).rejects.toThrow(/no JSON object/)
    const badShape = createFoodVisionService({
      run: vi.fn().mockResolvedValue({ response: { items: [{ name: '', estimatedGrams: -1 }] } }),
    })
    await expect(badShape.analyzeFoodText('x')).rejects.toThrow()
  })
})

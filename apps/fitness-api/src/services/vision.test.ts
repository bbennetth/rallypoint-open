import { describe, it, expect, vi } from 'vitest'
import { createVisionService } from './vision.js'

// The extractFirstJsonObject / extractLastJsonObject suites moved to
// packages/ai/src/result.test.ts with the extractors themselves.

const aiReturning = (text: string) => ({ run: vi.fn().mockResolvedValue({ response: text }) })

describe('createVisionService AI Gateway threading', () => {
  const WOD = { type: 'amrap', durationMin: 12, movements: [{ name: 'burpee', reps: 10 }] }

  it('routes through the AI Gateway when a gateway id is configured', async () => {
    const ai = aiReturning(JSON.stringify(WOD))
    const svc = createVisionService(ai, 'rallypoint-ai')
    await svc.parseWodFromImage(new Uint8Array([1]), 'image/png')
    expect(ai.run.mock.calls[0]![2]).toEqual({ gateway: { id: 'rallypoint-ai' } })
  })

  it('omits gateway options when no gateway id is configured', async () => {
    const ai = aiReturning(JSON.stringify(WOD))
    const svc = createVisionService(ai)
    await svc.parseWodFromImage(new Uint8Array([1]), 'image/png')
    expect(ai.run.mock.calls[0]![2]).toBeUndefined()
  })

  it('uses a non-Meta model with a messages-shaped vision input', async () => {
    const ai = aiReturning(JSON.stringify(WOD))
    const svc = createVisionService(ai)
    await svc.parseWodFromImage(new Uint8Array([9]), 'image/jpeg')
    const [model, input] = ai.run.mock.calls[0]!
    expect(model).not.toContain('@cf/meta/')
    expect(model).not.toContain('llava')
    const msgs = (
      input as {
        messages: Array<{ content: Array<{ type: string; image_url?: { url: string } }> }>
      }
    ).messages
    const image = msgs[0]!.content.find((p) => p.type === 'image_url')
    expect(image?.image_url?.url.startsWith('data:image/jpeg;base64,')).toBe(true)
  })

  it('constrains decoding with guided_json so the round count cannot be dropped', async () => {
    const ai = aiReturning(JSON.stringify(WOD))
    const svc = createVisionService(ai)
    await svc.parseWodFromImage(new Uint8Array([1]), 'image/png')
    const input = ai.run.mock.calls[0]![1] as {
      guided_json?: { properties: Record<string, unknown>; required: string[] }
    }
    expect(input.guided_json).toBeDefined()
    // `rounds` must be a REQUIRED key: the decoder then has to emit an
    // explicit null to say "unreadable" instead of silently omitting it,
    // which is what let a "10 Rounds" board arrive with no round count.
    expect(input.guided_json!.required).toContain('rounds')
    expect(Object.keys(input.guided_json!.properties)).toEqual(
      expect.arrayContaining(['type', 'rounds', 'intervalS', 'totalIntervals', 'workS', 'restS']),
    )
  })
})

describe('parseWodFromImage round counts', () => {
  // The reported bug, verbatim from the whiteboard photo:
  //   B. METCON — 10 Rounds
  //   3 Shoulder to Overhead @ 155/105 lbs / 5 Toes to Bar / 7 Burpees Over Bar
  // It came back as 3 rounds — the first movement's rep count showing
  // through, because nothing in the pipeline carried `rounds` at all.
  const METCON = {
    type: 'rounds_for_time',
    rounds: 10,
    movements: [
      { name: 'Shoulder to Overhead', reps: 3, load: 155, loadUnit: 'lb' },
      { name: 'Toes to Bar', reps: 5, load: null, loadUnit: null },
      { name: 'Burpees Over Bar', reps: 7, load: null, loadUnit: null },
    ],
  }

  it('keeps the header round count, not the first movement reps', async () => {
    const svc = createVisionService(aiReturning(JSON.stringify(METCON)))
    const out = await svc.parseWodFromImage(new Uint8Array([1]), 'image/jpeg')
    expect(out.type).toBe('rounds_for_time')
    expect(out.rounds).toBe(10)
    expect(out.movements.map((m) => m.reps)).toEqual([3, 5, 7])
  })

  it('converts a pounds board load to kg in code, not in the model', async () => {
    const svc = createVisionService(aiReturning(JSON.stringify(METCON)))
    const out = await svc.parseWodFromImage(new Uint8Array([1]), 'image/jpeg')
    expect(out.movements[0]!.loadKg).toBe(70.31)
    expect(out.movements[1]!.loadKg).toBeUndefined()
  })

  it('treats a load with no written unit as pounds', async () => {
    const svc = createVisionService(
      aiReturning(JSON.stringify({ type: 'amrap', movements: [{ name: 'thruster', load: 95 }] })),
    )
    const out = await svc.parseWodFromImage(new Uint8Array([1]), 'image/jpeg')
    expect(out.movements[0]!.loadKg).toBe(43.09)
  })

  it('keeps a kg board in kg', async () => {
    const svc = createVisionService(
      aiReturning(
        JSON.stringify({
          type: 'amrap',
          movements: [{ name: 'thruster', load: 43, loadUnit: 'kg' }],
        }),
      ),
    )
    const out = await svc.parseWodFromImage(new Uint8Array([1]), 'image/jpeg')
    expect(out.movements[0]!.loadKg).toBe(43)
  })

  it('drops null fields so the composer blanks them instead of defaulting', async () => {
    const svc = createVisionService(
      aiReturning(
        JSON.stringify({
          type: 'rounds_for_time',
          rounds: null,
          scheme: null,
          capMin: null,
          restS: null,
          notes: null,
          movements: [{ name: 'pull-up', reps: 5 }],
        }),
      ),
    )
    const out = await svc.parseWodFromImage(new Uint8Array([1]), 'image/jpeg')
    expect(out).not.toHaveProperty('rounds')
    expect(out).not.toHaveProperty('scheme')
    expect(out).not.toHaveProperty('capMin')
    expect(out).not.toHaveProperty('notes')
  })
})

describe('parseWodFromImage type coverage', () => {
  // All six WOD_TYPES round-trip. The schema used to allow only the first
  // three, so an EMOM or Fight-Gone-Bad board was coerced into a type it
  // wasn't — the same silent-wrong-value failure as the rounds default.
  const CASES: Array<[string, Record<string, number | string>]> = [
    ['for_time', { scheme: '21-15-9', capMin: 12 }],
    ['rounds_for_time', { rounds: 5, restS: 180 }],
    ['amrap', { durationMin: 20 }],
    ['emom', { intervalS: 60, totalIntervals: 30 }],
    ['interval', { rounds: 3, workS: 60, restS: 60 }],
    ['max_reps_rounds', { rounds: 5, durationMin: 20 }],
  ]

  for (const [type, extra] of CASES) {
    it(`parses a ${type} board`, async () => {
      const svc = createVisionService(
        aiReturning(JSON.stringify({ type, ...extra, movements: [{ name: 'row', reps: 10 }] })),
      )
      const out = (await svc.parseWodFromImage(new Uint8Array([1]), 'image/jpeg')) as Record<
        string,
        unknown
      >
      expect(out['type']).toBe(type)
      for (const [key, value] of Object.entries(extra)) {
        expect(out[key]).toBe(value)
      }
    })
  }
})

describe('parseWodFromImage failure paths', () => {
  // All three throw sites; the route collapses each to one 502.
  it('throws when the model returns no JSON object', async () => {
    const svc = createVisionService(aiReturning('I could not read that board, sorry.'))
    await expect(svc.parseWodFromImage(new Uint8Array([1]), 'image/jpeg')).rejects.toThrow(
      /no JSON object/i,
    )
  })

  it('throws when the JSON object is malformed', async () => {
    const svc = createVisionService(aiReturning('{"type": "amrap", "movements": [,]}'))
    await expect(svc.parseWodFromImage(new Uint8Array([1]), 'image/jpeg')).rejects.toThrow(
      /malformed JSON/i,
    )
  })

  it('throws when the payload fails schema validation', async () => {
    // 500 rounds is past the wodBodySchema cap of 50 — better a visible
    // 502 than a value that clears the scan and then 400s at save.
    const svc = createVisionService(
      aiReturning(JSON.stringify({ type: 'rounds_for_time', rounds: 500, movements: [] })),
    )
    await expect(svc.parseWodFromImage(new Uint8Array([1]), 'image/jpeg')).rejects.toThrow(
      /schema validation/i,
    )
  })

  it('rejects a duration past the 90-minute body cap instead of passing it on', async () => {
    // amrapBodySchema / maxRepsRoundsBodySchema both cap durationS at 90
    // minutes. A 120 that cleared this schema would fill the composer and
    // only blow up at save — the scan bounds exist to stop exactly that.
    const svc = createVisionService(
      aiReturning(
        JSON.stringify({ type: 'amrap', durationMin: 120, movements: [{ name: 'row', reps: 10 }] }),
      ),
    )
    await expect(svc.parseWodFromImage(new Uint8Array([1]), 'image/jpeg')).rejects.toThrow(
      /schema validation/i,
    )
  })

  it('rejects a movement list past the 20-row body cap', async () => {
    // wodBodySchema caps movements at 20. A hallucinated 25-row list should
    // fail here, not fill 25 composer rows that only blow up at save.
    const many = Array.from({ length: 25 }, (_, i) => ({ name: `movement ${i}`, reps: 5 }))
    const svc = createVisionService(
      aiReturning(JSON.stringify({ type: 'amrap', durationMin: 20, movements: many })),
    )
    await expect(svc.parseWodFromImage(new Uint8Array([1]), 'image/jpeg')).rejects.toThrow(
      /schema validation/i,
    )
  })

  it('throws on a type outside WOD_TYPES rather than coercing it', async () => {
    const svc = createVisionService(
      aiReturning(JSON.stringify({ type: 'tabata', movements: [{ name: 'row', reps: 10 }] })),
    )
    await expect(svc.parseWodFromImage(new Uint8Array([1]), 'image/jpeg')).rejects.toThrow(
      /schema validation/i,
    )
  })
})

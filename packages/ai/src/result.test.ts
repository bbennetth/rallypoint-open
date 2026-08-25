import { describe, expect, it } from 'vitest'
import {
  aiResultObject,
  aiResultText,
  extractFirstJsonObject,
  extractLastJsonObject,
  hasUnterminatedJsonObject,
  recoverJsonPayload,
} from './result.js'

// Extractor suites moved verbatim from apps/fitness-api/src/services/
// vision.test.ts when the scanners were lifted into this package.

describe('extractFirstJsonObject', () => {
  it('returns null for text with no braces', () => {
    expect(extractFirstJsonObject('hello world')).toBeNull()
  })

  it('returns the object when the whole string is a flat object', () => {
    const input = '{"type": "amrap", "movements": []}'
    expect(extractFirstJsonObject(input)).toBe(input)
  })

  it('extracts the first object from leading prose', () => {
    const obj = '{"type": "for_time", "movements": []}'
    const input = `Here is the workout: ${obj} that is all.`
    expect(extractFirstJsonObject(input)).toBe(obj)
  })

  it('stops at the first balanced close brace — not the last', () => {
    // Simulates model emitting a second stray object after the first.
    const first = '{"type": "amrap"}'
    const second = '{"extra": "noise"}'
    const input = `${first} ${second}`
    expect(extractFirstJsonObject(input)).toBe(first)
  })

  it('handles nested objects correctly', () => {
    const obj = '{"movements": [{"name": "squat", "reps": 10}]}'
    const input = `Result: ${obj}`
    expect(extractFirstJsonObject(input)).toBe(obj)
  })

  it('does not treat braces inside strings as depth markers', () => {
    // A note field containing braces should not confuse the balance counter.
    const obj = '{"notes": "warm up {optional}", "type": null}'
    const input = `Workout: ${obj} done.`
    expect(extractFirstJsonObject(input)).toBe(obj)
  })

  it('handles escaped quotes inside strings without mis-closing', () => {
    const obj = '{"notes": "coach said \\"good job\\"", "type": "amrap"}'
    const input = obj
    expect(extractFirstJsonObject(input)).toBe(obj)
  })

  it('returns null when braces are unbalanced (open never closed)', () => {
    expect(extractFirstJsonObject('{"key": "val"')).toBeNull()
  })

  it('recovers a valid object after a stray leading close brace', () => {
    // A dangling `}` before the real object must not corrupt depth tracking.
    const obj = '{"type": "amrap", "movements": []}'
    expect(extractFirstJsonObject(`} oops ${obj}`)).toBe(obj)
  })

  it('returns null for an empty string', () => {
    expect(extractFirstJsonObject('')).toBeNull()
  })
})

describe('extractLastJsonObject', () => {
  it('returns null for text with no braces', () => {
    expect(extractLastJsonObject('hello world')).toBeNull()
  })

  it('returns the object when the whole string is a flat object', () => {
    const input = '{"mealName": "Eggs", "items": []}'
    expect(extractLastJsonObject(input)).toBe(input)
  })

  it('extracts the LAST object — the answer after reasoning prose', () => {
    // The reasoning may itself contain a stray brace; the JSON is the final
    // balanced span, so the last object is the robust pick.
    const answer = '{"mealName": "Two eggs", "items": [{"count": 2}]}'
    const input = `I see ~2 eggs {roughly} on the plate.\n${answer}`
    expect(extractLastJsonObject(input)).toBe(answer)
  })

  it('skips an earlier balanced object and returns the final one', () => {
    const first = '{"draft": true}'
    const last = '{"final": true}'
    expect(extractLastJsonObject(`${first} then ${last}`)).toBe(last)
  })

  it('does not treat braces inside strings as depth markers', () => {
    const obj = '{"note": "about {two} eggs", "count": 2}'
    expect(extractLastJsonObject(`Reasoning here. ${obj}`)).toBe(obj)
  })

  it('returns null when the final object is truncated (unbalanced)', () => {
    // A complete earlier object followed by a cut-off tail returns the
    // complete one — the last BALANCED object, not the dangling open brace.
    expect(extractLastJsonObject('reasoning {"items": [')).toBeNull()
    expect(extractLastJsonObject('{"a": 1} and then {"b":')).toBe('{"a": 1}')
  })

  it('returns null for an empty string', () => {
    expect(extractLastJsonObject('')).toBeNull()
  })
})

describe('hasUnterminatedJsonObject', () => {
  it('flags a dangling top-level open brace (token-cap truncation)', () => {
    expect(hasUnterminatedJsonObject('{"muscles": [')).toBe(true)
    expect(hasUnterminatedJsonObject('prose {"a": {"b": 1}')).toBe(true)
  })

  it('does not flag balanced or empty text', () => {
    expect(hasUnterminatedJsonObject('{"a": 1}')).toBe(false)
    expect(hasUnterminatedJsonObject('no braces at all')).toBe(false)
    expect(hasUnterminatedJsonObject('')).toBe(false)
  })

  it('ignores braces inside strings', () => {
    expect(hasUnterminatedJsonObject('{"note": "open { brace"}')).toBe(false)
  })
})

describe('aiResultText', () => {
  it('prefers a string response', () => {
    expect(aiResultText({ response: 'hello' })).toBe('hello')
  })

  it('falls back to choices[0].message.content (string)', () => {
    expect(aiResultText({ choices: [{ message: { content: 'from choices' } }] })).toBe(
      'from choices',
    )
  })

  it('joins OpenAI-style content-part arrays, keeping only text parts', () => {
    expect(
      aiResultText({
        choices: [
          {
            message: {
              content: [
                { type: 'text', text: '{"a":' },
                { type: 'image_url', image_url: { url: 'x' } },
                { type: 'text', text: ' 1}' },
              ],
            },
          },
        ],
      }),
    ).toBe('{"a": 1}')
  })

  it('falls back to description, else empty string', () => {
    expect(aiResultText({ description: 'desc' })).toBe('desc')
    expect(aiResultText({})).toBe('')
  })
})

describe('aiResultObject', () => {
  it('returns a parsed-object response as-is', () => {
    const obj = { muscles: [] }
    expect(aiResultObject({ response: obj })).toBe(obj)
  })

  it('returns null for string, absent, and array responses', () => {
    expect(aiResultObject({ response: '{"a":1}' })).toBeNull()
    expect(aiResultObject({})).toBeNull()
    expect(aiResultObject({ response: [1, 2] as unknown as Record<string, unknown> })).toBeNull()
  })
})

// Supersedes fitness-api's extractReviewObject suite (PR #767): the same
// object → string → prose → choices/description ladder, now with typed
// failures + shape diagnostics instead of a bare null.
describe('recoverJsonPayload', () => {
  const payload = { muscles: [{ muscleId: 'lats', role: 'primary' }], rationale: 'pull' }

  it('returns the already-parsed object when guided_json yields one', () => {
    expect(recoverJsonPayload({ response: payload })).toEqual({ ok: true, object: payload })
  })

  it('parses a JSON string in `response` (model returned text, not an object)', () => {
    expect(recoverJsonPayload({ response: JSON.stringify(payload) })).toEqual({
      ok: true,
      object: payload,
    })
  })

  it('recovers the object from prose wrapped around the JSON', () => {
    const res = recoverJsonPayload({
      response: `Here you go:\n${JSON.stringify(payload)}\nThanks!`,
    })
    expect(res).toEqual({ ok: true, object: payload })
  })

  it('falls back to choices[].message.content and description', () => {
    expect(
      recoverJsonPayload({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
    ).toEqual({ ok: true, object: payload })
    expect(recoverJsonPayload({ description: JSON.stringify(payload) })).toEqual({
      ok: true,
      object: payload,
    })
  })

  it('honours a custom extractor (reason-then-JSON → last object)', () => {
    const res = recoverJsonPayload(
      { response: `{"draft": true} reasoning… {"final": true}` },
      { extract: extractLastJsonObject },
    )
    expect(res).toEqual({ ok: true, object: { final: true } })
  })

  it('fails with no_json + diagnostics when there is no JSON at all', () => {
    const res = recoverJsonPayload({ response: 'sorry, I cannot help with that' })
    expect(res).toMatchObject({
      ok: false,
      failure: 'no_json',
      diagnostics: {
        responseType: 'string',
        resultKeys: ['response'],
        rawPreview: 'sorry, I cannot help with that',
      },
    })
  })

  it('labels a dangling open brace as truncated (token cap), not no_json', () => {
    expect(recoverJsonPayload({ response: '{"muscles": [' })).toMatchObject({
      ok: false,
      failure: 'truncated',
    })
  })

  it('fails with malformed for a balanced-but-unparseable span', () => {
    expect(recoverJsonPayload({ response: '{ "muscles": [ }' })).toMatchObject({
      ok: false,
      failure: 'malformed',
    })
  })

  it('fails with non_object when a custom extractor yields non-record JSON', () => {
    // The built-in brace extractors only ever return {...} spans, so this
    // guard exists for pluggable extractors — prove it via one that
    // returns an array span.
    expect(
      recoverJsonPayload({ response: 'ids: [1, 2, 3]' }, { extract: () => '[1, 2, 3]' }),
    ).toMatchObject({ ok: false, failure: 'non_object' })
    expect(
      recoverJsonPayload({ response: 'n: 42' }, { extract: () => '42' }),
    ).toMatchObject({ ok: false, failure: 'non_object' })
  })

  it('fails with no_json for array-shaped and empty results', () => {
    // An array `response` is not the guided_json object and has no braces
    // to extract from its text view.
    expect(recoverJsonPayload({ response: [1, 2, 3] as unknown as string })).toMatchObject({
      ok: false,
      failure: 'no_json',
    })
    expect(recoverJsonPayload({})).toMatchObject({
      ok: false,
      failure: 'no_json',
      diagnostics: { responseType: 'undefined', resultKeys: [] },
    })
  })

  it('truncates rawPreview to 300 chars', () => {
    const res = recoverJsonPayload({ response: 'x'.repeat(1000) })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.diagnostics.rawPreview).toHaveLength(300)
  })
})

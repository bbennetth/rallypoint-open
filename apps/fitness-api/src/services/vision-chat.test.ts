import { describe, expect, it } from 'vitest'
import {
  VISION_MODEL,
  buildVisionInput,
  bytesToBase64,
  visionResultObject,
  visionResultText,
} from './vision-chat.js'

describe('VISION_MODEL policy', () => {
  it('is not a Meta/Llama(-derived) model', () => {
    expect(VISION_MODEL).not.toContain('@cf/meta/')
    expect(VISION_MODEL.toLowerCase()).not.toContain('llama')
    expect(VISION_MODEL.toLowerCase()).not.toContain('llava')
  })
})

describe('bytesToBase64', () => {
  it('encodes small buffers', () => {
    expect(bytesToBase64(new Uint8Array([104, 105]))).toBe(btoa('hi'))
  })

  it('encodes buffers larger than one chunk (0x8000) correctly', () => {
    const big = new Uint8Array(0x8000 + 17).fill(65) // 'A' x N across a chunk boundary
    const decoded = atob(bytesToBase64(big))
    expect(decoded.length).toBe(big.length)
    expect(decoded[0]).toBe('A')
    expect(decoded[decoded.length - 1]).toBe('A')
  })

  it('encodes an empty buffer to an empty string', () => {
    expect(bytesToBase64(new Uint8Array(0))).toBe('')
  })
})

describe('buildVisionInput', () => {
  it('builds an OpenAI-style multimodal message with a data-URI image', () => {
    const input = buildVisionInput('describe this', new Uint8Array([1]), 'image/webp', 256)
    expect(input).toEqual({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'describe this' },
            { type: 'image_url', image_url: { url: `data:image/webp;base64,${btoa('\x01')}` } },
          ],
        },
      ],
      max_tokens: 256,
    })
  })

  it('includes guided_json only when a schema is passed', () => {
    const schema = { type: 'object', properties: {} }
    const withSchema = buildVisionInput('p', new Uint8Array([1]), 'image/png', 64, schema)
    expect(withSchema['guided_json']).toEqual(schema)
    const without = buildVisionInput('p', new Uint8Array([1]), 'image/png', 64)
    expect('guided_json' in without).toBe(false)
  })
})

describe('visionResultText', () => {
  it('prefers response, then choices content, then description', () => {
    expect(visionResultText({ response: 'a', description: 'c' })).toBe('a')
    expect(visionResultText({ choices: [{ message: { content: 'b' } }], description: 'c' })).toBe(
      'b',
    )
    expect(visionResultText({ description: 'c' })).toBe('c')
    expect(visionResultText({})).toBe('')
  })

  it('skips an object-shaped response and falls back to choices content', () => {
    expect(
      visionResultText({ response: { a: 1 }, choices: [{ message: { content: 'b' } }] }),
    ).toBe('b')
  })
})

describe('visionResultObject', () => {
  it('returns the parsed object when response is guided_json-shaped', () => {
    expect(visionResultObject({ response: { items: [] } })).toEqual({ items: [] })
  })

  it('returns null for string-shaped or missing responses', () => {
    expect(visionResultObject({ response: '{"items": []}' })).toBeNull()
    expect(visionResultObject({})).toBeNull()
  })
})

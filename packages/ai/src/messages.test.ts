import { describe, expect, it } from 'vitest'
import { extractTraceRequest, extractTraceResponse } from './messages.js'

function dataUrl(bytes: number[], mimeType = 'image/jpeg'): string {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`
}

describe('extractTraceRequest', () => {
  it('converts text parts and strips data-URL images into placeholders', () => {
    const { request, images } = extractTraceRequest({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this?' },
            { type: 'image_url', image_url: { url: dataUrl([1, 2, 3]) } },
          ],
        },
      ],
      max_tokens: 512,
    })
    expect(request.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image_r2', key: '#0', mimeType: 'image/jpeg', bytes: 3 },
        ],
      },
    ])
    expect(request.params).toEqual({ max_tokens: 512 })
    expect(images).toHaveLength(1)
    expect(Array.from(images[0]!.bytes)).toEqual([1, 2, 3])
    expect(images[0]!.mimeType).toBe('image/jpeg')
  })

  it('indexes multiple images across messages', () => {
    const { request, images } = extractTraceRequest({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: dataUrl([1], 'image/png') } },
            { type: 'image_url', image_url: { url: dataUrl([2, 2]) } },
          ],
        },
      ],
    })
    expect(images.map((i) => i.index)).toEqual([0, 1])
    const parts = request.messages[0]!.content
    expect(parts[0]).toMatchObject({ type: 'image_r2', key: '#0', mimeType: 'image/png' })
    expect(parts[1]).toMatchObject({ type: 'image_r2', key: '#1', bytes: 2 })
  })

  it('handles string content and system roles', () => {
    const { request, images } = extractTraceRequest({
      messages: [{ role: 'system', content: 'be terse' }],
    })
    expect(request.messages).toEqual([
      { role: 'system', content: [{ type: 'text', text: 'be terse' }] },
    ])
    expect(request.params).toBeUndefined()
    expect(images).toEqual([])
  })

  it('keeps non-data image URLs as text markers instead of dropping them', () => {
    const { request, images } = extractTraceRequest({
      messages: [
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'https://example.com/x.jpg' } }],
        },
      ],
    })
    expect(images).toEqual([])
    expect(request.messages[0]!.content[0]).toEqual({
      type: 'text',
      text: '[image: https://example.com/x.jpg]',
    })
  })

  it('degrades unknown shapes without throwing', () => {
    const { request } = extractTraceRequest({ messages: [{ role: 'user', content: 42 }, null] })
    expect(request.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: '42' }] },
    ])
  })
})

describe('extractTraceResponse', () => {
  it('handles the plain-text response shape', () => {
    const { response } = extractTraceResponse({ response: 'hello' })
    expect(response.messages).toEqual([
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    ])
  })

  it('stringifies the guided_json object shape', () => {
    const { response } = extractTraceResponse({ response: { a: 1 } })
    expect(response.messages[0]!.content[0]).toEqual({ type: 'text', text: '{"a":1}' })
  })

  it('falls back to choices[].message.content and reads usage', () => {
    const { response, tokensIn, tokensOut } = extractTraceResponse({
      choices: [{ message: { content: 'from choices' } }],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    })
    expect(response.messages[0]!.content[0]).toEqual({ type: 'text', text: 'from choices' })
    expect(tokensIn).toBe(10)
    expect(tokensOut).toBe(20)
  })

  it('never throws on garbage', () => {
    expect(extractTraceResponse(undefined).response.messages).toHaveLength(1)
    expect(extractTraceResponse(null).response.messages).toHaveLength(1)
  })
})

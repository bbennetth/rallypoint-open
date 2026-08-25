import { describe, it, expect } from 'vitest'
import { SendChatSchema, CHAT_BODY_MAX } from './chat-validators.js'

describe('SendChatSchema', () => {
  it('accepts and trims a normal message', () => {
    const r = SendChatSchema.safeParse({ body: '  hello group  ' })
    expect(r.success).toBe(true)
    expect(r.success && r.data.body).toBe('hello group')
  })

  it('rejects an empty / whitespace-only body', () => {
    expect(SendChatSchema.safeParse({ body: '' }).success).toBe(false)
    expect(SendChatSchema.safeParse({ body: '   ' }).success).toBe(false)
  })

  it('rejects a body over the max length', () => {
    expect(SendChatSchema.safeParse({ body: 'x'.repeat(CHAT_BODY_MAX + 1) }).success).toBe(false)
  })

  it('accepts a body exactly at the max length', () => {
    expect(SendChatSchema.safeParse({ body: 'x'.repeat(CHAT_BODY_MAX) }).success).toBe(true)
  })

  it('rejects a missing body', () => {
    expect(SendChatSchema.safeParse({}).success).toBe(false)
  })
})

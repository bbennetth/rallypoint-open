import { describe, it, expect } from 'vitest'
import {
  SendChatSchema,
  chatListQuery,
  CHAT_BODY_MAX,
  CHAT_PAGE_DEFAULT,
  CHAT_PAGE_MAX,
} from './chat-validators.js'

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

describe('chatListQuery', () => {
  it('defaults limit and leaves before undefined when absent', () => {
    const r = chatListQuery.parse({})
    expect(r.limit).toBe(CHAT_PAGE_DEFAULT)
    expect(r.before).toBeUndefined()
  })

  it('coerces a string limit', () => {
    expect(chatListQuery.parse({ limit: '10' }).limit).toBe(10)
  })

  it('clamps an over-large limit to the max', () => {
    expect(chatListQuery.parse({ limit: '500' }).limit).toBe(CHAT_PAGE_MAX)
  })

  it('clamps a zero / negative limit up to 1', () => {
    expect(chatListQuery.parse({ limit: '0' }).limit).toBe(1)
    expect(chatListQuery.parse({ limit: '-5' }).limit).toBe(1)
  })

  it('falls back to the default on a non-numeric limit', () => {
    expect(chatListQuery.parse({ limit: 'abc' }).limit).toBe(CHAT_PAGE_DEFAULT)
  })

  it('passes a valid before cursor through', () => {
    expect(chatListQuery.parse({ before: 'msg_abc' }).before).toBe('msg_abc')
  })

  it('drops an over-long before cursor', () => {
    expect(chatListQuery.parse({ before: 'x'.repeat(65) }).before).toBeUndefined()
  })
})

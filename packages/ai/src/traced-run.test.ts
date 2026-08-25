import { describe, expect, it, vi } from 'vitest'
import { tracedAiRun, type TraceContext } from './traced-run.js'
import type { TraceImage, TraceRecord } from './types.js'

function makeCtx(overrides: Partial<TraceContext> = {}): {
  ctx: TraceContext
  recorded: Array<{ record: TraceRecord; images: TraceImage[] | undefined }>
  flush: () => Promise<void>
} {
  const recorded: Array<{ record: TraceRecord; images: TraceImage[] | undefined }> = []
  const pending: Promise<unknown>[] = []
  const ctx: TraceContext = {
    aiRpc: {
      recordTrace: async (record, images) => {
        recorded.push({ record, images })
      },
      recordFeedback: async () => ({ ok: true }),
    },
    waitUntil: (p) => {
      pending.push(p)
    },
    userId: 'user-1',
    app: 'fitness',
    feature: 'food-scan',
    contentOptOut: false,
    ...overrides,
  }
  return { ctx, recorded, flush: async () => void (await Promise.all(pending)) }
}

const input = {
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  max_tokens: 64,
}

describe('tracedAiRun', () => {
  it('returns the model result unchanged plus a responseId', async () => {
    const { ctx, recorded, flush } = makeCtx()
    const ai = { run: vi.fn().mockResolvedValue({ response: 'ok' }) }
    const out = await tracedAiRun(ai, 'test-model', input, { gateway: { id: 'g' } }, ctx)
    expect(out.result).toEqual({ response: 'ok' })
    expect(out.responseId).toMatch(/[0-9a-f-]{36}/)
    expect(out.traceId).toBe(out.responseId)
    expect(ai.run).toHaveBeenCalledWith('test-model', input, { gateway: { id: 'g' } })
    await flush()
    expect(recorded).toHaveLength(1)
    const { record } = recorded[0]!
    expect(record).toMatchObject({
      responseId: out.responseId,
      traceId: out.responseId,
      userId: 'user-1',
      app: 'fitness',
      feature: 'food-scan',
      provider: 'workers-ai',
      model: 'test-model',
      cached: false,
      contentOmitted: false,
      schemaVersion: 1,
    })
    expect(record.request?.messages[0]!.content[0]).toEqual({ type: 'text', text: 'hi' })
    expect(record.response?.messages[0]!.role).toBe('assistant')
    expect(record.latencyMs).toBeGreaterThanOrEqual(0)
    expect(record.error).toBeUndefined()
  })

  it('respects a caller-supplied traceId/parentId chain', async () => {
    const { ctx, recorded, flush } = makeCtx({ traceId: 'chain-1', parentId: 'resp-0' })
    const out = await tracedAiRun({ run: async () => ({}) }, 'm', input, undefined, ctx)
    expect(out.traceId).toBe('chain-1')
    await flush()
    expect(recorded[0]!.record).toMatchObject({ traceId: 'chain-1', parentId: 'resp-0' })
  })

  it('records the error and rethrows it unchanged', async () => {
    const { ctx, recorded, flush } = makeCtx()
    const boom = new Error('model exploded')
    await expect(
      tracedAiRun({ run: async () => Promise.reject(boom) }, 'm', input, undefined, ctx),
    ).rejects.toBe(boom)
    await flush()
    expect(recorded).toHaveLength(1)
    expect(recorded[0]!.record.error).toBe('model exploded')
    expect(recorded[0]!.record.response).toBeUndefined()
    // The request content is still captured on the error path.
    expect(recorded[0]!.record.request).toBeDefined()
  })

  it('omits content and images when the user opted out', async () => {
    const { ctx, recorded, flush } = makeCtx({ contentOptOut: true })
    const imageInput = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'scan' },
            {
              type: 'image_url',
              image_url: { url: `data:image/jpeg;base64,${Buffer.from([1]).toString('base64')}` },
            },
          ],
        },
      ],
    }
    await tracedAiRun({ run: async () => ({ response: 'x' }) }, 'm', imageInput, undefined, ctx)
    await flush()
    const { record, images } = recorded[0]!
    expect(record.contentOmitted).toBe(true)
    expect(record.request).toBeUndefined()
    expect(record.response).toBeUndefined()
    expect(images).toBeUndefined()
    expect(record.model).toBe('m')
    expect(record.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('swallows recordTrace rejections', async () => {
    const pending: Promise<unknown>[] = []
    const ctx: TraceContext = {
      aiRpc: {
        recordTrace: async () => {
          throw new Error('trace store down')
        },
        recordFeedback: async () => ({ ok: true }),
      },
      waitUntil: (p) => void pending.push(p),
      userId: 'u',
      app: 'a',
      feature: 'f',
      contentOptOut: false,
    }
    const out = await tracedAiRun({ run: async () => ({ response: 'ok' }) }, 'm', input, undefined, ctx)
    expect(out.result).toEqual({ response: 'ok' })
    await expect(Promise.all(pending)).resolves.toBeDefined()
  })

  it('is a no-op reporter without an aiRpc binding', async () => {
    const waitUntil = vi.fn()
    const ctx: TraceContext = {
      aiRpc: undefined,
      waitUntil,
      userId: 'u',
      app: 'a',
      feature: 'f',
      contentOptOut: false,
    }
    const out = await tracedAiRun({ run: async () => ({ response: 'ok' }) }, 'm', input, undefined, ctx)
    expect(out.result).toEqual({ response: 'ok' })
    expect(waitUntil).not.toHaveBeenCalled()
  })

  it('ships extracted image bytes alongside the record', async () => {
    const { ctx, recorded, flush } = makeCtx()
    const imageInput = {
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: `data:image/png;base64,${Buffer.from([9, 9]).toString('base64')}`,
              },
            },
          ],
        },
      ],
    }
    await tracedAiRun({ run: async () => ({ response: 'x' }) }, 'm', imageInput, undefined, ctx)
    await flush()
    const { record, images } = recorded[0]!
    expect(images).toHaveLength(1)
    expect(Array.from(images![0]!.bytes)).toEqual([9, 9])
    expect(record.request?.messages[0]!.content[0]).toMatchObject({ type: 'image_r2', key: '#0' })
  })
})

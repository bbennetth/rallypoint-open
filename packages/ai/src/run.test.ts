import { describe, expect, it, vi } from 'vitest'
import { runAiCall, runAiJson } from './run.js'
import type { TraceContext } from './traced-run.js'
import type { TraceRecord } from './types.js'

const MODEL = '@cf/mistralai/mistral-small-3.1-24b-instruct'
const INPUT = { messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 }

/** Capturing trace context: collects waitUntil promises + recorded traces
 * so tests can await the fire-and-forget report deterministically. */
function stubTrace(): {
  ctx: TraceContext
  records: TraceRecord[]
  flush: () => Promise<void>
} {
  const records: TraceRecord[] = []
  const pending: Promise<unknown>[] = []
  return {
    ctx: {
      aiRpc: {
        async recordTrace(record) {
          records.push(record)
        },
        async recordFeedback() {
          return { ok: true }
        },
      },
      waitUntil: (p) => pending.push(p),
      userId: 'admin',
      app: 'fitness',
      feature: 'exercise-muscle-review',
      contentOptOut: false,
    },
    records,
    flush: async () => {
      await Promise.all(pending)
    },
  }
}

describe('runAiCall', () => {
  it('passes gateway options through when gatewayId is set', async () => {
    const run = vi.fn().mockResolvedValue({ response: 'ok' })
    await runAiCall({ run }, MODEL, INPUT, { gatewayId: 'rallypoint-ai' })
    expect(run).toHaveBeenCalledWith(MODEL, INPUT, { gateway: { id: 'rallypoint-ai' } })
  })

  it('omits gateway options for blank/undefined ids (pre-gateway behavior)', async () => {
    const run = vi.fn().mockResolvedValue({ response: 'ok' })
    await runAiCall({ run }, MODEL, INPUT, {})
    await runAiCall({ run }, MODEL, INPUT, { gatewayId: '  ' })
    expect(run).toHaveBeenNthCalledWith(1, MODEL, INPUT, undefined)
    expect(run).toHaveBeenNthCalledWith(2, MODEL, INPUT, undefined)
  })

  it('records a trace with the response content when a trace context is given', async () => {
    const { ctx, records, flush } = stubTrace()
    const run = vi.fn().mockResolvedValue({ response: '{"a":1}' })
    const out = await runAiCall({ run }, MODEL, INPUT, { trace: ctx })
    await flush()
    expect(out.responseId).toBeTruthy()
    // traceId defaults to responseId for a chain of one — surfaced for callers
    // that echo it back grouping re-scans.
    expect(out.traceId).toBe(out.responseId)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      model: MODEL,
      app: 'fitness',
      feature: 'exercise-muscle-review',
      userId: 'admin',
      contentOmitted: false,
    })
    // The raw response text is captured — the QA debugging record.
    expect(JSON.stringify(records[0]!.response)).toContain('{\\"a\\":1}')
  })

  it('retries a transient capacity error; both attempts land in the trace corpus', async () => {
    const { ctx, records, flush } = stubTrace()
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('3040: Capacity temporarily exceeded'))
      .mockResolvedValueOnce({ response: 'ok' })
    const out = await runAiCall({ run }, MODEL, INPUT, {
      trace: ctx,
      retry: { maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0 },
    })
    await flush()
    expect(out.result).toEqual({ response: 'ok' })
    expect(run).toHaveBeenCalledTimes(2)
    expect(records).toHaveLength(2)
    expect(records[0]!.error).toContain('3040')
    expect(records[1]!.error).toBeUndefined()
  })

  it('does not retry deterministic errors', async () => {
    const boom = new Error('output failed schema validation')
    const run = vi.fn().mockRejectedValue(boom)
    await expect(runAiCall({ run }, MODEL, INPUT, {})).rejects.toBe(boom)
    expect(run).toHaveBeenCalledTimes(1)
  })
})

describe('runAiJson', () => {
  it('recovers the payload and carries the responseId through', async () => {
    const { ctx } = stubTrace()
    const run = vi.fn().mockResolvedValue({ response: '{"muscles": []}' })
    const out = await runAiJson({ run }, MODEL, INPUT, { trace: ctx })
    expect(out).toMatchObject({ ok: true, object: { muscles: [] } })
    expect(out.responseId).toBeTruthy()
    expect(out.traceId).toBe(out.responseId)
  })

  it('warn-logs shape diagnostics on an unrecoverable payload', async () => {
    const warn = vi.fn()
    const run = vi.fn().mockResolvedValue({ response: 'no json here' })
    const out = await runAiJson({ run }, MODEL, INPUT, { logger: { warn } })
    expect(out).toMatchObject({ ok: false, failure: 'no_json' })
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        model: MODEL,
        failure: 'no_json',
        responseType: 'string',
        resultKeys: ['response'],
        rawPreview: 'no json here',
      }),
      'AI JSON payload unrecoverable',
    )
  })

  it('stays silent on success (no warn), and without a logger never throws', async () => {
    const warn = vi.fn()
    const okRun = vi.fn().mockResolvedValue({ response: { fine: true } })
    await runAiJson({ run: okRun }, MODEL, INPUT, { logger: { warn } })
    expect(warn).not.toHaveBeenCalled()
    const badRun = vi.fn().mockResolvedValue({})
    await expect(runAiJson({ run: badRun }, MODEL, INPUT, {})).resolves.toMatchObject({
      ok: false,
    })
  })
})

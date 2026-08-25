import { createExecutionContext, env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import type { TraceRecord } from '@rallypoint/ai'
import { AiRPC } from './rpc.js'
import { createDb, createTracesRepo } from './repos/traces.js'
import { purgeUserData, runDeletionSweep } from './services/deletion.js'
import { runRetentionDrain } from './services/retention.js'
import { buildLogger } from './logger.js'

// D1 + R2 integration tests for the AiRPC ingest surface and the cron
// services. Real Miniflare D1 (ai-db migrations applied by the setup
// file) and R2 — no mocks.

const testEnv = env as unknown as {
  DB: D1Database
  AI_STORE: R2Bucket
  TEST_MIGRATIONS: unknown
}

function rpc(): AiRPC {
  return new AiRPC(createExecutionContext() as never, {
    DB: testEnv.DB,
    AI_STORE: testEnv.AI_STORE,
  } as never)
}

let seq = 0
function makeRecord(overrides: Partial<TraceRecord> = {}): TraceRecord {
  seq++
  return {
    responseId: `resp-${seq}-${crypto.randomUUID()}`,
    traceId: `trace-${seq}`,
    userId: 'user-a',
    app: 'fitness',
    feature: 'food-scan',
    provider: 'workers-ai',
    model: 'test-model',
    request: {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'scan this' },
            { type: 'image_r2', key: '#0', mimeType: 'image/jpeg', bytes: 3 },
          ],
        },
      ],
      params: { max_tokens: 512 },
    },
    response: {
      messages: [{ role: 'assistant', content: [{ type: 'text', text: '{"ok":true}' }] }],
    },
    latencyMs: 1234,
    cached: false,
    contentOmitted: false,
    schemaVersion: 1,
    ...overrides,
  }
}

async function getTraceRow(id: string) {
  return testEnv.DB.prepare('SELECT * FROM ai_traces WHERE id = ?').bind(id).first()
}

describe('AiRPC.recordTrace', () => {
  it('persists the row, uploads image blobs, and finalizes image keys', async () => {
    const record = makeRecord()
    await rpc().recordTrace(record, [
      { index: 0, bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/jpeg' },
    ])
    const row = (await getTraceRow(record.responseId)) as Record<string, unknown>
    expect(row).toBeTruthy()
    expect(row['user_id']).toBe('user-a')
    expect(row['model']).toBe('test-model')
    expect(row['latency_ms']).toBe(1234)
    expect(row['content_omitted']).toBe(0)
    const request = JSON.parse(row['request_json'] as string)
    const expectedKey = `traces/user-a/${record.traceId}/${record.responseId}/0.jpg`
    expect(request.messages[0].content[1]).toMatchObject({ type: 'image_r2', key: expectedKey })
    const blob = await testEnv.AI_STORE.get(expectedKey)
    expect(blob).toBeTruthy()
    expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
    const response = JSON.parse(row['response_json'] as string)
    expect(response.messages[0].role).toBe('assistant')
  })

  it('stores telemetry only (no content, no blobs) when contentOmitted', async () => {
    const record = makeRecord({ contentOmitted: true })
    await rpc().recordTrace(record, [
      { index: 0, bytes: new Uint8Array([9]), mimeType: 'image/png' },
    ])
    const row = (await getTraceRow(record.responseId)) as Record<string, unknown>
    expect(row['content_omitted']).toBe(1)
    expect(row['request_json']).toBeNull()
    expect(row['response_json']).toBeNull()
    expect(row['latency_ms']).toBe(1234)
    const listing = await testEnv.AI_STORE.list({ prefix: `traces/user-a/${record.traceId}/` })
    expect(listing.objects).toHaveLength(0)
  })

  it('drops invalid records without throwing', async () => {
    await expect(
      rpc().recordTrace({ nonsense: true } as unknown as TraceRecord),
    ).resolves.toBeUndefined()
  })

  it('drops records whose ids would break the R2 key hierarchy', async () => {
    const record = makeRecord({ userId: 'evil/../user' })
    await rpc().recordTrace(record)
    expect(await getTraceRow(record.responseId)).toBeNull()
  })

  it('records the error path (error set, no response)', async () => {
    const record = makeRecord({ response: undefined, error: 'model exploded' })
    await rpc().recordTrace(record)
    const row = (await getTraceRow(record.responseId)) as Record<string, unknown>
    expect(row['error']).toBe('model exploded')
    expect(row['response_json']).toBeNull()
    expect(row['request_json']).not.toBeNull()
  })
})

describe('AiRPC.recordFeedback', () => {
  it('persists feedback with the final value', async () => {
    const record = makeRecord()
    await rpc().recordTrace(record)
    const result = await rpc().recordFeedback({
      responseId: record.responseId,
      userId: 'user-a',
      action: 'edited',
      finalValue: { kcal: 350 },
    })
    expect(result).toEqual({ ok: true })
    const row = (await testEnv.DB.prepare('SELECT * FROM ai_feedback WHERE response_id = ?')
      .bind(record.responseId)
      .first()) as Record<string, unknown>
    expect(row['action']).toBe('edited')
    expect(JSON.parse(row['final_value_json'] as string)).toEqual({ kcal: 350 })
  })

  it('nulls the final value when the parent trace has content omitted', async () => {
    const record = makeRecord({ contentOmitted: true })
    await rpc().recordTrace(record)
    const result = await rpc().recordFeedback({
      responseId: record.responseId,
      userId: 'user-a',
      action: 'edited',
      finalValue: { secret: 'meal' },
    })
    expect(result).toEqual({ ok: true })
    const row = (await testEnv.DB.prepare('SELECT * FROM ai_feedback WHERE response_id = ?')
      .bind(record.responseId)
      .first()) as Record<string, unknown>
    expect(row['action']).toBe('edited')
    expect(row['final_value_json']).toBeNull()
  })

  it("rejects feedback against another user's trace", async () => {
    const record = makeRecord({ userId: 'owner-user' })
    await rpc().recordTrace(record)
    const result = await rpc().recordFeedback({
      responseId: record.responseId,
      userId: 'other-user',
      action: 'accepted',
    })
    expect(result).toEqual({ ok: false })
    const row = await testEnv.DB.prepare('SELECT * FROM ai_feedback WHERE response_id = ?')
      .bind(record.responseId)
      .first()
    expect(row).toBeNull()
  })

  it('returns ok:false for an unknown responseId', async () => {
    const result = await rpc().recordFeedback({
      responseId: 'nope',
      userId: 'user-a',
      action: 'accepted',
    })
    expect(result).toEqual({ ok: false })
  })
})

describe('purgeUserData / deleteUserData', () => {
  it('removes traces, feedback, and R2 blobs for the user only', async () => {
    const repo = createTracesRepo(createDb(testEnv.DB))
    const mine = makeRecord({ userId: 'purge-me' })
    const theirs = makeRecord({ userId: 'keep-me' })
    await rpc().recordTrace(mine, [{ index: 0, bytes: new Uint8Array([1]), mimeType: 'image/jpeg' }])
    await rpc().recordTrace(theirs, [
      { index: 0, bytes: new Uint8Array([2]), mimeType: 'image/jpeg' },
    ])
    await rpc().recordFeedback({ responseId: mine.responseId, userId: 'purge-me', action: 'accepted' })

    const counts = await purgeUserData(repo, testEnv.AI_STORE, 'purge-me')
    expect(counts.traces).toBe(1)
    expect(counts.feedback).toBe(1)
    expect(counts.blobs).toBe(1)
    expect(await getTraceRow(mine.responseId)).toBeNull()
    expect(await getTraceRow(theirs.responseId)).toBeTruthy()
    expect((await testEnv.AI_STORE.list({ prefix: 'traces/purge-me/' })).objects).toHaveLength(0)
    expect((await testEnv.AI_STORE.list({ prefix: 'traces/keep-me/' })).objects).toHaveLength(1)
  })
})

describe('runDeletionSweep', () => {
  it('purges every user id-api reports as deleted', async () => {
    const repo = createTracesRepo(createDb(testEnv.DB))
    const record = makeRecord({ userId: 'deleted-user' })
    await rpc().recordTrace(record)
    const rpid = {
      listDeletedUserIds: async () => ['deleted-user', 'never-had-data'],
    }
    const logger = buildLogger({ LOG_LEVEL: 'error', NODE_ENV: 'test' })
    const result = await runDeletionSweep(rpid as never, repo, testEnv.AI_STORE, logger)
    expect(result.users).toBe(1)
    expect(result.traces).toBe(1)
    expect(await getTraceRow(record.responseId)).toBeNull()
  })
})

describe('runRetentionDrain', () => {
  it('exports old traces (with feedback) to JSONL in R2 and deletes the rows', async () => {
    const repo = createTracesRepo(createDb(testEnv.DB))
    const oldRecord = makeRecord({ userId: 'retention-user' })
    const newRecord = makeRecord({ userId: 'retention-user' })
    await rpc().recordTrace(oldRecord)
    await rpc().recordTrace(newRecord)
    await rpc().recordFeedback({
      responseId: oldRecord.responseId,
      userId: 'retention-user',
      action: 'accepted',
    })
    // Age the first row past the cutoff.
    const oldMs = Date.now() - 400 * 24 * 60 * 60 * 1000
    await testEnv.DB.prepare('UPDATE ai_traces SET created_at = ? WHERE id = ?')
      .bind(oldMs, oldRecord.responseId)
      .run()

    const logger = buildLogger({ LOG_LEVEL: 'error', NODE_ENV: 'test' })
    const result = await runRetentionDrain(repo, testEnv.AI_STORE, 365, new Date(), logger)
    expect(result.drained).toBe(1)
    expect(result.exportKey).toMatch(/^exports\/\d{4}-\d{2}\/traces-.*\.jsonl$/)
    const exported = await testEnv.AI_STORE.get(result.exportKey!)
    const lines = (await exported!.text()).trim().split('\n')
    expect(lines).toHaveLength(1)
    const bundle = JSON.parse(lines[0]!)
    expect(bundle.trace.id).toBe(oldRecord.responseId)
    expect(bundle.feedback).toHaveLength(1)
    expect(await getTraceRow(oldRecord.responseId)).toBeNull()
    expect(await getTraceRow(newRecord.responseId)).toBeTruthy()
  })

  it('is a no-op when nothing is old enough', async () => {
    const repo = createTracesRepo(createDb(testEnv.DB))
    const logger = buildLogger({ LOG_LEVEL: 'error', NODE_ENV: 'test' })
    const result = await runRetentionDrain(repo, testEnv.AI_STORE, 365, new Date(), logger)
    expect(result.drained).toBe(0)
    expect(result.exportKey).toBeNull()
  })

  it('continues past a failing delete and still drains the rest', async () => {
    const repo = createTracesRepo(createDb(testEnv.DB))
    const a = makeRecord({ userId: 'partial-user' })
    const b = makeRecord({ userId: 'partial-user' })
    await rpc().recordTrace(a)
    await rpc().recordTrace(b)
    // Age both rows past the cutoff.
    const oldMs = Date.now() - 400 * 24 * 60 * 60 * 1000
    for (const rec of [a, b]) {
      await testEnv.DB.prepare('UPDATE ai_traces SET created_at = ? WHERE id = ?')
        .bind(oldMs, rec.responseId)
        .run()
    }

    // Wrap the repo so deleting the first trace throws, mimicking a
    // transient D1 error mid-batch.
    const failing: typeof repo = {
      ...repo,
      deleteTrace: async (id: string) => {
        if (id === a.responseId) throw new Error('simulated delete failure')
        return repo.deleteTrace(id)
      },
    }
    const logger = buildLogger({ LOG_LEVEL: 'error', NODE_ENV: 'test' })

    // Must not throw; the healthy row is still deleted, the failed one
    // remains (to be re-attempted next drain).
    const result = await runRetentionDrain(failing, testEnv.AI_STORE, 365, new Date(), logger)
    expect(result.drained).toBe(1)
    expect(await getTraceRow(a.responseId)).toBeTruthy()
    expect(await getTraceRow(b.responseId)).toBeNull()
  })
})

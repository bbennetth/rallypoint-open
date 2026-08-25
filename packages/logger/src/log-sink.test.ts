import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLogger } from './index.js'
import {
  buildLogRecord,
  createPostHogLogSink,
  isoToUnixNano,
  toAnyValue,
  type OtlpAnyValue,
  type OtlpKeyValue,
  type OtlpLogRecord,
} from './log-sink.js'

interface ResourceLogs {
  resource: { attributes: OtlpKeyValue[] }
  scopeLogs: Array<{ logRecords: OtlpLogRecord[] }>
}

function payloadAt(fetchMock: ReturnType<typeof vi.fn>, index: number): ResourceLogs {
  const call = fetchMock.mock.calls[index]!
  const body = JSON.parse((call[1] as RequestInit).body as string) as {
    resourceLogs: ResourceLogs[]
  }
  return body.resourceLogs[0]!
}

function lastPayload(fetchMock: ReturnType<typeof vi.fn>): ResourceLogs {
  return payloadAt(fetchMock, fetchMock.mock.calls.length - 1)
}

function records(fetchMock: ReturnType<typeof vi.fn>): OtlpLogRecord[] {
  return lastPayload(fetchMock).scopeLogs[0]!.logRecords
}

function bodies(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return records(fetchMock).map((r) => r.body.stringValue)
}

function attr(record: OtlpLogRecord, key: string): OtlpAnyValue | undefined {
  return record.attributes.find((a) => a.key === key)?.value
}

function resourceAttr(payload: ResourceLogs, key: string): string | undefined {
  const value = payload.resource.attributes.find((a) => a.key === key)?.value
  return value && 'stringValue' in value ? value.stringValue : undefined
}

// ---------------------------------------------------------------------------
// toAnyValue — JS value → OTLP AnyValue
// ---------------------------------------------------------------------------

describe('toAnyValue', () => {
  it('maps strings and booleans', () => {
    expect(toAnyValue('hi')).toEqual({ stringValue: 'hi' })
    expect(toAnyValue(true)).toEqual({ boolValue: true })
    expect(toAnyValue(false)).toEqual({ boolValue: false })
  })

  it('maps integers to intValue as a decimal string', () => {
    expect(toAnyValue(42)).toEqual({ intValue: '42' })
    expect(toAnyValue(-7)).toEqual({ intValue: '-7' })
    expect(toAnyValue(0)).toEqual({ intValue: '0' })
  })

  it('maps non-integer finite numbers to doubleValue', () => {
    expect(toAnyValue(1.5)).toEqual({ doubleValue: 1.5 })
  })

  // Regression guard: `Number.isInteger(1e21)` is true, but `String(1e21)`
  // is '1e+21' — exponential notation is NOT a valid decimal string for an
  // OTLP int64 field. Anything past the safe-integer range must take the
  // doubleValue branch instead of shipping a malformed intValue.
  it('routes integers beyond the safe range to doubleValue, never an exponential intValue', () => {
    expect(toAnyValue(1e21)).toEqual({ doubleValue: 1e21 })
    expect(toAnyValue(2 ** 53)).toEqual({ doubleValue: 2 ** 53 })
    // The largest exact integer still takes the intValue branch.
    expect(toAnyValue(Number.MAX_SAFE_INTEGER)).toEqual({ intValue: '9007199254740991' })
  })

  it('never emits an intValue in exponential notation', () => {
    for (const n of [1e15, 1e16, 1e20, 1e21, 1e30, Number.MAX_VALUE, -1e21]) {
      const v = toAnyValue(n)
      if (v && 'intValue' in v) expect(v.intValue).not.toMatch(/e/i)
    }
  })

  it('stringifies non-finite numbers (no JSON encoding for NaN/Infinity)', () => {
    expect(toAnyValue(Number.NaN)).toEqual({ stringValue: 'NaN' })
    expect(toAnyValue(Number.POSITIVE_INFINITY)).toEqual({ stringValue: 'Infinity' })
    expect(toAnyValue(Number.NEGATIVE_INFINITY)).toEqual({ stringValue: '-Infinity' })
  })

  it('drops null and undefined so the caller omits the attribute', () => {
    expect(toAnyValue(null)).toBeUndefined()
    expect(toAnyValue(undefined)).toBeUndefined()
  })

  it('maps nested objects to kvlistValue, dropping null members', () => {
    expect(toAnyValue({ a: 'x', b: 2, c: null })).toEqual({
      kvlistValue: {
        values: [
          { key: 'a', value: { stringValue: 'x' } },
          { key: 'b', value: { intValue: '2' } },
        ],
      },
    })
  })

  it('maps arrays to arrayValue, preserving positions of null elements', () => {
    expect(toAnyValue(['a', null, 3])).toEqual({
      arrayValue: {
        values: [{ stringValue: 'a' }, { stringValue: 'null' }, { intValue: '3' }],
      },
    })
  })

  it('falls back to a JSON string past the depth cap', () => {
    // 8 levels deep — beyond MAX_ATTR_DEPTH (6).
    const deep = { a: { b: { c: { d: { e: { f: { g: { h: 'bottom' } } } } } } } }
    const value = toAnyValue(deep)
    // Walk down to the level where the cap kicks in; the remainder is a string.
    const json = JSON.stringify(value)
    expect(json).toContain('bottom')
    expect(json).toContain('stringValue')
  })

  it('maps bigint to intValue', () => {
    expect(toAnyValue(123n)).toEqual({ intValue: '123' })
  })
})

// ---------------------------------------------------------------------------
// isoToUnixNano — ISO → nanosecond string
// ---------------------------------------------------------------------------

describe('isoToUnixNano', () => {
  it('converts an ISO timestamp to nanoseconds as a decimal string', () => {
    expect(isoToUnixNano('2026-07-05T00:00:00.000Z')).toBe('1783209600000000000')
  })

  it('keeps full precision past Number.MAX_SAFE_INTEGER', () => {
    // ms * 1e6 here is ~1.75e18, ~195x MAX_SAFE_INTEGER — Number math would
    // round the low digits away. This is the BigInt regression guard.
    const nanos = isoToUnixNano('2026-07-05T00:00:00.123Z')
    expect(nanos).toBe('1783209600123000000')
    expect(Number(nanos)).toBeGreaterThan(Number.MAX_SAFE_INTEGER)
    // Round-trips exactly through BigInt (a Number round-trip would not).
    expect((BigInt(nanos) / 1_000_000n).toString()).toBe('1783209600123')
  })

  it('falls back to now for a missing or unparseable timestamp', () => {
    const now = () => 1_700_000_000_000
    expect(isoToUnixNano(undefined, now)).toBe('1700000000000000000')
    expect(isoToUnixNano('not-a-date', now)).toBe('1700000000000000000')
  })
})

// ---------------------------------------------------------------------------
// buildLogRecord — logger record → OTLP log record
// ---------------------------------------------------------------------------

describe('buildLogRecord', () => {
  it('maps every level to its OTel severity number', () => {
    const expected = { trace: 1, debug: 5, info: 9, warn: 13, error: 17, fatal: 21 } as const
    for (const [level, number] of Object.entries(expected)) {
      const rec = buildLogRecord(level as keyof typeof expected, '', { level })
      expect(rec.severityNumber).toBe(number)
      expect(rec.severityText).toBe(level)
    }
  })

  it('falls back to the rendered line when the record has no msg', () => {
    expect(buildLogRecord('info', 'raw line here', { level: 'info' }).body.stringValue).toBe(
      'raw line here',
    )
  })
})

// ---------------------------------------------------------------------------
// createPostHogLogSink
// ---------------------------------------------------------------------------

describe('createPostHogLogSink', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('is a no-op without an api key (no buffer, no fetch)', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { sink, flush } = createPostHogLogSink({ apiKey: undefined, service: 'svc' })
    sink('error', '{"level":"error"}', { level: 'error', msg: 'boom' })
    await flush()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('forwards info+ and drops below-threshold records (default minLevel=info)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok'))
    vi.stubGlobal('fetch', fetchMock)
    const { sink, flush } = createPostHogLogSink({ apiKey: 'phc_x', service: 'svc' })
    sink('trace', '', { level: 'trace', msg: 'dropped' })
    sink('debug', '', { level: 'debug', msg: 'dropped' })
    sink('info', '', { level: 'info', msg: 'kept-info' })
    sink('warn', '', { level: 'warn', msg: 'kept-warn' })
    sink('error', '', { level: 'error', msg: 'kept-error' })
    sink('fatal', '', { level: 'fatal', msg: 'kept-fatal' })
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(bodies(fetchMock)).toEqual(['kept-info', 'kept-warn', 'kept-error', 'kept-fatal'])
  })

  it('respects a custom minLevel', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok'))
    vi.stubGlobal('fetch', fetchMock)
    const { sink, flush } = createPostHogLogSink({
      apiKey: 'phc_x',
      service: 'svc',
      minLevel: 'error',
    })
    sink('warn', '', { level: 'warn', msg: 'dropped' })
    sink('error', '', { level: 'error', msg: 'kept' })
    await flush()
    expect(bodies(fetchMock)).toEqual(['kept'])
  })

  it('POSTs OTLP to /i/v1/logs with bearer auth and no api_key in the body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok'))
    vi.stubGlobal('fetch', fetchMock)
    const { sink, flush } = createPostHogLogSink({ apiKey: 'phc_x', service: 'svc' })
    sink('error', '', { level: 'error', msg: 'boom' })
    await flush()

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://us.i.posthog.com/i/v1/logs')
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({
      'content-type': 'application/json',
      authorization: 'Bearer phc_x',
    })
    // The token rides the header now — it must not leak into the payload.
    expect(init.body as string).not.toContain('api_key')
  })

  it('stamps service.name, and deployment.environment only when configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok'))
    vi.stubGlobal('fetch', fetchMock)

    const plain = createPostHogLogSink({ apiKey: 'phc_x', service: 'rallypoint-events' })
    plain.sink('error', '', { level: 'error', msg: 'a' })
    await plain.flush()
    expect(resourceAttr(lastPayload(fetchMock), 'service.name')).toBe('rallypoint-events')
    expect(resourceAttr(lastPayload(fetchMock), 'deployment.environment')).toBeUndefined()

    const staged = createPostHogLogSink({
      apiKey: 'phc_x',
      service: 'rallypoint-events',
      environment: 'qa',
    })
    staged.sink('error', '', { level: 'error', msg: 'b' })
    await staged.flush()
    expect(resourceAttr(lastPayload(fetchMock), 'deployment.environment')).toBe('qa')
  })

  it('shapes a log record: timestamp, severity, body, and attributes', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok'))
    vi.stubGlobal('fetch', fetchMock)
    const { sink, flush } = createPostHogLogSink({ apiKey: 'phc_x', service: 'svc' })
    sink('error', '', {
      level: 'error',
      time: '2026-07-05T00:00:00.000Z',
      service: 'svc',
      msg: 'boom',
      requestId: 'r1',
      status: 500,
    })
    await flush()

    const rec = records(fetchMock)[0]!
    expect(rec.timeUnixNano).toBe('1783209600000000000')
    expect(rec.severityText).toBe('error')
    expect(rec.severityNumber).toBe(17)
    expect(rec.body).toEqual({ stringValue: 'boom' })
    expect(attr(rec, 'requestId')).toEqual({ stringValue: 'r1' })
    expect(attr(rec, 'status')).toEqual({ intValue: '500' })
    // Encoded elsewhere (severity / timestamp / body / resource) — not duplicated.
    for (const key of ['level', 'time', 'msg', 'service']) {
      expect(attr(rec, key)).toBeUndefined()
    }
  })

  it('trims a trailing slash from a custom host', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok'))
    vi.stubGlobal('fetch', fetchMock)
    const { sink, flush } = createPostHogLogSink({
      apiKey: 'phc_x',
      host: 'https://eu.i.posthog.com/',
      service: 'svc',
    })
    sink('error', '', { level: 'error' })
    await flush()
    expect(fetchMock.mock.calls[0]![0]).toBe('https://eu.i.posthog.com/i/v1/logs')
  })

  it('enforces the buffer cap, dropping overflow records', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok'))
    vi.stubGlobal('fetch', fetchMock)
    const { sink, flush } = createPostHogLogSink({
      apiKey: 'phc_x',
      service: 'svc',
      maxBuffer: 2,
    })
    sink('error', '', { level: 'error', msg: 'a' })
    sink('error', '', { level: 'error', msg: 'b' })
    sink('error', '', { level: 'error', msg: 'c' }) // dropped
    await flush()
    expect(bodies(fetchMock)).toEqual(['a', 'b'])
  })

  it('flush is a no-op when the buffer is empty (no fetch)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok'))
    vi.stubGlobal('fetch', fetchMock)
    const { flush } = createPostHogLogSink({ apiKey: 'phc_x', service: 'svc' })
    await flush()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('never rejects even when fetch throws, and drops the failed batch', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'))
    vi.stubGlobal('fetch', fetchMock)
    const { sink, flush } = createPostHogLogSink({ apiKey: 'phc_x', service: 'svc' })
    sink('error', '', { level: 'error', msg: 'x' })
    await expect(flush()).resolves.toBeUndefined()
    // Batch was cleared, not retried — a second flush sends nothing.
    fetchMock.mockResolvedValue(new Response('ok'))
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('parses the JSON line when no record object is provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok'))
    vi.stubGlobal('fetch', fetchMock)
    const { sink, flush } = createPostHogLogSink({ apiKey: 'phc_x', service: 'svc' })
    sink('warn', JSON.stringify({ level: 'warn', msg: 'from-line', requestId: 'r9' }))
    await flush()
    const rec = records(fetchMock)[0]!
    expect(rec.body).toEqual({ stringValue: 'from-line' })
    expect(attr(rec, 'requestId')).toEqual({ stringValue: 'r9' })
  })

  it('forwards already-redacted fields end-to-end through the logger', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok'))
    vi.stubGlobal('fetch', fetchMock)
    const { sink, flush } = createPostHogLogSink({ apiKey: 'phc_x', service: 'svc' })
    // Drive the real logger so cloneRedacted runs before the sink.
    const logger = createLogger({ service: 'svc', sink })
    logger.error({ user: { password: 'hunter2', name: 'ok' } }, 'auth failure')
    await flush()

    const rec = records(fetchMock)[0]!
    expect(rec.body).toEqual({ stringValue: 'auth failure' })
    expect(attr(rec, 'user')).toEqual({
      kvlistValue: {
        values: [
          { key: 'password', value: { stringValue: '[REDACTED]' } },
          { key: 'name', value: { stringValue: 'ok' } },
        ],
      },
    })
  })

  it('records logged during an in-flight flush go to the next batch, not the current one', async () => {
    // Gate the first fetch so we can log again while it is still pending.
    let release!: (r: Response) => void
    const gate = new Promise<Response>((res) => {
      release = res
    })
    const fetchMock = vi.fn().mockReturnValueOnce(gate).mockResolvedValue(new Response('ok'))
    vi.stubGlobal('fetch', fetchMock)
    const { sink, flush } = createPostHogLogSink({ apiKey: 'phc_x', service: 'svc' })

    sink('error', '', { level: 'error', msg: 'first' })
    const inFlight = flush() // swaps the buffer out, then awaits the gated fetch
    sink('error', '', { level: 'error', msg: 'second' }) // lands in the fresh buffer
    release(new Response('ok'))
    await inFlight

    const first = payloadAt(fetchMock, 0).scopeLogs[0]!.logRecords
    expect(first.map((r) => r.body.stringValue)).toEqual(['first'])

    await flush()
    const second = payloadAt(fetchMock, 1).scopeLogs[0]!.logRecords
    expect(second.map((r) => r.body.stringValue)).toEqual(['second'])
  })
})

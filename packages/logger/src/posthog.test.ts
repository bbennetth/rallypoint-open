import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_POSTHOG_HOST,
  buildEvent,
  buildExceptionEvent,
  createEventCapture,
  createExceptionCapture,
  errorCauseChain,
  posthogSessionProps,
} from './posthog.js'

describe('buildExceptionEvent', () => {
  it('shapes an Error into a $exception event with service identity', () => {
    const err = new TypeError('boom')
    const event = buildExceptionEvent({ apiKey: 'phc_x', service: 'rallypoint-fitness' }, err, {
      requestId: 'req_1',
    })
    expect(event.api_key).toBe('phc_x')
    expect(event.event).toBe('$exception')
    expect(event.distinct_id).toBe('server:rallypoint-fitness')
    expect(event.properties.$process_person_profile).toBe(false)
    expect(event.properties.service).toBe('rallypoint-fitness')
    expect(event.properties.requestId).toBe('req_1')
    const list = event.properties.$exception_list as Array<{ type: string; value: string }>
    expect(list[0]).toMatchObject({ type: 'TypeError', value: 'boom' })
    expect(event.properties.$exception_stack_trace_raw).toContain('boom')
  })

  it('handles non-Error throwables without a stack property', () => {
    const event = buildExceptionEvent({ apiKey: 'phc_x', service: 'svc' }, 'string failure')
    const list = event.properties.$exception_list as Array<{ type: string; value: string }>
    expect(list[0]).toMatchObject({ type: 'Error', value: 'string failure' })
    expect(event.properties.$exception_stack_trace_raw).toBeUndefined()
  })

  it('folds the cause chain into the exception value and cause property', () => {
    // The drizzle-d1 shape: outer "Failed query: …" wrapper, real D1 text on .cause.
    const err = new Error('Failed query: select "id_hash" from "sessions" …', {
      cause: new Error('D1_ERROR: too many SQL variables at offset 1110: SQLITE_ERROR'),
    })
    const event = buildExceptionEvent({ apiKey: 'phc_x', service: 'svc' }, err)
    const list = event.properties.$exception_list as Array<{ value: string }>
    expect(list[0].value).toContain('Failed query: select')
    expect(list[0].value).toContain('caused by: Error: D1_ERROR: too many SQL variables')
    expect(event.properties.$exception_cause_chain).toEqual([
      'Error: D1_ERROR: too many SQL variables at offset 1110: SQLITE_ERROR',
    ])
  })

  it('omits the cause property for errors without a cause', () => {
    const event = buildExceptionEvent({ apiKey: 'phc_x', service: 'svc' }, new Error('boom'))
    const list = event.properties.$exception_list as Array<{ value: string }>
    expect(list[0].value).toBe('boom')
    expect(event.properties.$exception_cause_chain).toBeUndefined()
  })

  it('carries a caller-passed $session_id through to the event properties', () => {
    const event = buildExceptionEvent({ apiKey: 'phc_x', service: 'svc' }, new Error('boom'), {
      ...posthogSessionProps('sess_abc'),
    })
    expect(event.properties.$session_id).toBe('sess_abc')
  })
})

describe('errorCauseChain', () => {
  it('walks nested Error causes outermost-first', () => {
    const err = new Error('outer', {
      cause: new TypeError('middle', { cause: new Error('root') }),
    })
    expect(errorCauseChain(err)).toEqual(['TypeError: middle', 'Error: root'])
  })

  it('stringifies a non-Error cause and stops there', () => {
    const err = new Error('outer', { cause: 'plain string cause' })
    expect(errorCauseChain(err)).toEqual(['plain string cause'])
  })

  it('bounds a self-referencing cause chain', () => {
    const err = new Error('outer')
    err.cause = err
    expect(errorCauseChain(err)).toHaveLength(5)
  })

  it('returns empty for non-Errors and cause-less errors', () => {
    expect(errorCauseChain('nope')).toEqual([])
    expect(errorCauseChain(new Error('boom'))).toEqual([])
  })
})

describe('posthogSessionProps', () => {
  it('wraps a forwarded session id as $session_id', () => {
    // Real posthog-js session ids are UUIDv7 strings.
    const uuid = '01912345-89ab-7def-8123-456789abcdef'
    expect(posthogSessionProps(uuid)).toEqual({ $session_id: uuid })
    expect(posthogSessionProps('sess_abc9')).toEqual({ $session_id: 'sess_abc9' })
  })

  it('returns an empty bag for an absent or empty header value', () => {
    expect(posthogSessionProps(undefined)).toEqual({})
    expect(posthogSessionProps('')).toEqual({})
  })

  it('discards forged values outside the session-id shape', () => {
    expect(posthogSessionProps('short')).toEqual({}) // under min length
    expect(posthogSessionProps('a'.repeat(65))).toEqual({}) // over max length
    expect(posthogSessionProps('has spaces and $tuff')).toEqual({}) // bad charset
  })
})

describe('buildEvent', () => {
  it('stamps service + defaults person profile off', () => {
    const ev = buildEvent('rallypoint-planner', 'push_delivered', 'user_1', { okCount: 2 })
    expect(ev.event).toBe('push_delivered')
    expect(ev.distinct_id).toBe('user_1')
    expect(ev.properties.service).toBe('rallypoint-planner')
    expect(ev.properties.$process_person_profile).toBe(false)
    expect(ev.properties.okCount).toBe(2)
  })

  it('opts a per-user event into a real person profile', () => {
    const ev = buildEvent('svc', 'push_failed', 'user_2', undefined, { personProfile: true })
    expect(ev.properties.$process_person_profile).toBe(true)
  })
})

describe('createEventCapture', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('is a no-op without an api key (no fetch)', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await createEventCapture({ apiKey: undefined, service: 'svc' })('push_failed', 'user_1')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('POSTs a named event with the api key in the body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok'))
    vi.stubGlobal('fetch', fetchMock)
    await createEventCapture({ apiKey: 'phc_x', service: 'rallypoint-planner' })(
      'push_delivered',
      'user_1',
      { okCount: 1 },
      { personProfile: true },
    )
    expect(fetchMock.mock.calls[0]![0]).toBe(`${DEFAULT_POSTHOG_HOST}/i/v0/e/`)
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)
    expect(body.api_key).toBe('phc_x')
    expect(body.event).toBe('push_delivered')
    expect(body.distinct_id).toBe('user_1')
    expect(body.properties.$process_person_profile).toBe(true)
    expect(body.properties.okCount).toBe(1)
  })

  it('never rejects even when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    const capture = createEventCapture({ apiKey: 'phc_x', service: 'svc' })
    await expect(capture('push_failed', 'user_1')).resolves.toBeUndefined()
  })
})

describe('createExceptionCapture', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('is a no-op without an api key (no fetch)', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const capture = createExceptionCapture({ apiKey: undefined, service: 'svc' })
    await capture(new Error('x'))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('POSTs to the capture endpoint (default host, trailing-slash-safe custom host)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok'))
    vi.stubGlobal('fetch', fetchMock)
    await createExceptionCapture({ apiKey: 'phc_x', service: 'svc' })(new Error('x'))
    expect(fetchMock.mock.calls[0]![0]).toBe(`${DEFAULT_POSTHOG_HOST}/i/v0/e/`)
    await createExceptionCapture({ apiKey: 'phc_x', host: 'https://eu.i.posthog.com/', service: 'svc' })(
      new Error('x'),
    )
    expect(fetchMock.mock.calls[1]![0]).toBe('https://eu.i.posthog.com/i/v0/e/')
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)
    expect(body.event).toBe('$exception')
  })

  it('never rejects even when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    const capture = createExceptionCapture({ apiKey: 'phc_x', service: 'svc' })
    await expect(capture(new Error('x'))).resolves.toBeUndefined()
  })
})

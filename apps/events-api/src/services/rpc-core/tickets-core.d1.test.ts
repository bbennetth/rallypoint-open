import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import { ulid } from 'ulid'
import type { R2Bucket } from '@cloudflare/workers-types'
import { noopRealtimeBus } from '@rallypoint/realtime'
import { createBindingObjectStore } from '@rallypoint/object-store'
import { buildD1Repos, createDb } from '../../repos/d1/index.js'
import { parseEnv, type Env } from '../../env.js'
import type { Repos } from '../../repos/types.js'
import type { Logger } from '../../logger.js'
import type { Services } from '../types.js'
import { makeNoopMoneyClient, makeNoopListsClient } from '../../routes/_test-services.js'
import { createPersonalEventCore } from './personal-events-core.js'
import { createPersonalTicketCore } from './tickets-core.js'
import type { EventsRpcDeps } from './deps.js'

// Integration tests for the personal-ticket magic-byte gate. The RPC core
// is the ONLY upload path for personal tickets (no HTTP route), so unlike
// maps/pwa/avatar it must run matchesDeclaredType itself. Without it a
// ticket declared application/pdf could carry HTML/PNG bytes and be served
// back with the declared content type.

const logger = { info() {}, warn() {}, error() {} } as unknown as Logger

// %PDF magic bytes + filler; passes both the MIME allowlist and the sniff.
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34])
// PNG signature — used to declare application/pdf but ship non-PDF bytes.
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

describe('D1 integration — personal-ticket magic-byte gate', () => {
  let repos: Repos
  let deps: EventsRpcDeps

  beforeAll(() => {
    repos = buildD1Repos(createDb(env.DB))
    const envVars: Env = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
    const services: Services = {
      idClient: {
        verifyRpidBearer: async (bearer: string) => ({ ok: true as const, userId: bearer }),
        signoutRpidBearer: async () => {},
        batchLookupUsers: async () => [],
      },
      rpidSso: { exchange: async () => ({ ok: false as const, reason: 'invalid' as const }) },
      rpidReauth: { verify: async () => ({ ok: true as const }) },
      objectStore: createBindingObjectStore(env.OBJECT_STORE as unknown as R2Bucket),
      listsClient: makeNoopListsClient(),
      moneyClient: makeNoopMoneyClient(),
      weather: {
        getEventWeather: async () => ({
          forecast: null,
          airQuality: null,
          issuedAt: new Date().toISOString(),
        }),
      },
      settings: {
        get: async () => ({}),
        patch: async (_u: string, _n: string, patch: Record<string, unknown>) => patch,
      },
    } as unknown as Services
    deps = { env: envVars, logger, repos, services, realtime: noopRealtimeBus() }
  })

  async function newPersonalEvent(actor: string): Promise<string> {
    const created = await createPersonalEventCore(actor, { name: 'Trip' }, deps)
    return created.id
  }

  it('rejects a file whose bytes do not match the declared content type', async () => {
    const actor = `user_${ulid()}`
    const eventId = await newPersonalEvent(actor)

    const result = await createPersonalTicketCore(
      actor,
      eventId,
      { contentType: 'application/pdf', bytes: PNG_BYTES, fileName: 'fake.pdf' },
      deps,
    )

    expect(result).toEqual({ kind: 'bad_file', reason: 'unsupported_type' })
    // No ticket row persisted for the rejected upload.
    const listed = await repos.personalTickets.listForEvent(eventId)
    expect(listed).toHaveLength(0)
  })

  it('accepts a file whose bytes match the declared content type', async () => {
    const actor = `user_${ulid()}`
    const eventId = await newPersonalEvent(actor)

    const result = await createPersonalTicketCore(
      actor,
      eventId,
      { contentType: 'application/pdf', bytes: PDF_BYTES, fileName: 'real.pdf' },
      deps,
    )

    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.data.contentType).toBe('application/pdf')
      expect(result.data.bytes).toBe(PDF_BYTES.byteLength)
    }
    const listed = await repos.personalTickets.listForEvent(eventId)
    expect(listed).toHaveLength(1)
  })
})

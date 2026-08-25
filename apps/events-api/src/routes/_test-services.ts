// Test-only helpers for the routes' integration tests. Each route's
// .it.test.ts builds a `Services` bag manually; this module provides
// noop stubs for the peer-app clients so a test that doesn't exercise
// a particular client doesn't have to spell out the full interface.
//
// (Production wiring lives in services/index.ts. As of feat/rpc-bindings
// PR 2, the lists/money proxies are narrowed to just what events-api
// consumes — see EventsListsClient / EventsMoneyClient in
// services/types.ts — so these stubs no longer have to implement the
// full @rallypoint/*-client SDK surface.)

import type { ObjectStore } from '@rallypoint/object-store'
import type {
  EventsListsClient,
  EventsMoneyClient,
  EventsMoneyLedgerDto,
} from '../services/types.js'

// Stub ObjectStore — any method call throws with a clear message so a test
// that accidentally exercises upload/serve logic fails loudly rather than
// silently. Tests that DO exercise storage should use the real Miniflare R2
// binding: `import { env } from 'cloudflare:test'` + `createBindingObjectStore(env.OBJECT_STORE)`.
export function makeStubObjectStore(): ObjectStore {
  const fail = (m: string) => async (..._args: unknown[]) => {
    throw new Error(`stub objectStore.${m} called`)
  }
  return {
    put: fail('put') as unknown as ObjectStore['put'],
    get: fail('get') as unknown as ObjectStore['get'],
    headObject: fail('headObject') as unknown as ObjectStore['headObject'],
    deleteObject: fail('deleteObject') as unknown as ObjectStore['deleteObject'],
  }
}

const fakeLedgerFromInput = (input: {
  groupId: string
  ownerUserId: string
  name?: string
  currency?: string
}): EventsMoneyLedgerDto & { created: boolean } => ({
  id: `led_test_${input.groupId}`,
  scopeType: 'group',
  scopeId: input.groupId,
  ownerUserId: input.ownerUserId,
  name: input.name ?? 'Group expenses',
  currency: input.currency ?? 'USD',
  description: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  created: true,
})

// Noop EventsListsClient stub — `listLists` returns []; `listItems`
// throws unless the test supplies its own override.
export function makeNoopListsClient(): EventsListsClient {
  return {
    listLists: async () => [],
    listItems: async (_listId: string, _actor: string) => {
      throw new Error('stub listsClient.listItems called')
    },
  }
}

// Noop EventsMoneyClient stub. ensureGroupLedger returns a deterministic
// fake ledger so the group POST handler can record its activity and
// surface the ledger_id without a real money-api running.
export function makeNoopMoneyClient(): EventsMoneyClient {
  return {
    listLedgers: async () => [],
    ensureGroupLedger: async (input) => fakeLedgerFromInput(input),
    listExpenses: async () => [],
    getBalances: async (ledgerId, viewerUserId) => ({
      ledgerId,
      currency: 'USD',
      viewerUserId,
      items: [],
    }),
  }
}

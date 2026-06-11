// Test-only helpers for the routes' integration tests. Each route's
// .it.test.ts builds a `Services` bag manually; this module provides
// noop stubs for the peer-app clients so a test that doesn't exercise
// a particular client doesn't have to spell out the full interface.
//
// (Production wiring lives in services/index.ts.)

import type { ObjectStore } from '@rallypoint/object-store'
import type { ListsClient } from '@rallypoint/lists-client'
import type { EnsureGroupLedgerResult, MoneyClient } from '@rallypoint/money-client'

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

const fakeLedgerFromInput = (input: { groupId: string; ownerUserId: string; name?: string; currency?: string }): EnsureGroupLedgerResult => ({
  id: `led_test_${input.groupId}`,
  scopeType: 'group',
  scopeId: input.groupId,
  ownerUserId: input.ownerUserId,
  name: input.name ?? 'Group expenses',
  currency: (input.currency ?? 'USD') as EnsureGroupLedgerResult['currency'],
  description: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  created: true,
})

// Noop ListsClient stub — any method call throws unless the test
// supplies its own override (see group-lists.it.test.ts for an
// in-memory implementation).
export function makeNoopListsClient(): ListsClient {
  const fail = (label: string) => async () => {
    throw new Error(`stub listsClient.${label} called`)
  }
  return {
    health: async () => ({ status: 'stub' }),
    listLists: async () => [],
    listItems: fail('listItems') as unknown as ListsClient['listItems'],
    listFieldDefs: fail('listFieldDefs') as unknown as ListsClient['listFieldDefs'],
    listGroups: fail('listGroups') as unknown as ListsClient['listGroups'],
    createGroup: fail('createGroup') as unknown as ListsClient['createGroup'],
    createList: fail('createList') as unknown as ListsClient['createList'],
    deleteList: fail('deleteList') as unknown as ListsClient['deleteList'],
    createListItem: fail('createListItem') as unknown as ListsClient['createListItem'],
    updateListItem: fail('updateListItem') as unknown as ListsClient['updateListItem'],
    deleteListItem: fail('deleteListItem') as unknown as ListsClient['deleteListItem'],
    createListItemSeries: fail('createListItemSeries') as unknown as ListsClient['createListItemSeries'],
    listSeries: fail('listSeries') as unknown as ListsClient['listSeries'],
    updateSeries: fail('updateSeries') as unknown as ListsClient['updateSeries'],
    deleteSeries: fail('deleteSeries') as unknown as ListsClient['deleteSeries'],
    createFieldDef: fail('createFieldDef') as unknown as ListsClient['createFieldDef'],
    updateFieldDef: fail('updateFieldDef') as unknown as ListsClient['updateFieldDef'],
    deleteFieldDef: fail('deleteFieldDef') as unknown as ListsClient['deleteFieldDef'],
    setListPlannerPref: fail('setListPlannerPref') as unknown as ListsClient['setListPlannerPref'],
    listPlannerLists: fail('listPlannerLists') as unknown as ListsClient['listPlannerLists'],
  }
}

// Noop MoneyClient stub. ensureGroupLedger returns a deterministic
// fake ledger so the group POST handler can record its activity and
// surface the ledger_id without a real money-api running.
export function makeNoopMoneyClient(): MoneyClient {
  return {
    health: async () => ({ status: 'stub' }),
    listLedgers: async () => [],
    ensureGroupLedger: async (input) => fakeLedgerFromInput(input),
    listExpenses: async () => [],
    getBalances: async (ledgerId, viewerUserId) => ({
      ledgerId,
      currency: 'USD' as const,
      viewerUserId,
      items: [],
    }),
  }
}

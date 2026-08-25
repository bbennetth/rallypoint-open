import type { Service } from '@cloudflare/workers-types'
import type { ListsRPC } from '@rallypoint/lists-api'
import type { EventsListsClient } from './types.js'
import type { RpcReturn } from './_rpc.js'

// events-api → lists-api `Service<ListsRPC>` proxy. Narrow surface: just
// `listLists` + `listItems` for the group-lists BFF read (#84). Both
// methods translate the producer's discriminated result onto the
// flat shape the route handlers expect. `RpcReturn` casts back to the
// entrypoint's internal return type — see _rpc.ts.

export function createListsClientService(binding: Service<ListsRPC>): EventsListsClient {
  return {
    async listLists(scope, actor) {
      return (await binding.listLists(actor, scope.scopeType, scope.scopeId)) as RpcReturn<
        ListsRPC['listLists']
      >
    },
    async listItems(listId, actor) {
      const result = (await binding.listItems(actor, listId)) as RpcReturn<ListsRPC['listItems']>
      if (result.kind !== 'ok') {
        // Translate to the legacy "empty list when not found" semantic the
        // BFF read assumes — the group membership check already happened
        // upstream, so a `list_not_found` here means the list was
        // soft-deleted between calls; return [] rather than throwing.
        return []
      }
      return result.data
    },
  }
}

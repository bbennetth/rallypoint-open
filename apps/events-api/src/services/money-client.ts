import type { Service } from '@cloudflare/workers-types'
import type { MoneyRPC } from '@rallypoint/money-api'
import type { EventsMoneyClient } from './types.js'
import type { RpcReturn } from './_rpc.js'

// events-api → money-api `Service<MoneyRPC>` proxy. Narrow surface for
// the per-group ledger auto-attach + BFF read (design §8). The producer
// returns flat camelCase DTOs already; the only translation is
// expanding the `Ok<T> | { kind: 'not_found' }` discriminator into the
// shapes the BFF read expects (`[]` / a synthesized empty balance row
// when the ledger or viewer membership is missing — same anti-enum
// posture as the legacy HTTP route).

export function createMoneyClientService(binding: Service<MoneyRPC>): EventsMoneyClient {
  return {
    async listLedgers(scope) {
      return (await binding.listLedgers(scope.scopeType, scope.scopeId)) as RpcReturn<
        MoneyRPC['listLedgers']
      >
    },
    async ensureGroupLedger(input) {
      // Translate legacy `groupId` → producer's `scopeId` (same value,
      // different field name — the SDK kept `groupId` because money-api
      // stores it opaquely under `scope_id` with `scope_type='group'`).
      const result = (await binding.ensureGroupLedger({
        scopeId: input.groupId,
        ownerUserId: input.ownerUserId,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.currency !== undefined ? { currency: input.currency } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
      })) as RpcReturn<MoneyRPC['ensureGroupLedger']>
      return result
    },
    async listExpenses(ledgerId, viewerUserId) {
      const result = (await binding.listExpenses(ledgerId, viewerUserId)) as RpcReturn<
        MoneyRPC['listExpenses']
      >
      if (result.kind !== 'ok') return []
      return result.data
    },
    async getBalances(ledgerId, viewerUserId) {
      const result = (await binding.getBalances(ledgerId, viewerUserId)) as RpcReturn<
        MoneyRPC['getBalances']
      >
      if (result.kind !== 'ok') {
        return { ledgerId, currency: 'USD', viewerUserId, items: [] }
      }
      return result.data
    },
  }
}

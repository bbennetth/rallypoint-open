/// <reference types="@cloudflare/workers-types" />
import { WorkerEntrypoint } from 'cloudflare:workers'
import { ensureDeps, type WorkerEnv } from './worker.js'
import {
  ensureGroupLedgerCore,
  getBalancesCore,
  listExpensesCore,
  listLedgersCore,
  type BalanceDto,
  type EnsureGroupLedgerInput,
  type EnsureGroupLedgerResult,
  type ExpenseDto,
  type LedgerDto,
  type LedgerNotFound,
  type MoneyRpcDeps,
  type Ok,
} from './services/rpc-core.js'

// Cross-Worker RPC entrypoint for money-api (PR 1 of feat/rpc-bindings).
//
// Consumers (events-api) bind:
//   [[services]]
//   binding = "MONEY"
//   service = "rallypoint-money"
//   entrypoint = "MoneyRPC"
//
// and call `env.MONEY.listLedgers(...)` etc. directly — no Bearer
// header, no MONEY_API_KEY. The methods delegate to the *Core fns in
// `services/rpc-core.ts`, which the legacy `routes/sdk-money.ts` HTTP
// handlers also call. The two surfaces stay in lockstep until PR 3
// deletes the HTTP routes and the API-key middleware.

export class MoneyRPC extends WorkerEntrypoint<WorkerEnv> {
  async listLedgers(scopeType: string, scopeId: string): Promise<LedgerDto[]> {
    return listLedgersCore(scopeType, scopeId, this.deps)
  }

  async ensureGroupLedger(input: EnsureGroupLedgerInput): Promise<EnsureGroupLedgerResult> {
    return ensureGroupLedgerCore(input, this.deps)
  }

  async listExpenses(
    ledgerId: string,
    viewerUserId: string,
  ): Promise<Ok<ExpenseDto[]> | LedgerNotFound> {
    return listExpensesCore(ledgerId, viewerUserId, this.deps)
  }

  async getBalances(
    ledgerId: string,
    viewerUserId: string,
  ): Promise<Ok<BalanceDto> | LedgerNotFound> {
    return getBalancesCore(ledgerId, viewerUserId, this.deps)
  }

  private get deps(): MoneyRpcDeps {
    const d = ensureDeps(this.env)
    return { env: d.env, logger: d.logger, repos: d.repos }
  }
}

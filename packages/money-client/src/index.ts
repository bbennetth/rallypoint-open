// @rallypoint/money-client — typed client SDK for the Rallypoint Money
// SDK API surface (`/api/v1/sdk/money/**`). Consumed by events-api (to
// auto-attach a default ledger to every group + render per-group ledgers
// inside Events) and third parties.
//
// The SDK namespace authenticates with a bearer key
// (`Authorization: Bearer <apiKey>`) and does NOT send cookies — see
// docs/design/api-namespaces-cors.md.

import type { MoneyScopeType, Currency } from '@rallypoint/money-shared'

export type { MoneyScopeType, Currency }

// Wire shape of a ledger row returned by the SDK. Flat camelCase
// mirroring apps/money-api/src/routes/sdk-money.ts serializeLedgerDto.
export interface LedgerDto {
  id: string
  scopeType: MoneyScopeType
  scopeId: string
  ownerUserId: string
  name: string
  currency: Currency
  description: string | null
  createdAt: string
  updatedAt: string
}

export interface ExpenseSplitDto {
  userId: string
  amountCents: number | null
  shareWeight: number | null
}

export interface ExpenseDto {
  id: string
  ledgerId: string
  paidByUserId: string
  totalCents: number
  description: string
  splitMode: 'equal' | 'by_share' | 'by_amount'
  categoryId: string | null
  ref: string | null
  spentAt: string
  createdAt: string
  updatedAt: string
  splits: ExpenseSplitDto[]
}

export interface BalanceItemDto {
  userId: string
  netCents: number
}

export interface BalanceDto {
  ledgerId: string
  currency: Currency
  viewerUserId: string
  // Positive = that user owes the viewer; negative = viewer owes them.
  items: BalanceItemDto[]
}

// Response from `ensureGroupLedger`. `created` distinguishes a fresh
// insert (201) from a returned-existing match (200) so callers can
// suppress duplicate activity log entries.
export interface EnsureGroupLedgerResult extends LedgerDto {
  created: boolean
}

export interface MoneyClientConfig {
  // Base origin of money-api, e.g. https://money.rallypt.app or
  // http://localhost:8083. No trailing slash required.
  baseUrl: string
  // SDK bearer key minted by money-api.
  apiKey: string
  // Optional fetch override (tests / non-browser runtimes).
  fetch?: typeof fetch
}

// Thrown for any non-2xx response; carries the parsed error envelope
// (docs/design/error-shape.md) when present.
export class MoneyClientError extends Error {
  readonly status: number
  readonly code: string
  readonly details?: unknown
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'MoneyClientError'
    this.status = status
    this.code = code
    this.details = details
  }
}

export interface EnsureGroupLedgerInput {
  // group_id from the Events app — money-api stores this opaquely as
  // scope_id with scope_type='group'.
  groupId: string
  // The user who owns the new ledger if one is minted. Ignored when
  // an existing ledger is returned.
  ownerUserId: string
  // Optional overrides applied only on first-create.
  name?: string
  currency?: Currency
  description?: string
}

export interface MoneyClient {
  health(): Promise<{ status: string }>
  // List non-deleted ledgers matching a scope. Oldest first, so a
  // group's "default" ledger is items[0].
  listLedgers(scope: {
    scopeType: MoneyScopeType
    scopeId: string
  }): Promise<LedgerDto[]>
  // Find-or-create the default ledger for a group. Idempotent on
  // (scope_type='group', scopeId) — replays return the same row.
  ensureGroupLedger(input: EnsureGroupLedgerInput): Promise<EnsureGroupLedgerResult>
  listExpenses(ledgerId: string): Promise<ExpenseDto[]>
  getBalances(ledgerId: string, viewerUserId: string): Promise<BalanceDto>
}

export function createMoneyClient(config: MoneyClientConfig): MoneyClient {
  const base = config.baseUrl.replace(/\/$/, '')
  const doFetch = config.fetch ?? globalThis.fetch

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await res.text()
    const json: unknown = text ? JSON.parse(text) : {}
    if (!res.ok) {
      const env = (json as { error?: { code?: string; message?: string; details?: unknown } })
        .error
      throw new MoneyClientError(
        res.status,
        env?.code ?? 'unknown_error',
        env?.message ?? `Request failed with status ${res.status}`,
        env?.details,
      )
    }
    return json as T
  }

  return {
    health() {
      return request<{ status: string }>('GET', '/api/v1/health')
    },
    listLedgers(scope) {
      const qs = new URLSearchParams({
        scope_type: scope.scopeType,
        scope_id: scope.scopeId,
      })
      return request<LedgerDto[]>('GET', `/api/v1/sdk/money/ledgers?${qs.toString()}`)
    },
    ensureGroupLedger(input) {
      return request<EnsureGroupLedgerResult>(
        'POST',
        '/api/v1/sdk/money/ledgers/ensure-for-group',
        {
          scopeId: input.groupId,
          ownerUserId: input.ownerUserId,
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.currency !== undefined ? { currency: input.currency } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
        },
      )
    },
    listExpenses(ledgerId) {
      return request<ExpenseDto[]>(
        'GET',
        `/api/v1/sdk/money/ledgers/${encodeURIComponent(ledgerId)}/expenses`,
      )
    },
    getBalances(ledgerId, viewerUserId) {
      const qs = new URLSearchParams({ viewer_user_id: viewerUserId })
      return request<BalanceDto>(
        'GET',
        `/api/v1/sdk/money/ledgers/${encodeURIComponent(ledgerId)}/balances?${qs.toString()}`,
      )
    },
  }
}

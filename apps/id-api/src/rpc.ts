/// <reference types="@cloudflare/workers-types" />
import { WorkerEntrypoint } from 'cloudflare:workers'
import type { UserInfo } from '@rallypoint/shared'
import type { AppApiKeyClient } from './context.js'
import { ensureDeps, type WorkerEnv } from './worker.js'
import {
  batchLookupUsersCore,
  listDeletedUserIdsCore,
  exchangeSsoCodeCore,
  getSettingsCore,
  patchSettingsCore,
  reauthPasswordCore,
  signoutSessionCore,
  verifySessionCore,
  type CoreCaller,
  type IdRpcDeps,
  type ReauthResult,
  type SettingsAccessDenied,
  type SettingsOk,
  type SsoExchangeResult,
  type UserBatchEntry,
} from './services/rpc-core/index.js'

// Cross-Worker RPC entrypoint for id-api (PR 1 of feat/rpc-bindings).
//
// Consumers (events-api, lists-api, money-api, planner-api, lists-mcp)
// bind this class via:
//
//   [[services]]
//   binding = "RPID"
//   service = "rallypoint-id"
//   entrypoint = "IdRPC"
//
// and call `env.RPID.verifySession(token)` etc. directly — no Bearer
// header, no Authorization. The trust boundary is the binding itself:
// the Cloudflare runtime authenticates the call as same-account, so the
// shared `*_API_KEY` secret becomes redundant and is removed in PR 3.
//
// Each method extracts no business logic of its own — it delegates to
// the `*Core` fns in `services/rpc-core/`, which the legacy HTTP
// handlers also call. That keeps the two surfaces in lockstep until the
// HTTP routes are deleted in PR 3.

// Caller-supplied context every write-shaped method takes. The HTTP
// handlers fill these from the incoming Request; RPC consumers pass the
// *user's* IP/UA + their own app-client identifier so id-api's audit
// rows attribute the action correctly. All fields are optional — when
// absent, audit hashes degrade to placeholder values rather than failing.
export interface RpcCallerContext {
  ip?: string
  userAgent?: string
  client?: AppApiKeyClient
}

export class IdRPC extends WorkerEntrypoint<WorkerEnv> {
  // --- Session ---------------------------------------------------------

  async verifySession(token: string): Promise<UserInfo | null> {
    return verifySessionCore(token, this.deps)
  }

  async signoutSession(token: string, caller?: RpcCallerContext): Promise<void> {
    await signoutSessionCore(token, 'bearer', this.deps, this.caller(caller))
  }

  async reauthPassword(
    userId: string,
    password: string,
    caller?: RpcCallerContext,
  ): Promise<ReauthResult> {
    return reauthPasswordCore(userId, password, this.deps, this.caller(caller))
  }

  // --- SSO -------------------------------------------------------------

  async exchangeSsoCode(
    code: string,
    caller: RpcCallerContext,
  ): Promise<SsoExchangeResult> {
    return exchangeSsoCodeCore(code, this.deps, this.caller(caller))
  }

  // --- User batch ------------------------------------------------------

  async batchLookupUsers(
    userIds: string[],
    caller: RpcCallerContext,
  ): Promise<UserBatchEntry[]> {
    return batchLookupUsersCore(userIds, this.deps, this.caller(caller))
  }

  // Ids of soft-deleted users, for downstream data owners' deletion
  // sweeps (today: ai-api purging its per-user AI traces). Bare ids, no
  // PII; requires a named app client like every other IdRPC method.
  async listDeletedUserIds(caller: RpcCallerContext): Promise<string[]> {
    return listDeletedUserIdsCore(this.deps, this.caller(caller))
  }

  // --- Settings --------------------------------------------------------

  async getSettings(
    userId: string,
    namespace: string,
    caller: RpcCallerContext,
  ): Promise<SettingsOk | SettingsAccessDenied> {
    return getSettingsCore(userId, namespace, this.deps, this.caller(caller))
  }

  async patchSettings(
    userId: string,
    namespace: string,
    patch: Record<string, unknown>,
    caller: RpcCallerContext,
  ): Promise<SettingsOk | SettingsAccessDenied> {
    return patchSettingsCore(userId, namespace, patch, this.deps, this.caller(caller))
  }

  // --- Internals -------------------------------------------------------

  // Build the deps view of the isolate singleton. `this.env` is the
  // workerd-injected WorkerEnv for this RPC call; ensureDeps memoises
  // across calls in the same isolate.
  private get deps(): IdRpcDeps {
    const d = ensureDeps(this.env)
    return {
      env: d.env,
      logger: d.logger,
      repos: d.repos,
      services: d.services,
      passwordHasher: d.passwordHasher,
      sessionCache: d.sessionCache,
    }
  }

  private caller(c?: RpcCallerContext): CoreCaller {
    return {
      ip: c?.ip ?? null,
      userAgent: c?.userAgent ?? null,
      ...(c?.client ? { callerClient: c.client } : {}),
    }
  }
}

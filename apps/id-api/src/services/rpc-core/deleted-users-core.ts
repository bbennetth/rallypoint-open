import type { CoreCaller, IdRpcDeps } from './deps.js'

// Deleted-users listing core. Downstream data owners (today: ai-api's
// daily deletion sweep) call this to learn which accounts are
// soft-deleted so they can purge their own per-user data. Returns bare
// ids only — no PII — but still requires a named app client so the
// lookups stay attributable, matching batchLookupUsersCore.

export async function listDeletedUserIdsCore(
  deps: IdRpcDeps,
  caller: CoreCaller,
): Promise<string[]> {
  if (!caller.callerClient) {
    deps.logger.warn('listDeletedUserIds called without an app client — denying')
    return []
  }
  return deps.repos.users.listDeletedIds()
}

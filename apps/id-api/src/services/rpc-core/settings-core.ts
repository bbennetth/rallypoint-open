import type { UserId } from '@rallypoint/shared'
import { canAccessNamespace } from '../../lib/settings-access.js'
import type { CoreCaller, IdRpcDeps } from './deps.js'

// User settings store core. The HTTP `/api/v1/sdk/settings/:ns` routes
// and the IdRPC `getSettings` / `patchSettings` methods both call these.
// Per-app namespace access (canAccessNamespace) is enforced here, so
// neither caller can bypass it by forgetting a middleware.

export type SettingsAccessDenied = { kind: 'forbidden' }
export type SettingsOk = { kind: 'ok'; settings: Record<string, unknown> }
export type SettingsResult = SettingsOk | SettingsAccessDenied

export async function getSettingsCore(
  userId: string,
  namespace: string,
  deps: IdRpcDeps,
  caller: CoreCaller,
): Promise<SettingsResult> {
  if (!caller.callerClient || !canAccessNamespace(caller.callerClient, namespace)) {
    return { kind: 'forbidden' }
  }
  const doc = await deps.repos.settings.get(userId as UserId, namespace)
  return { kind: 'ok', settings: doc ?? {} }
}

export async function patchSettingsCore(
  userId: string,
  namespace: string,
  patch: Record<string, unknown>,
  deps: IdRpcDeps,
  caller: CoreCaller,
): Promise<SettingsResult> {
  if (!caller.callerClient || !canAccessNamespace(caller.callerClient, namespace)) {
    return { kind: 'forbidden' }
  }
  const merged = await deps.repos.settings.merge(userId as UserId, namespace, patch)
  return { kind: 'ok', settings: merged }
}

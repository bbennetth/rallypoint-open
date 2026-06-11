import { SHARED_SETTINGS_NAMESPACE } from '@rallypoint/shared'

// Namespace access rule for the generic settings store. A request bound
// to app client `client` may target settings namespace `namespace` iff:
//   - `namespace === client`            (its own private settings bag)
//   - `namespace === 'shared'`          (the cross-app bag, e.g. theme)
// Any other namespace is forbidden — this is what keeps one app's
// private settings out of another app's reach while still letting all
// apps cooperate on the shared bag.
export function canAccessNamespace(client: string, namespace: string): boolean {
  return namespace === client || namespace === SHARED_SETTINGS_NAMESPACE
}

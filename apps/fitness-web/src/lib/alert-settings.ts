// Rest-alert preference (off / sound / sound+notification). Thin
// wrapper over the shared createPersistedSetting factory — RPID
// 'fitness' namespace key `restAlerts`, hydrated at session boot,
// written through the persister registered in main.tsx.

import { createPersistedSetting } from './persisted-setting.js'
import {
  downgradedAlertsMode,
  sanitizeRestAlertsMode,
  type NotificationPermissionState,
  type RestAlertsMode,
} from './rest-alerts.js'

const store = createPersistedSetting<RestAlertsMode>({
  name: 'rp-fitness-rest-alerts',
  sanitize: sanitizeRestAlertsMode,
})

export const registerRestAlertsPersister = store.registerPersister
export const hydrateRestAlertsFromServer = store.hydrateFromServer
export const useRestAlertsMode = store.useValue
export const setRestAlertsMode = store.set

/** Current browser permission, folding "no Notification API at all"
 *  (non-installed iOS Safari, some webviews) into one state. */
export function notificationPermissionState(): NotificationPermissionState {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission
}

/** Re-align the persisted mode with live browser permission: 'notify'
 *  with permission revoked out-of-band silently no-ops every alert, so
 *  downgrade it to 'sound' (decision + tests in rest-alerts.ts). Call
 *  on live-session mount and when the tab regains visibility. */
export function syncRestAlertsWithPermission(): void {
  const next = downgradedAlertsMode(store.get(), notificationPermissionState())
  if (next !== store.get()) store.set(next)
}

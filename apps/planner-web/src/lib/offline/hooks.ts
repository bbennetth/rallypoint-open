// Planner instance of the shared React glue (E4 O4): useOfflineSync
// wires connectivity/visibility/SW listeners to the engine, and
// purgeOfflineUser is the sign-out hygiene helper. Mechanics live in
// @rallypoint/offline-kit.

import { createOfflineHooks } from '@rallypoint/offline-kit'
import { engine } from './engine.js'
import { purgeUserDb } from './db.js'

const hooks = createOfflineHooks({
  engine,
  purgeUserDb,
  swMessageType: 'planner-outbox-replay',
})

export const useOfflineSync = hooks.useOfflineSync
export const purgeOfflineUser = hooks.purgeOfflineUser

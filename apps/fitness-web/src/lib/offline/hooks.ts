// Fitness instance of the shared React glue: useOfflineSync wires
// connectivity/visibility/SW listeners to the engine, and
// purgeOfflineUser is the sign-out hygiene helper.

import { createOfflineHooks } from '@rallypoint/offline-kit'
import { engine } from './engine.js'
import { purgeUserDb } from './db.js'

const hooks = createOfflineHooks({
  engine,
  purgeUserDb,
  // fitness-web's SW has no background-sync replay hook today; the
  // online/visibility listeners cover reconnect flushes. The type string
  // is reserved so a future SW hook can post it without a kit change.
  swMessageType: 'fitness-outbox-replay',
})

export const useOfflineSync = hooks.useOfflineSync
export const purgeOfflineUser = hooks.purgeOfflineUser

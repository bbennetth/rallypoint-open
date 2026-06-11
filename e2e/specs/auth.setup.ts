import { test as setup } from '@playwright/test'
import { signInViaSso } from '../helpers/auth.js'
import { STORAGE_STATE } from '../helpers/paths.js'

// Setup project: sign in once via the full SSO flow and persist the
// resulting cookies so the data-heavy specs can skip the slow Mailpit
// dance. The golden-path and signout specs deliberately do NOT reuse
// this — they exercise / tear down their own sessions.
setup('authenticate demo user', async ({ page }) => {
  await signInViaSso(page)
  await page.context().storageState({ path: STORAGE_STATE })
})

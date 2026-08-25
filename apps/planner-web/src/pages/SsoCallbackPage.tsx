import { SsoCallbackPage as SharedSsoCallbackPage } from '@rallypoint/web-kit'
import { exchangeSso } from '../lib/api.js'
import { clearStateCookie } from '../lib/session.js'

// Thin wrapper over @rallypoint/web-kit's shared SsoCallbackPage (R2 dedup).
// The exchange / redirect / error logic + render live in web-kit; this only
// binds the planner redirect target, display name, and exchange/cookie helpers.
export function SsoCallbackPage() {
  return (
    <SharedSsoCallbackPage
      appName="Planner"
      defaultRedirect="/me"
      exchangeSso={exchangeSso}
      clearStateCookie={clearStateCookie}
    />
  )
}

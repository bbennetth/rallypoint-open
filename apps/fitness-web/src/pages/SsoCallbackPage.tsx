import { SsoCallbackPage as SharedSsoCallbackPage } from '@rallypoint/web-kit'
import { exchangeSso } from '../lib/api.js'
import { clearStateCookie } from '../lib/session.js'

// Thin wrapper over @rallypoint/web-kit's shared SsoCallbackPage (R2 dedup).
// The exchange / redirect / error logic + render live in web-kit; this only
// binds the fitness redirect target, display name, and exchange/cookie helpers.
// mainPadding keeps this standalone route's gutter — the mobile .page-pad
// override zeroes the class padding.
export function SsoCallbackPage() {
  return (
    <SharedSsoCallbackPage
      appName="Health"
      defaultRedirect="/me"
      exchangeSso={exchangeSso}
      clearStateCookie={clearStateCookie}
      mainPadding="20px 16px"
    />
  )
}

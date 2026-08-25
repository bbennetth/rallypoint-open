import { useEffect, useState } from 'react'
import { Button } from '@rallypoint/ui'
import { api } from '../api/client.js'
import { isPasskeySupported, signInWithPasskey } from '../lib/webauthn.js'
import { providerMeta } from './provider-icons.js'

// Social + passkey sign-in options shown above the email/password form on
// the sign-in and sign-up pages. Renders nothing when no provider is
// configured and passkeys are unsupported, so the email form stands alone.

export function AuthAlternatives({
  returnTo,
  onError,
  showPasskey = false,
}: {
  returnTo: string
  onError: (message: string) => void
  showPasskey?: boolean
}) {
  const [providers, setProviders] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void api.get<{ providers: string[] }>('/api/v1/ui/oauth/providers').then((r) => {
      if (!cancelled && r.ok) setProviders(r.data.providers)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const passkey = showPasskey && isPasskeySupported()
  if (!passkey && providers.length === 0) return null

  async function onPasskey() {
    setBusy(true)
    onError('')
    const res = await signInWithPasskey()
    setBusy(false)
    if (!res.ok) {
      onError(res.error?.message ?? 'Passkey sign-in failed.')
      return
    }
    // Cookie is set by the API; jump to the post-login destination.
    window.location.assign(returnTo)
  }

  function startSocial(slug: string) {
    window.location.href = `/api/v1/oauth/${slug}/start?returnTo=${encodeURIComponent(returnTo)}`
  }

  return (
    <div className="mb-6 space-y-3">
      {passkey ? (
        <Button type="button" variant="ghost" loading={busy} onClick={() => void onPasskey()}>
          Sign in with a passkey
        </Button>
      ) : null}
      {providers.map((slug) => {
        const meta = providerMeta(slug)
        if (!meta) return null
        const { label, Icon } = meta
        return (
          <Button key={slug} type="button" variant="ghost" onClick={() => startSocial(slug)}>
            <span className="inline-flex items-center justify-center gap-2">
              <Icon /> Continue with {label}
            </span>
          </Button>
        )
      })}
      <div className="flex items-center gap-3 pt-1 text-xs text-[color:var(--ink-dim)]">
        <span className="h-px flex-1" style={{ background: 'var(--line)' }} />
        or
        <span className="h-px flex-1" style={{ background: 'var(--line)' }} />
      </div>
    </div>
  )
}

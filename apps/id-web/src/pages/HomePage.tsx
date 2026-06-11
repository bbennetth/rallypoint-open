import { Link, useNavigate } from 'react-router-dom'
import { Banner, AppChrome as SharedAppChrome, AppSwitcher, UserMenu } from '@rallypoint/ui'
import { resetAnalytics } from '@rallypoint/web-kit'
import { useSessionClient } from '../auth/useSessionClient.js'
import { AuthCard } from '../ui/AuthCard.js'
import { AppLauncher } from '../ui/AppLauncher.js'
import { api } from '../api/client.js'

// RPID Web v2 landing (#189). Session-aware: signed-in users get the
// app launcher wrapped in the shared Ink AppChrome; everyone else gets
// the marketing card with Sign in / Create account links.

const LAUNCHER_NAV = [] as const

export function HomePage() {
  const { status, user, error, refetch } = useSessionClient()
  const navigate = useNavigate()

  async function handleSignout() {
    await api.post('/api/v1/ui/signout')
    resetAnalytics()
    navigate('/signin')
  }

  if (status === 'loading') {
    return (
      <AuthCard title="Loading…">
        <Banner tone="info">Checking your session.</Banner>
      </AuthCard>
    )
  }

  if (status === 'error') {
    return (
      <AuthCard
        title="Couldn't reach Rallypoint ID"
        footer={
          <button type="button" className="underline" onClick={refetch}>
            Try again
          </button>
        }
      >
        <Banner tone="error">{error ?? 'Unknown error.'}</Banner>
      </AuthCard>
    )
  }

  if (status === 'authenticated') {
    // useSessionClient guarantees a non-null user when authenticated.
    const profile = {
      picture_url: user!.picture,
      username: user!.name,
      first_name: user!.first_name,
      last_name: user!.last_name,
      email: user!.email,
    }
    return (
      <SharedAppChrome
        nav={LAUNCHER_NAV}
        subLabel="Account"
        brand={({ size, showToast }) => (
          <AppSwitcher
            current="id"
            size={size}
            onToast={showToast}
            onSignout={handleSignout}
            appVersion={import.meta.env.VITE_APP_VERSION}
          />
        )}
        userMenu={({ size }) => (
          <UserMenu
            size={size}
            profile={profile}
            onSignout={handleSignout}
          />
        )}
      >
        <AppLauncher />
      </SharedAppChrome>
    )
  }

  return (
    <AuthCard
      title="Rallypoint ID"
      subtitle="One identity for every Rallypoint app."
      footer={
        <span>
          <Link to="/signin" className="underline" style={{ color: 'var(--ink-dim)' }}>
            Sign in
          </Link>
          {' · '}
          <Link to="/signup" className="underline" style={{ color: 'var(--ink-dim)' }}>
            Create account
          </Link>
        </span>
      }
    >
      <p className="text-sm" style={{ color: 'var(--ink-dim)' }}>
        Self-hostable, open-source identity service. Built for the Rallypoint platform.
      </p>
    </AuthCard>
  )
}

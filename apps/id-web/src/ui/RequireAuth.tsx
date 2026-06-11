import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import type { UserInfo } from '@rallypoint/shared'
import { useSessionClient } from '../auth/useSessionClient.js'
import { AuthCard } from './AuthCard.js'
import { Banner } from '@rallypoint/ui'

// Gate component for /account/* routes. While the session check
// is in flight, render a loading card. If unauthenticated, send
// the user to /signin?returnTo=<current>. If errored (server
// reachable but 5xx), surface the error with a retry.

export interface RequireAuthProps {
  children: (user: UserInfo) => ReactNode
}

export function RequireAuth({ children }: RequireAuthProps) {
  const { status, user, error, refetch } = useSessionClient()
  const loc = useLocation()

  if (status === 'loading') {
    return (
      <AuthCard title="Loading…">
        <Banner tone="info">Checking your session.</Banner>
      </AuthCard>
    )
  }
  if (status === 'unauthenticated') {
    const returnTo = encodeURIComponent(loc.pathname + loc.search)
    return <Navigate to={`/signin?returnTo=${returnTo}`} replace />
  }
  if (status === 'error') {
    return (
      <AuthCard
        title="Couldn't load your account"
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
  return <>{children(user!)}</>
}

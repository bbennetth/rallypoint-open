import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { AppBrandLockup } from '@rallypoint/ui'
import { ThemeToggle } from './ThemeToggle.js'

// Shared layout shell for every auth page. Centered Ink card on the
// themed background, brand mark + theme toggle at the top, optional
// footer slot for "← back to sign in" / etc.

export interface AuthCardProps {
  title: string
  subtitle?: string
  children: ReactNode
  footer?: ReactNode
}

export function AuthCard({ title, subtitle, children, footer }: AuthCardProps) {
  return (
    <div
      className="page-pad"
      style={{
        minHeight: '100dvh',
        background: 'var(--bg)',
        color: 'var(--ink)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div style={{ width: '100%', maxWidth: '28rem', display: 'grid', gap: 24 }}>
        <header className="flex items-center justify-between gap-4">
          <Link
            to="/"
            style={{
              textDecoration: 'none',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 9,
            }}
          >
            <AppBrandLockup size="desktop" />
          </Link>
          <ThemeToggle />
        </header>

        <main
          className="p-6 space-y-1"
          style={{
            border: '1px solid var(--line)',
            background: 'var(--bg)',
            borderRadius: 16,
          }}
        >
          <p className="text-xs" style={{ color: 'var(--ink-dim)' }}>Rallypoint ID</p>
          <h1 className="display text-2xl" style={{ marginTop: 4 }}>
            {title}
          </h1>
          {subtitle ? (
            <p className="text-sm" style={{ color: 'var(--ink-dim)', marginTop: 4, marginBottom: 16 }}>
              {subtitle}
            </p>
          ) : (
            <div style={{ marginBottom: 16 }} />
          )}
          {children}
        </main>

        {footer ? (
          <footer className="text-center text-sm" style={{ color: 'var(--ink-dim)' }}>{footer}</footer>
        ) : null}
      </div>
    </div>
  )
}

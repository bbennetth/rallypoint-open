// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { UserMenu } from './UserMenu.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const profile = { username: 'Ada', email: 'ada@example.com' }

describe('UserMenu — Account entry', () => {
  it('hides the Account item when neither accountUrl nor onAccount is set', () => {
    render(<UserMenu profile={profile} />)
    fireEvent.click(screen.getByRole('button', { name: 'Account menu' }))
    expect(screen.queryByRole('menuitem', { name: 'Account' })).toBeNull()
    // Logout is always present.
    expect(screen.getByRole('menuitem', { name: 'Logout' })).toBeTruthy()
  })

  it('shows Account and calls onAccount (same-tab) when provided', () => {
    const onAccount = vi.fn()
    render(<UserMenu profile={profile} onAccount={onAccount} />)
    fireEvent.click(screen.getByRole('button', { name: 'Account menu' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Account' }))
    expect(onAccount).toHaveBeenCalledOnce()
  })

  it('prefers onAccount over the new-tab accountUrl when both are set', () => {
    const onAccount = vi.fn()
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    render(
      <UserMenu profile={profile} onAccount={onAccount} accountUrl="https://id.example/account" />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Account menu' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Account' }))
    expect(onAccount).toHaveBeenCalledOnce()
    expect(open).not.toHaveBeenCalled()
    open.mockRestore()
  })

  it('opens a http(s) accountUrl in a new tab', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    render(<UserMenu profile={profile} accountUrl="https://id.example/account" />)
    fireEvent.click(screen.getByRole('button', { name: 'Account menu' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Account' }))
    expect(open).toHaveBeenCalledWith(
      'https://id.example/account',
      '_blank',
      'noopener,noreferrer',
    )
  })

  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    '/account/settings', // relative — contract requires an absolute URL
    '//id.example/account', // protocol-relative
  ])('hides the Account item for a non-absolute-http(s) accountUrl (%s)', (url) => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    render(<UserMenu profile={profile} accountUrl={url} />)
    fireEvent.click(screen.getByRole('button', { name: 'Account menu' }))
    expect(screen.queryByRole('menuitem', { name: 'Account' })).toBeNull()
    expect(open).not.toHaveBeenCalled()
  })
})

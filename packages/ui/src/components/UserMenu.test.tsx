// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { UserMenu } from './UserMenu.js'

afterEach(cleanup)

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
})

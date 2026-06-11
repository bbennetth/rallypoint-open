// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { App } from './App.js'

// Smoke render covering the React 19 / React-Router 7 upgrade: mount
// the app on the landing route and assert the brand copy renders.
// Catches a broken render tree / RR provider mismatch from the version
// bump. The landing is now session-aware (#189), so stub the session
// probe as unauthenticated to land on the marketing card.
describe('id-web App (post React19 / RR7 upgrade)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders the marketing landing card on / when signed out', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('', { status: 401 }),
    )

    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    )

    expect(await screen.findByRole('heading', { name: 'Rallypoint ID' })).toBeTruthy()
    expect(screen.getByText('One identity for every Rallypoint app.')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Sign in' })).toBeTruthy()
  })
})

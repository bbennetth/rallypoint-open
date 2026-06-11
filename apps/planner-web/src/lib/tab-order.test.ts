import { describe, it, expect } from 'vitest'
import { orderNav } from './tab-order.js'

const BASE = [
  { to: '/me', label: 'My Day' },
  { to: '/upcoming', label: 'Upcoming' },
  { to: '/tasks', label: 'Tasks' },
  { to: '/shopping', label: 'Shopping' },
  { to: '/events', label: 'Events' },
  { to: '/notes', label: 'Notes' },
]

describe('orderNav', () => {
  it('returns base unchanged when order is empty', () => {
    expect(orderNav(BASE, [])).toEqual(BASE)
  })

  it('reorders all items according to a full order', () => {
    const order = ['/notes', '/events', '/tasks', '/shopping', '/upcoming', '/me']
    const result = orderNav(BASE, order)
    expect(result.map((n) => n.to)).toEqual(order)
  })

  it('handles a partial order: ordered items first, remaining in original relative order', () => {
    const order = ['/notes', '/tasks']
    const result = orderNav(BASE, order)
    expect(result.map((n) => n.to)).toEqual([
      '/notes',
      '/tasks',
      '/me',
      '/upcoming',
      '/shopping',
      '/events',
    ])
  })

  it('ignores stale order entries not present in base', () => {
    const order = ['/notes', '/stale-route', '/tasks']
    const result = orderNav(BASE, order)
    expect(result.map((n) => n.to)).toEqual([
      '/notes',
      '/tasks',
      '/me',
      '/upcoming',
      '/shopping',
      '/events',
    ])
  })
})

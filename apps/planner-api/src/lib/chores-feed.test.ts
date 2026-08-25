import { describe, it, expect } from 'vitest'
import type { ListDto, ListItemDto, ListsClient } from '@rallypoint/lists-client'
import { choresInFeedsEnabled, fetchChoresFeed, fetchChoresFeedItems } from './chores-feed.js'

// Pure + light-integration coverage for the chores→feed plumbing (#546).

describe('choresInFeedsEnabled', () => {
  it('defaults ON when the setting is absent', () => {
    expect(choresInFeedsEnabled({})).toBe(true)
  })

  it('stays ON for any non-false value (e.g. explicit true)', () => {
    expect(choresInFeedsEnabled({ showChoresInFeeds: true })).toBe(true)
    expect(choresInFeedsEnabled({ showChoresInFeeds: 'yes' })).toBe(true)
  })

  it('is OFF only when explicitly false', () => {
    expect(choresInFeedsEnabled({ showChoresInFeeds: false })).toBe(false)
  })
})

function choresList(id: string, scopeId: string): ListDto {
  return {
    id,
    scopeType: 'list_group',
    scopeId,
    listType: 'chores',
    name: 'Chores',
    visibility: 'all',
    color: null,
    incompleteCount: 0,
    createdBy: 'user_a',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function makeFake(opts: { lists?: ListDto[]; items?: ListItemDto[] }): ListsClient {
  return {
    listGroups: async () => [
      {
        id: 'lgr_p',
        name: 'Planner',
        description: null,
        createdBy: 'user_a',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    listLists: async () => opts.lists ?? [],
    listItems: async (listId: string) => (opts.items ?? []).filter((i) => i.listId === listId),
  } as unknown as ListsClient
}

const settingsOn = { get: async () => ({}) }
const settingsOff = { get: async () => ({ showChoresInFeeds: false }) }
const settingsThrows = {
  get: async () => {
    throw new Error('settings down')
  },
}

describe('fetchChoresFeedItems', () => {
  const actor = 'user_a'

  it('returns the chores items when the toggle is ON (default)', async () => {
    const list = choresList('lst_c', 'lgr_p')
    const item = { id: 'lit_1', listId: 'lst_c', title: 'Trash' } as unknown as ListItemDto
    const client = makeFake({ lists: [list], items: [item] })
    const result = await fetchChoresFeedItems(client, settingsOn, actor)
    expect(result.map((i) => i.id)).toEqual(['lit_1'])
  })

  it('returns [] when the toggle is OFF (default future scope)', async () => {
    const list = choresList('lst_c', 'lgr_p')
    const item = { id: 'lit_1', listId: 'lst_c', title: 'Trash' } as unknown as ListItemDto
    const client = makeFake({ lists: [list], items: [item] })
    const result = await fetchChoresFeedItems(client, settingsOff, actor)
    expect(result).toEqual([])
  })

  it('today scope returns chores even when the toggle is OFF (always-on)', async () => {
    const list = choresList('lst_c', 'lgr_p')
    const item = { id: 'lit_1', listId: 'lst_c', title: 'Trash' } as unknown as ListItemDto
    const client = makeFake({ lists: [list], items: [item] })
    const result = await fetchChoresFeedItems(client, settingsOff, actor, 'today')
    expect(result.map((i) => i.id)).toEqual(['lit_1'])
  })

  it('today scope still returns chores when the toggle is ON', async () => {
    const list = choresList('lst_c', 'lgr_p')
    const item = { id: 'lit_1', listId: 'lst_c', title: 'Trash' } as unknown as ListItemDto
    const client = makeFake({ lists: [list], items: [item] })
    const result = await fetchChoresFeedItems(client, settingsOn, actor, 'today')
    expect(result.map((i) => i.id)).toEqual(['lit_1'])
  })

  it('future scope is gated explicitly when the toggle is OFF', async () => {
    const list = choresList('lst_c', 'lgr_p')
    const item = { id: 'lit_1', listId: 'lst_c', title: 'Trash' } as unknown as ListItemDto
    const client = makeFake({ lists: [list], items: [item] })
    const result = await fetchChoresFeedItems(client, settingsOff, actor, 'future')
    expect(result).toEqual([])
  })

  it('today scope skips the settings read entirely (no settings dependency)', async () => {
    const list = choresList('lst_c', 'lgr_p')
    const item = { id: 'lit_1', listId: 'lst_c', title: 'Trash' } as unknown as ListItemDto
    const client = makeFake({ lists: [list], items: [item] })
    // settingsThrows would normally fall back to ON via the catch; here we
    // want to prove the read isn't even attempted for today scope.
    let settingsCalled = false
    const settingsCounted: typeof settingsThrows = {
      get: async () => {
        settingsCalled = true
        return {}
      },
    }
    const result = await fetchChoresFeedItems(client, settingsCounted, actor, 'today')
    expect(settingsCalled).toBe(false)
    expect(result.map((i) => i.id)).toEqual(['lit_1'])
  })

  it('returns [] when no chores list exists yet (never provisions)', async () => {
    const client = makeFake({ lists: [] })
    expect(await fetchChoresFeedItems(client, settingsOn, actor)).toEqual([])
  })

  it('falls back to ON when the settings read throws (non-fatal)', async () => {
    const list = choresList('lst_c', 'lgr_p')
    const item = { id: 'lit_1', listId: 'lst_c', title: 'Trash' } as unknown as ListItemDto
    const client = makeFake({ lists: [list], items: [item] })
    const result = await fetchChoresFeedItems(client, settingsThrows, actor)
    expect(result.map((i) => i.id)).toEqual(['lit_1'])
  })
})

describe('fetchChoresFeed (id + items)', () => {
  const actor = 'user_a'

  it('returns the chores-list id alongside the items', async () => {
    const list = choresList('lst_c', 'lgr_p')
    const item = { id: 'lit_1', listId: 'lst_c', title: 'Trash' } as unknown as ListItemDto
    const client = makeFake({ lists: [list], items: [item] })
    const result = await fetchChoresFeed(client, settingsOn, actor, 'today')
    expect(result.listId).toBe('lst_c')
    expect(result.items.map((i) => i.id)).toEqual(['lit_1'])
  })

  it('returns a null id and no items when no chores list exists (never provisions)', async () => {
    const client = makeFake({ lists: [] })
    expect(await fetchChoresFeed(client, settingsOn, actor, 'today')).toEqual({
      listId: null,
      items: [],
    })
  })

  it('future scope with toggle OFF suppresses items but still reports the id', async () => {
    const list = choresList('lst_c', 'lgr_p')
    const item = { id: 'lit_1', listId: 'lst_c', title: 'Trash' } as unknown as ListItemDto
    const client = makeFake({ lists: [list], items: [item] })
    const result = await fetchChoresFeed(client, settingsOff, actor, 'future')
    expect(result).toEqual({ listId: 'lst_c', items: [] })
  })
})

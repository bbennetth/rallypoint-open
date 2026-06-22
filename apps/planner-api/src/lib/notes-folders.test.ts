import { describe, it, expect } from 'vitest'
import type { ListDto, ListItemDto } from '@rallypoint/lists-client'
import {
  defaultFolder,
  folderNameTaken,
  isOwnedFolder,
  normalizeFolderName,
  tagNotes,
} from './notes-folders.js'

function folder(over: Partial<ListDto> & { id: string }): ListDto {
  return {
    scopeType: 'list_group',
    scopeId: 'lgr_p',
    listType: 'notes',
    name: 'Notes',
    visibility: 'all',
    color: null,
    incompleteCount: 0,
    createdBy: 'user_a',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

describe('normalizeFolderName', () => {
  it('trims and case-folds', () => {
    expect(normalizeFolderName('  Work  ')).toBe('work')
  })
})

describe('folderNameTaken', () => {
  const folders = [folder({ id: 'lst_1', name: 'Work' })]
  it('matches case-insensitively after trim', () => {
    expect(folderNameTaken(folders, '  work ')).toBe(true)
  })
  it('is false for a fresh name', () => {
    expect(folderNameTaken(folders, 'Ideas')).toBe(false)
  })
})

describe('isOwnedFolder', () => {
  const folders = [folder({ id: 'lst_1' }), folder({ id: 'lst_2' })]
  it('true for an owned id', () => {
    expect(isOwnedFolder(folders, 'lst_2')).toBe(true)
  })
  it('false for a foreign id', () => {
    expect(isOwnedFolder(folders, 'lst_x')).toBe(false)
  })
})

describe('defaultFolder', () => {
  it('is the first (oldest) folder', () => {
    expect(defaultFolder([folder({ id: 'lst_a' }), folder({ id: 'lst_b' })])?.id).toBe('lst_a')
  })
  it('is null when there are no folders', () => {
    expect(defaultFolder([])).toBeNull()
  })
})

describe('tagNotes', () => {
  it('stamps each note with the folder id', () => {
    const items = [{ id: 'lit_1' }, { id: 'lit_2' }] as unknown as ListItemDto[]
    expect(tagNotes(items, 'lst_f').map((n) => n.folderId)).toEqual(['lst_f', 'lst_f'])
  })
})

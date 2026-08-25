// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'

const mocks = vi.hoisted(() => {
  const live = [
    {
      id: 'note_active',
      title: 'Draft',
      notes: 'Body',
      completed: false,
      completedAt: null,
      createdAt: '2026-07-01T00:00:00.000Z',
      folderId: 'folder_notes',
    },
    {
      id: 'note_closed',
      title: 'Closed note',
      notes: null,
      completed: true,
      completedAt: '2026-07-10T00:00:00.000Z',
      createdAt: '2026-07-02T00:00:00.000Z',
      folderId: 'folder_notes',
    },
  ]
  const deleted = [
    {
      id: 'note_deleted',
      title: 'Deleted note',
      notes: 'Recover me',
      completed: false,
      completedAt: null,
      createdAt: '2026-07-03T00:00:00.000Z',
      deletedAt: '2026-07-14T00:00:00.000Z',
      folderId: 'folder_notes',
    },
  ]
  const folders = [
    {
      id: 'folder_notes',
      name: 'Notes',
      createdAt: '2026-07-01T00:00:00.000Z',
      isDefault: true,
    },
  ]
  return {
    live,
    deleted,
    folders,
    updateNote: vi.fn(async (id: string, patch: Record<string, unknown>) => ({
      ...live.find((note) => note.id === id)!,
      ...patch,
      ...(patch.completed !== undefined
        ? { completedAt: patch.completed ? '2026-07-15T00:00:00.000Z' : null }
        : {}),
    })),
    restoreNote: vi.fn(async () => live[0]),
    deleteNote: vi.fn(async () => undefined),
    refetch: vi.fn(async () => undefined),
  }
})

vi.mock('../lib/api.js', () => ({
  ApiError: class ApiError extends Error {},
  notesQuery: () => ({ table: 'notes', key: 'all' }),
  deletedNotesQuery: () => ({ table: 'notes', key: 'deleted' }),
  noteFoldersQuery: () => ({ table: 'noteFolders', key: 'all' }),
  updateNote: mocks.updateNote,
  restoreNote: mocks.restoreNote,
  deleteNote: mocks.deleteNote,
  createNoteFolder: vi.fn(),
  deleteNoteFolder: vi.fn(),
}))

vi.mock('../lib/offline/use-cached-query.js', () => ({
  useCachedQuery: (query: { table: string; key: string }) => {
    const data =
      query.table === 'noteFolders'
        ? mocks.folders
        : query.key === 'deleted'
          ? mocks.deleted
          : mocks.live
    return { data, status: 'fresh', error: null, refetch: mocks.refetch }
  },
}))

vi.mock('../lib/refresh-bus.js', () => ({ onCreated: () => () => undefined }))
vi.mock('../ui/QuickAdd.js', () => ({
  QuickAdd: () => <button type="button" aria-label="Quick add">+</button>,
}))

import { NotesPage } from './NotesPage.js'

// NotesPage uses useBlocker, which requires a data router. Mount it under a
// single-route memory router so navigation-guard wiring is exercised.
function renderPage() {
  const router = createMemoryRouter([{ path: '/', element: <NotesPage /> }], {
    initialEntries: ['/'],
  })
  return render(<RouterProvider router={router} />)
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('NotesPage', () => {
  it('does not autosave and offers all three choices when closing a dirty note', async () => {
    renderPage()
    fireEvent.click(screen.getByText('Draft'))
    const title = screen.getByLabelText('Note title')
    fireEvent.change(title, { target: { value: 'Edited title' } })
    fireEvent.blur(title)
    expect(mocks.updateNote).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(mocks.updateNote).toHaveBeenCalledWith('note_active', { title: 'Edited title' }),
    )
    expect(mocks.refetch).toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('Note title'), { target: { value: 'Unsaved again' } })
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    const closePrompt = within(screen.getByRole('alertdialog'))
    expect(closePrompt.getByText('Unsaved changes')).not.toBeNull()
    expect(closePrompt.getByRole('button', { name: 'Save' })).not.toBeNull()
    expect(closePrompt.getByRole('button', { name: 'Discard edits' })).not.toBeNull()
    expect(closePrompt.getByRole('button', { name: 'Go back' })).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Go back' }))
    expect((screen.getByLabelText('Note title') as HTMLInputElement).value).toBe('Unsaved again')
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    fireEvent.click(screen.getByRole('button', { name: 'Discard edits' }))
    expect(screen.queryByLabelText('Note title')).toBeNull()
  })

  it('saves and closes when choosing Save from the unsaved-changes prompt', async () => {
    renderPage()
    fireEvent.click(screen.getByText('Draft'))
    fireEvent.change(screen.getByLabelText('Note title'), { target: { value: 'Renamed' } })
    // Close the drawer to raise the prompt, then choose Save inside it.
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    const prompt = within(screen.getByRole('alertdialog'))
    fireEvent.click(prompt.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(mocks.updateNote).toHaveBeenCalledWith('note_active', { title: 'Renamed' }),
    )
    // Prompt and editor only close after the save resolves.
    await waitFor(() => expect(screen.queryByLabelText('Note title')).toBeNull())
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(mocks.refetch).toHaveBeenCalled()
  })

  it('keeps the editor open with an error when the prompt save fails', async () => {
    mocks.updateNote.mockRejectedValueOnce(new Error('boom'))
    renderPage()
    fireEvent.click(screen.getByText('Draft'))
    fireEvent.change(screen.getByLabelText('Note title'), { target: { value: 'Renamed' } })
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(screen.getByRole('alert')).not.toBeNull())
    // Prompt dismissed but the editor stays open with the unsaved text intact.
    expect(screen.queryByRole('alertdialog')).toBeNull()
    const title = screen.getByLabelText('Note title') as HTMLInputElement
    expect(title.value).toBe('Renamed')
  })

  it('persists staged edits together with the close toggle in one request', async () => {
    renderPage()
    fireEvent.click(screen.getByText('Draft'))
    fireEvent.change(screen.getByLabelText('Note body'), { target: { value: 'New body' } })
    fireEvent.click(screen.getByRole('button', { name: 'Close note' }))
    await waitFor(() =>
      expect(mocks.updateNote).toHaveBeenCalledWith('note_active', {
        completed: true,
        notes: 'New body',
      }),
    )
    expect(mocks.updateNote).toHaveBeenCalledTimes(1)
    expect(mocks.refetch).toHaveBeenCalled()
  })

  it('switches Active/Closed/Deleted and persists close/restore actions immediately', async () => {
    renderPage()
    expect(screen.getByText('Draft')).not.toBeNull()
    expect(screen.queryByText('Closed note')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Closed' }))
    expect(screen.getByText('Closed note')).not.toBeNull()
    // The close/reopen checkbox is reachable by its accessible name.
    fireEvent.click(screen.getByRole('button', { name: 'Reopen note Closed note' }))
    await waitFor(() =>
      expect(mocks.updateNote).toHaveBeenCalledWith('note_closed', { completed: false }),
    )
    expect(mocks.refetch).toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Deleted' }))
    expect(screen.getByText('Deleted note')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    await waitFor(() => expect(mocks.restoreNote).toHaveBeenCalledWith('note_deleted'))
  })
})

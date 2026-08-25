import { useCallback, useEffect, useState } from 'react'
import { useAsyncTask } from '@rallypoint/web-kit'
import { ApiError, listGroups, type GroupDto } from './api.js'

// "My groups in this event" — the list behind the attendee Group tab and
// the group shell's cross-links.
//
// This wraps GET /api/v1/ui/events/:id/groups, which returns only the
// caller's own groups. The endpoint and its client both existed for
// months with no caller, which is why an attendee's groups looked like
// they had vanished: nothing ever asked for them.
//
// Note the error state is distinct from an empty list. A failed fetch
// must not render as "you have no groups" — that is the bug.

export type MyEventGroupsState =
  | { status: 'loading' }
  | { status: 'ready'; groups: GroupDto[] }
  | { status: 'error'; message: string }

export function useMyEventGroups(eventId: string | null | undefined): {
  state: MyEventGroupsState
  reload: () => void
} {
  const [state, setState] = useState<MyEventGroupsState>({ status: 'loading' })
  const [reloadKey, setReloadKey] = useState(0)
  const run = useAsyncTask()

  const reload = useCallback(() => setReloadKey((k) => k + 1), [])

  useEffect(() => {
    if (!eventId) return
    setState({ status: 'loading' })
    void run(async (ctx) => {
      try {
        const groups = await listGroups(eventId)
        if (ctx.stale()) return
        setState({ status: 'ready', groups })
      } catch (err) {
        if (ctx.stale()) return
        setState({
          status: 'error',
          message: err instanceof ApiError ? err.message : 'Failed to load your groups.',
        })
      }
    })
  }, [eventId, run, reloadKey])

  return { state, reload }
}

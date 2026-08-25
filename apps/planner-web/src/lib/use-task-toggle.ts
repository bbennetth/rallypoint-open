import { useState, type Dispatch, type SetStateAction } from 'react'
import { setChoreItemCompleted, setTaskItemCompleted, type MyDay, type MyDayTask } from './api.js'
import { errMessage } from './my-day-sections.js'

export interface UseTaskToggleParams {
  data: MyDay | null
  setData: Dispatch<SetStateAction<MyDay | null>>
  setError: Dispatch<SetStateAction<string | null>>
  choresListId: string | null
  personalTaskListIds: Set<string> | null
}

// Optimistic task/chore completion toggle for the My Day agenda. Split out
// of `MyDayPage` so the rollback + chore-routing logic can be reused
// wherever a My Day task row renders without dragging the rest of the page
// along. Adopted by `MyDayPage` only — `UpcomingFeed` has its own toggle.
export function useTaskToggle({
  data,
  setData,
  setError,
  choresListId,
  personalTaskListIds,
}: UseTaskToggleParams) {
  const [busyId, setBusyId] = useState<string | null>(null)

  // Whether a My Day task row is a chore item. Two independent signals so a
  // cold-load race doesn't misroute a write: (a) `choresListId` resolved from
  // the /recurring fetch, or (b) the item's `listId` is NOT in the
  // personal-task-lists set. Either is sufficient. When both are unresolved
  // we treat it as a task — same fallback the toggle always used.
  function isChoreTask(task: MyDayTask): boolean {
    return (
      (choresListId != null && task.listId === choresListId) ||
      (personalTaskListIds != null && !personalTaskListIds.has(task.listId))
    )
  }

  async function toggle(task: MyDayTask) {
    if (!data || busyId === task.id) return
    const next = !task.completed
    setBusyId(task.id)
    // Optimistic update for both dated and undated task lists.
    setData((d) => {
      if (!d) return d
      const patchList = (list: MyDayTask[]) =>
        list.map((t) => (t.id === task.id ? { ...t, completed: next } : t))
      return {
        ...d,
        tasks: patchList(d.tasks),
        undatedTasks: patchList(d.undatedTasks),
      }
    })
    try {
      // Chores live in the chores list (`listType: 'chores'`); their items go
      // through the chore-specific mutation so the BFF audit + cache key match.
      if (isChoreTask(task)) {
        await setChoreItemCompleted(task.listId, task.id, next)
      } else {
        await setTaskItemCompleted(task.listId, task.id, next)
      }
    } catch (err) {
      setError(errMessage(err))
      // Roll back optimistic update.
      setData((d) => {
        if (!d) return d
        const rollback = (list: MyDayTask[]) =>
          list.map((t) => (t.id === task.id ? { ...t, completed: task.completed } : t))
        return {
          ...d,
          tasks: rollback(d.tasks),
          undatedTasks: rollback(d.undatedTasks),
        }
      })
    } finally {
      setBusyId(null)
    }
  }

  return { busyId, isChoreTask, toggle }
}

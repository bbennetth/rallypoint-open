import { create } from 'zustand'

// Selected event-day for views that filter by day (NowPage,
// RalliesPage, MyDayPage — slice 13). Defaults to "today" relative
// to the device clock when the active event covers today, else the
// event's first day. Pages may write through `setDayId` from a date
// picker; the Now widgets read from here so a day pick in one tab
// carries to the others.

export interface ActiveDayState {
  // The chosen day id (a string ULID like `evd_...`). null means
  // "no day picked yet" — pages should render an empty state and
  // wait for the user to pick.
  dayId: string | null
  setDayId(id: string | null): void
  // Initialise once when the active event's days first arrive.
  // No-op if a day is already picked AND it's still in the list.
  // Picks the first day whose `date` covers today, else the first
  // day with the lowest sort_order.
  pickDefaultForToday(input: {
    days: ReadonlyArray<{ id: string; date: string; sortOrder: number }>
    today: string // YYYY-MM-DD in the device tz
  }): void
}

export const useActiveDayStore = create<ActiveDayState>((set, get) => ({
  dayId: null,
  setDayId: (id) => set({ dayId: id }),
  pickDefaultForToday: ({ days, today }) => {
    if (days.length === 0) return
    const current = get().dayId
    if (current !== null && days.some((d) => d.id === current)) return
    const todayDay = days.find((d) => d.date === today)
    if (todayDay) {
      set({ dayId: todayDay.id })
      return
    }
    const sorted = [...days].sort((a, b) => a.sortOrder - b.sortOrder)
    set({ dayId: sorted[0]!.id })
  },
}))

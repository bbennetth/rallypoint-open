import { create } from 'zustand'
import type { GroupRole } from '../lib/api.js'

// Active-group context for the attendee shell (slice 13). Populated by
// AttendeeChrome when the user navigates into a /groups/:groupId/* route;
// cleared when they leave. Other components (NowPage widgets,
// breadcrumbs, page titles) read from here without prop-drilling.
//
// We deliberately keep the surface tiny — anything more elaborate
// (cached group detail, member list) lives in the SWR cache layer and
// is fetched by individual pages.

export interface ActiveGroupState {
  groupId: string | null
  groupName: string | null
  eventId: string | null
  eventSlug: string | null
  eventName: string | null
  // Whether the parent event has an uploaded app icon — drives the
  // per-event PWA `apple-touch-icon` swap on the group surface.
  eventHasAppIcon: boolean
  viewerRole: GroupRole | null
  set(input: Omit<ActiveGroupState, 'set' | 'clear'>): void
  clear(): void
}

const EMPTY: Omit<ActiveGroupState, 'set' | 'clear'> = {
  groupId: null,
  groupName: null,
  eventId: null,
  eventSlug: null,
  eventName: null,
  eventHasAppIcon: false,
  viewerRole: null,
}

export const useActiveGroupStore = create<ActiveGroupState>((set) => ({
  ...EMPTY,
  set: (input) => set({ ...input }),
  clear: () => set({ ...EMPTY }),
}))

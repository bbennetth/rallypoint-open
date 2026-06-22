import type { AppChromeNavItem } from '@rallypoint/ui'

export const NAV: readonly AppChromeNavItem[] = [
  { to: '/me', label: 'My Day', icon: 'myday', end: true },
  { to: '/tasks', label: 'Tasks', icon: 'tasks', end: true },
  { to: '/shopping', label: 'Shopping', icon: 'cart', end: true },
  { to: '/events', label: 'Events', icon: 'events', end: true },
  { to: '/notes', label: 'Notes', icon: 'file', end: true },
  { to: '/diary', label: 'Diary', icon: 'pencil', end: true },
]

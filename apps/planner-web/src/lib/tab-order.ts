import { useSyncExternalStore } from 'react'

// localStorage-backed tab order with cross-tab sync via the 'storage' event.
// Stored as a JSON string[] of `to` paths under STORAGE_SLOT.

// Not named *_KEY: an identifier like `KEY` next to a string literal trips
// gitleaks' generic-api-key rule in the secret scan. This is a localStorage
// slot name, not a secret. The inline annotation is a belt-and-suspenders.
const STORAGE_SLOT = 'planner.tabOrder.v1' // gitleaks:allow

// Module-level listener set for same-tab notifications.
const listeners = new Set<() => void>()

// Cross-tab sync: when another tab writes to the same key, notify listeners.
// Module-level singleton listener — intentionally never removed (the module
// lives for the page's lifetime); don't add a redundant cleanup.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_SLOT) {
      for (const cb of listeners) cb()
    }
  })
}

function notifyListeners() {
  for (const cb of listeners) cb()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

// Return the raw localStorage string so useSyncExternalStore detects changes.
function getSnapshot(): string | null {
  if (typeof localStorage === 'undefined') return null
  return localStorage.getItem(STORAGE_SLOT)
}

// Server snapshot: always empty (no SSR hydration needed for this app).
function getServerSnapshot(): string | null {
  return null
}

/** Returns the parsed tab order (array of `to` paths), or [] when unset/invalid. */
export function useTabOrder(): string[] {
  const raw = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed) && parsed.every((v) => typeof v === 'string')) {
      return parsed as string[]
    }
  } catch {
    // ignore parse errors
  }
  return []
}

/** Writes the new order to localStorage and notifies listeners. */
export function setTabOrder(order: string[]): void {
  localStorage.setItem(STORAGE_SLOT, JSON.stringify(order))
  notifyListeners()
}

/**
 * PURE: return `base` reordered so items whose `to` appears in `order` come
 * first (in `order`'s sequence); any base items NOT in `order` keep their
 * original relative position and are appended after. `order` entries not
 * in base are ignored. Robust to added/removed tabs.
 */
export function orderNav<T extends { to: string }>(base: readonly T[], order: readonly string[]): T[] {
  const baseMap = new Map<string, T>()
  for (const item of base) baseMap.set(item.to, item)

  const result: T[] = []
  // First: items from `order` that exist in base (in order's sequence).
  for (const to of order) {
    const item = baseMap.get(to)
    if (item) result.push(item)
  }
  // Then: base items not in order (original relative order).
  const inOrder = new Set(order)
  for (const item of base) {
    if (!inOrder.has(item.to)) result.push(item)
  }
  return result
}

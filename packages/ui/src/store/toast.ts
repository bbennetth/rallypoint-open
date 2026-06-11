import { create } from 'zustand'
import {
  enqueue as enqueueQueue,
  expireQueue,
  makeToast,
  type Toast,
  type ToastInput,
} from '../lib/toast-queue.js'

// Global toast store. Components push via `useToastStore.getState().push(…)`
// or the curried `useToast()` hook below. The `<Toaster />` component
// subscribes and renders.

interface ToastStore {
  queue: Toast[]
  push(input: ToastInput): string
  dismiss(id: string): void
  // Called by the Toaster's effect to drop expired entries.
  expire(now: number): void
  clear(): void
}

let randomCounter = 0
function nextRandomSuffix(): string {
  randomCounter = (randomCounter + 1) % 1_000_000
  return String(randomCounter).padStart(6, '0')
}

export const useToastStore = create<ToastStore>((set) => ({
  queue: [],
  push(input) {
    const t = makeToast(input, Date.now(), nextRandomSuffix())
    set((s) => ({ queue: enqueueQueue(s.queue, t) }))
    return t.id
  },
  dismiss(id) {
    set((s) => ({ queue: s.queue.filter((t) => t.id !== id) }))
  },
  expire(now) {
    set((s) => ({ queue: expireQueue(s.queue, now) }))
  },
  clear() {
    set({ queue: [] })
  },
}))

// Ergonomic curried hook for components that just want to push.
//   const toast = useToast()
//   toast({ tone: 'success', body: 'Copied!' })
export function useToast(): (input: ToastInput) => string {
  return useToastStore((s) => s.push)
}

export type { Toast, ToastInput } from '../lib/toast-queue.js'

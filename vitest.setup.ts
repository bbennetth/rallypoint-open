// Runs before every test module is imported (see `setupFiles` in
// vitest.config.ts). The bundled jsdom ships a `localStorage` property
// that resolves to `undefined`, but DOM code under test — notably
// zustand's `persist` middleware, which binds its storage at
// module-eval time — expects a working Storage. Install an in-memory
// shim for any DOM environment that lacks one. Node-env test files have
// no `window`, so the guard skips them.
if (typeof window !== 'undefined' && typeof window.localStorage?.setItem !== 'function') {
  const store = new Map<string, string>()
  const memory: Storage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, String(value)),
    removeItem: (key) => void store.delete(key),
    clear: () => store.clear(),
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size
    },
  }
  Object.defineProperty(window, 'localStorage', { value: memory, configurable: true })
  Object.defineProperty(globalThis, 'localStorage', { value: memory, configurable: true })
}

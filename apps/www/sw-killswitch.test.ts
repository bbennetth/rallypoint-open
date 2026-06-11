import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The kill-switch SW (#493) only works if it stays a self-destructing,
// non-caching classic worker served verbatim at the old SW's script URL.
// These assertions guard that it can never silently regress into a caching
// SW or grow imports that would break being served as a plain static file.
const sw = readFileSync(resolve(__dirname, 'sw-killswitch.js'), 'utf8')
const viteConfig = readFileSync(resolve(__dirname, 'vite.config.ts'), 'utf8')

// Strip comments so the "no caching SW" assertions inspect executable code,
// not the explanatory comments (which legitimately name workbox/precache).
const swCode = sw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

describe('apex kill-switch service worker', () => {
  it('performs every self-destruct step', () => {
    expect(sw).toContain('self.skipWaiting()')
    expect(sw).toContain('caches.delete')
    expect(sw).toContain('self.registration.unregister()')
    expect(sw).toContain('client.navigate')
  })

  it('clears orphaned festival-planner IndexedDB data', () => {
    expect(sw).toContain('indexedDB.databases')
    expect(sw).toContain('indexedDB.deleteDatabase')
  })

  it('stays a non-caching classic worker (no precache, no imports)', () => {
    expect(swCode).not.toMatch(/importScripts/)
    expect(swCode).not.toMatch(/precache/i)
    expect(swCode).not.toMatch(/workbox/i)
    expect(swCode).not.toMatch(/^\s*import\s/m)
  })

  it('is emitted at both common SW registration paths', () => {
    expect(viteConfig).toContain("'sw.js'")
    expect(viteConfig).toContain("'service-worker.js'")
  })
})

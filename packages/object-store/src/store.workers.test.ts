import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import type { R2Bucket } from '@cloudflare/workers-types'
import { createBindingObjectStore } from './index.js'

// Real Miniflare R2 binding — `env.OBJECT_STORE` is provisioned by
// vitest.workers.config.ts. No store mocking (#409 / CLAUDE.md).
const bucket = env.OBJECT_STORE as unknown as R2Bucket
const store = createBindingObjectStore(bucket)

async function streamToText(s: ReadableStream): Promise<string> {
  return new Response(s as unknown as BodyInit).text()
}

describe('createBindingObjectStore', () => {
  beforeEach(async () => {
    // Clear the bucket between tests so keys don't leak across cases.
    const listed = await bucket.list()
    await Promise.all(listed.objects.map((o) => bucket.delete(o.key)))
  })

  it('put then get round-trips bytes + content-type', async () => {
    await store.put('a/b.txt', 'hello world', { contentType: 'text/plain' })
    const got = await store.get('a/b.txt')
    expect(got).not.toBeNull()
    expect(got!.contentType).toBe('text/plain')
    expect(got!.contentLength).toBe('hello world'.length)
    expect(await streamToText(got!.body)).toBe('hello world')
  })

  it('get returns null for a missing key', async () => {
    expect(await store.get('nope/missing.bin')).toBeNull()
  })

  it('headObject returns metadata, or null when missing', async () => {
    await store.put('h/obj.png', new Uint8Array([1, 2, 3, 4]), { contentType: 'image/png' })
    const head = await store.headObject('h/obj.png')
    expect(head).toEqual({ contentType: 'image/png', contentLength: 4 })
    expect(await store.headObject('h/absent.png')).toBeNull()
  })

  it('deleteObject removes the object and is idempotent on a missing key', async () => {
    await store.put('d/gone.txt', 'bye', { contentType: 'text/plain' })
    await store.deleteObject('d/gone.txt')
    expect(await store.get('d/gone.txt')).toBeNull()
    // Second delete (missing key) must not throw — racy-safe pruner.
    await expect(store.deleteObject('d/gone.txt')).resolves.toBeUndefined()
  })

  it('put with no content-type leaves it null', async () => {
    await store.put('n/raw.bin', new Uint8Array([9, 9]))
    const head = await store.headObject('n/raw.bin')
    expect(head).toEqual({ contentType: null, contentLength: 2 })
  })
})

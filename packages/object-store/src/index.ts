// Native Cloudflare R2 object-store adapter shared across Rallypoint
// apps (Events map images, Money receipts, RPID avatars). Backed by an
// R2 *binding* (`env.OBJECT_STORE`) — ambient credentials, no access
// keys/secrets, no presigned URLs, no S3 endpoint.
//
// Upload bytes flow browser → Worker route → `bucket.put()`; reads
// stream back via `bucket.get()` through a Worker serve route. The
// bucket stays fully private (#409). Avatars/maps/receipts are small,
// well under the 100 MB request-body limit, so streaming through the
// Worker is fine.
//
// The interface is intentionally tiny — `put`/`get`/`headObject`/
// `deleteObject`. The previous presigned-S3 impls (aws4fetch + @aws-sdk)
// were retired when every caller moved to bindings.
import type { R2Bucket, ReadableStream } from '@cloudflare/workers-types'

// Bytes a caller can hand to `put`. Matches the R2 binding's accepted
// value union (a Worker request body is a ReadableStream). The
// ReadableStream here is the workers-types one (what the R2 binding and
// `request.body` actually are), not the DOM/Node global.
export type ObjectBody = ReadableStream | ArrayBuffer | ArrayBufferView | string

export interface PutOptions {
  // Stored as the object's HTTP content-type and echoed back on `get` /
  // `headObject`. Omit to leave R2's default (no content-type).
  contentType?: string
}

export interface HeadResult {
  contentType: string | null
  contentLength: number | null
}

export interface GetResult {
  body: ReadableStream
  contentType: string | null
  contentLength: number | null
}

export interface ObjectStore {
  // Store bytes at `key`, optionally tagging the content-type.
  put(key: string, body: ObjectBody, opts?: PutOptions): Promise<void>
  // Read the object, or null if the key does not exist. The body is a
  // stream the serve route pipes straight to the client response.
  get(key: string): Promise<GetResult | null>
  // Object metadata, or null if the key does not exist.
  headObject(key: string): Promise<HeadResult | null>
  // Delete the object. R2 delete is idempotent (a missing key is not an
  // error), so the hard-purge pruner stays racy-safe across replicas.
  deleteObject(key: string): Promise<void>
}

// Wrap an R2 binding in the shared ObjectStore interface. `bucket` comes
// from the Worker `env` (declared as `[[r2_buckets]]` in wrangler.toml);
// under tests it's the real Miniflare R2 binding from
// `@cloudflare/vitest-pool-workers`.
export function createBindingObjectStore(bucket: R2Bucket): ObjectStore {
  return {
    async put(key: string, body: ObjectBody, opts?: PutOptions): Promise<void> {
      await bucket.put(key, body, opts?.contentType ? { httpMetadata: { contentType: opts.contentType } } : undefined)
    },

    async get(key: string): Promise<GetResult | null> {
      const obj = await bucket.get(key)
      if (!obj) return null
      return {
        body: obj.body,
        contentType: obj.httpMetadata?.contentType ?? null,
        contentLength: typeof obj.size === 'number' ? obj.size : null,
      }
    },

    async headObject(key: string): Promise<HeadResult | null> {
      const obj = await bucket.head(key)
      if (!obj) return null
      return {
        contentType: obj.httpMetadata?.contentType ?? null,
        contentLength: typeof obj.size === 'number' ? obj.size : null,
      }
    },

    async deleteObject(key: string): Promise<void> {
      await bucket.delete(key)
    },
  }
}

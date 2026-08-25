import { describe, expect, it } from 'vitest'
import { unzipSync, zipSync } from 'fflate'
import { createZipStream, crc32, streamUnzip } from './zip.js'

async function collect(readable: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  const reader = readable.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let p = 0
  for (const c of chunks) {
    out.set(c, p)
    p += c.length
  }
  return out
}

function streamOf(bytes: Uint8Array, chunkSize = 64 * 1024): ReadableStream<Uint8Array> {
  let p = 0
  return new ReadableStream({
    pull(controller) {
      if (p >= bytes.length) {
        controller.close()
        return
      }
      controller.enqueue(bytes.slice(p, p + chunkSize))
      p += chunkSize
    },
  })
}

async function readEntries(archive: Uint8Array, chunkSize?: number) {
  const seen: { name: string; bytes: Uint8Array }[] = []
  await streamUnzip(streamOf(archive, chunkSize), { onEntry: (e) => void seen.push(e) })
  return seen
}

describe('crc32', () => {
  it('matches the known check value', () => {
    // The ZIP/PKZIP CRC-32 of "123456789" is the standard 0xCBF43926 check value.
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
  })

  it('is zero for empty input', () => {
    expect(crc32(new Uint8Array(0))).toBe(0)
  })
})

describe('createZipStream', () => {
  it('roundtrips a manifest and blobs through streamUnzip in archive order', async () => {
    const zip = createZipStream()
    const blob = new Uint8Array([0, 1, 2, 250, 251, 255])
    const pending = (async () => {
      await zip.addJson('manifest.json', { schemaVersion: 1, app: 'fitness' })
      await zip.addStored('blobs/a.jpg', blob)
      await zip.finish()
    })()
    const archive = await collect(zip.readable)
    await pending

    const seen = await readEntries(archive)
    expect(seen.map((e) => e.name)).toEqual(['manifest.json', 'blobs/a.jpg'])
    expect(JSON.parse(new TextDecoder().decode(seen[0]!.bytes))).toEqual({
      schemaVersion: 1,
      app: 'fitness',
    })
    expect(seen[1]!.bytes).toEqual(blob)
  })

  it('produces an archive fflate can open as a whole', async () => {
    const zip = createZipStream()
    const pending = (async () => {
      await zip.addJson('manifest.json', { ok: true })
      await zip.addStored('blobs/x.bin', new Uint8Array([9, 9, 9]))
      await zip.finish()
    })()
    const archive = await collect(zip.readable)
    await pending

    const files = unzipSync(archive)
    expect(Object.keys(files).sort()).toEqual(['blobs/x.bin', 'manifest.json'])
    expect(JSON.parse(new TextDecoder().decode(files['manifest.json']!))).toEqual({ ok: true })
    expect(files['blobs/x.bin']).toEqual(new Uint8Array([9, 9, 9]))
  })

  it('survives a stored blob containing the data-descriptor signature', async () => {
    // The reason this writer exists: a streaming writer that omits sizes from
    // the local header forces readers to hunt for PK\x07\x08, and a compressed
    // photo can contain those bytes by chance. Sizes are known upfront here, so
    // the payload is sliced exactly and the signature is just data.
    const blob = new Uint8Array(2048)
    for (let i = 0; i < blob.length; i++) blob[i] = i & 0xff
    blob.set([0x50, 0x4b, 0x07, 0x08], 500)
    blob.set([0x50, 0x4b, 0x03, 0x04], 1200)
    blob.set([0x50, 0x4b, 0x01, 0x02], 1600)

    const zip = createZipStream()
    const pending = (async () => {
      await zip.addJson('manifest.json', { n: 1 })
      await zip.addStored('blobs/tricky.jpg', blob)
      await zip.finish()
    })()
    const archive = await collect(zip.readable)
    await pending

    const seen = await readEntries(archive)
    expect(seen).toHaveLength(2)
    expect(seen[1]!.bytes).toEqual(blob)
  })

  it('reassembles entries split across many small read chunks', async () => {
    const blob = new Uint8Array(5000).map((_, i) => (i * 7) & 0xff)
    const zip = createZipStream()
    const pending = (async () => {
      await zip.addJson('manifest.json', { items: Array.from({ length: 200 }, (_, i) => i) })
      await zip.addStored('blobs/big.bin', blob)
      await zip.finish()
    })()
    const archive = await collect(zip.readable)
    await pending

    const seen = await readEntries(archive, 64)
    expect(seen.map((e) => e.name)).toEqual(['manifest.json', 'blobs/big.bin'])
    expect(seen[1]!.bytes).toEqual(blob)
  })

  it('deflates the manifest rather than storing it', async () => {
    const zip = createZipStream()
    const repetitive = { note: 'x'.repeat(5000) }
    const pending = (async () => {
      await zip.addJson('manifest.json', repetitive)
      await zip.finish()
    })()
    const archive = await collect(zip.readable)
    await pending
    expect(archive.length).toBeLessThan(1000)
  })

  it('reads archives produced by other tools', async () => {
    // Not our own writer: fflate's zipSync deflates entries. Import must accept
    // an archive a user re-zipped by hand.
    const archive = zipSync({
      'manifest.json': new TextEncoder().encode(JSON.stringify({ app: 'planner' })),
      'blobs/t.pdf': new Uint8Array([1, 2, 3, 4]),
    })
    const seen = await readEntries(archive)
    expect(seen.map((e) => e.name).sort()).toEqual(['blobs/t.pdf', 'manifest.json'])
  })
})

describe('streamUnzip', () => {
  it('rejects a non-zip body', async () => {
    const junk = new TextEncoder().encode('this is definitely not a zip archive')
    await expect(readEntries(junk)).rejects.toThrow('zip_invalid')
  })

  it('rejects an empty body', async () => {
    await expect(readEntries(new Uint8Array(0))).rejects.toThrow('zip_invalid')
  })

  it('enforces the total compressed-byte cap', async () => {
    const zip = createZipStream()
    const pending = (async () => {
      await zip.addStored('blobs/a.bin', new Uint8Array(4096))
      await zip.finish()
    })()
    const archive = await collect(zip.readable)
    await pending

    await expect(
      streamUnzip(streamOf(archive, 512), { onEntry: () => {}, maxTotalBytes: 1024 }),
    ).rejects.toThrow('zip_too_large')
  })

  it('enforces the per-entry inflated-byte cap', async () => {
    // Zip-bomb guard: a highly compressible entry is small on the wire but
    // large once inflated, so the cap has to apply to the inflated size.
    const archive = zipSync({ 'manifest.json': new Uint8Array(200_000) })
    expect(archive.length).toBeLessThan(2000)
    await expect(
      streamUnzip(streamOf(archive), { onEntry: () => {}, maxEntryBytes: 10_000 }),
    ).rejects.toThrow('zip_entry_too_large')
  })

  it('propagates a failure thrown by the entry callback', async () => {
    const zip = createZipStream()
    const pending = (async () => {
      await zip.addJson('manifest.json', { bad: true })
      await zip.finish()
    })()
    const archive = await collect(zip.readable)
    await pending

    await expect(
      streamUnzip(streamOf(archive), {
        onEntry: () => {
          throw new Error('manifest_not_first')
        },
      }),
    ).rejects.toThrow('manifest_not_first')
  })

  it('awaits an async entry callback before the next entry', async () => {
    const zip = createZipStream()
    const pending = (async () => {
      await zip.addJson('manifest.json', { n: 1 })
      await zip.addStored('blobs/a.bin', new Uint8Array([1]))
      await zip.addStored('blobs/b.bin', new Uint8Array([2]))
      await zip.finish()
    })()
    const archive = await collect(zip.readable)
    await pending

    const order: string[] = []
    await streamUnzip(streamOf(archive), {
      onEntry: async (e) => {
        order.push(`start:${e.name}`)
        await Promise.resolve()
        order.push(`end:${e.name}`)
      },
    })
    expect(order).toEqual([
      'start:manifest.json',
      'end:manifest.json',
      'start:blobs/a.bin',
      'end:blobs/a.bin',
      'start:blobs/b.bin',
      'end:blobs/b.bin',
    ])
  })
})

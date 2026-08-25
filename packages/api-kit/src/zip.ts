import { deflateSync, Unzip, UnzipInflate } from 'fflate'

// ZIP reader/writer for the per-app data export/import (backup–restore).
//
// The writer is hand-rolled rather than fflate's streaming `Zip` for one
// correctness reason: fflate's `Zip` always emits a trailing data descriptor
// and writes zeroes for the sizes in the local header. A reader handed such an
// archive has to scan the raw payload byte-by-byte looking for the descriptor
// signature (PK\x07\x08) to find where each entry ends — and a stored (already
// compressed) photo containing those four bytes by chance silently truncates
// the entry. Every entry we write therefore carries its real CRC and sizes in
// the local header, so readers slice deterministically and never scan.
//
// Knowing the size upfront means buffering an entry before writing it. That is
// bounded, not unbounded: blobs are capped at 10 MB apiece upstream
// (PROGRESS_PHOTO_MAX_BYTES / TICKET_MAX_BYTES), and only ONE entry is held at
// a time — the archive itself streams out through a TransformStream, so a
// photo-heavy export never materialises in memory.
//
// Reading goes through fflate's `Unzip`, which handles both our own archives
// and anything re-zipped by an ordinary tool (deflate + data descriptors).

// --- CRC32 ------------------------------------------------------------------

const CRC_TABLE = /*#__PURE__*/ (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// --- writer -----------------------------------------------------------------

const LOCAL_SIG = 0x04034b50
const CENTRAL_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50
const UTF8_FLAG = 0x0800
const METHOD_STORE = 0
const METHOD_DEFLATE = 8

// ZIP without ZIP64 caps entry count at 2^16-1 and every size/offset at
// 2^32-1, and those exact values double as the "look in the ZIP64 record"
// sentinels. We stop one short of each so a ZIP64-aware reader can never
// mistake a legitimate count/offset for a sentinel, and refuse rather than
// emit a silently-wrapped archive.
const MAX_ENTRIES = 0xffff - 1
const MAX_UINT32 = 0xffffffff - 1

// Fixed DOS timestamp (1980-01-01 00:00) on every entry. Extracted-file mtimes
// carry no meaning for a data archive, and pinning them keeps an export of
// unchanged data byte-identical — which is what makes the roundtrip tests
// assert on bytes instead of on a re-parse.
const DOS_TIME = 0
const DOS_DATE = 33 // (1980-1980)<<9 | 1<<5 | 1

interface CentralEntry {
  nameBytes: Uint8Array
  method: number
  crc: number
  compressedSize: number
  uncompressedSize: number
  offset: number
}

function writeLocalHeader(nameBytes: Uint8Array, e: Omit<CentralEntry, 'nameBytes' | 'offset'>) {
  const buf = new Uint8Array(30 + nameBytes.length)
  const view = new DataView(buf.buffer)
  view.setUint32(0, LOCAL_SIG, true)
  view.setUint16(4, 20, true) // version needed
  view.setUint16(6, UTF8_FLAG, true)
  view.setUint16(8, e.method, true)
  view.setUint16(10, DOS_TIME, true)
  view.setUint16(12, DOS_DATE, true)
  view.setUint32(14, e.crc, true)
  view.setUint32(18, e.compressedSize, true)
  view.setUint32(22, e.uncompressedSize, true)
  view.setUint16(26, nameBytes.length, true)
  view.setUint16(28, 0, true) // extra length
  buf.set(nameBytes, 30)
  return buf
}

function writeCentralDirectory(entries: readonly CentralEntry[], cdOffset: number) {
  let size = 0
  for (const e of entries) size += 46 + e.nameBytes.length
  const buf = new Uint8Array(size + 22)
  const view = new DataView(buf.buffer)
  let p = 0
  for (const e of entries) {
    view.setUint32(p, CENTRAL_SIG, true)
    view.setUint16(p + 4, 20, true) // version made by
    view.setUint16(p + 6, 20, true) // version needed
    view.setUint16(p + 8, UTF8_FLAG, true)
    view.setUint16(p + 10, e.method, true)
    view.setUint16(p + 12, DOS_TIME, true)
    view.setUint16(p + 14, DOS_DATE, true)
    view.setUint32(p + 16, e.crc, true)
    view.setUint32(p + 20, e.compressedSize, true)
    view.setUint32(p + 24, e.uncompressedSize, true)
    view.setUint16(p + 28, e.nameBytes.length, true)
    view.setUint16(p + 30, 0, true) // extra
    view.setUint16(p + 32, 0, true) // comment
    view.setUint16(p + 34, 0, true) // disk number
    view.setUint16(p + 36, 0, true) // internal attrs
    view.setUint32(p + 38, 0, true) // external attrs
    view.setUint32(p + 42, e.offset, true)
    buf.set(e.nameBytes, p + 46)
    p += 46 + e.nameBytes.length
  }
  view.setUint32(p, EOCD_SIG, true)
  view.setUint16(p + 4, 0, true) // this disk
  view.setUint16(p + 6, 0, true) // disk with CD start
  view.setUint16(p + 8, entries.length, true)
  view.setUint16(p + 10, entries.length, true)
  view.setUint32(p + 12, size, true)
  view.setUint32(p + 16, cdOffset, true)
  view.setUint16(p + 20, 0, true) // comment length
  return buf
}

export interface ZipStreamWriter {
  /** Archive bytes, emitted entry by entry. Hand straight to a Response body. */
  readonly readable: ReadableStream<Uint8Array>
  /** Add a deflated JSON entry. */
  addJson(name: string, value: unknown): Promise<void>
  /** Add a stored (uncompressed) entry — for already-compressed blobs. */
  addStored(name: string, bytes: Uint8Array): Promise<void>
  /** Write the central directory and close the stream. */
  finish(): Promise<void>
  /** Tear the stream down so the client sees a truncated (invalid) archive
   *  rather than a well-formed one that silently lost entries. */
  abort(reason: unknown): Promise<void>
}

export function createZipStream(): ZipStreamWriter {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const writer = writable.getWriter()
  const entries: CentralEntry[] = []
  let offset = 0

  // Every write awaits the writer, so a slow consumer (or a slow R2 read
  // feeding us) applies backpressure instead of queueing the whole archive.
  async function push(bytes: Uint8Array) {
    await writer.ready
    await writer.write(bytes)
    offset += bytes.length
    if (offset > MAX_UINT32) throw new Error('zip_too_large')
  }

  async function addEntry(name: string, method: number, raw: Uint8Array, payload: Uint8Array) {
    if (entries.length >= MAX_ENTRIES) throw new Error('zip_too_many_entries')
    const nameBytes = new TextEncoder().encode(name)
    const entry = {
      method,
      crc: crc32(raw),
      compressedSize: payload.length,
      uncompressedSize: raw.length,
    }
    const localOffset = offset
    await push(writeLocalHeader(nameBytes, entry))
    if (payload.length) await push(payload)
    entries.push({ ...entry, nameBytes, offset: localOffset })
  }

  return {
    readable,
    async addJson(name, value) {
      const raw = new TextEncoder().encode(JSON.stringify(value))
      await addEntry(name, METHOD_DEFLATE, raw, deflateSync(raw, { level: 6 }))
    },
    async addStored(name, bytes) {
      await addEntry(name, METHOD_STORE, bytes, bytes)
    },
    async finish() {
      await push(writeCentralDirectory(entries, offset))
      await writer.close()
    },
    async abort(reason) {
      await writer.abort(reason)
    },
  }
}

// --- reader -----------------------------------------------------------------

export interface ZipEntry {
  name: string
  bytes: Uint8Array
}

export interface StreamUnzipOptions {
  /** Called once per entry, in archive order, with the entry fully decoded. */
  onEntry: (entry: ZipEntry) => Promise<void> | void
  /** Reject once the compressed input exceeds this. Guards the request body. */
  maxTotalBytes?: number
  /** Reject once any single entry inflates past this. Zip-bomb guard. */
  maxEntryBytes?: number
}

/** Streaming ZIP read. Entries are surfaced in archive order — which is what
 *  lets an importer act on a manifest written as the first entry before the
 *  blobs that follow it have arrived. Throws `Error('zip_invalid')` on a
 *  malformed archive, `'zip_too_large'` / `'zip_entry_too_large'` on the caps. */
export async function streamUnzip(
  body: ReadableStream<Uint8Array>,
  opts: StreamUnzipOptions,
): Promise<void> {
  const maxTotal = opts.maxTotalBytes ?? Number.POSITIVE_INFINITY
  const maxEntry = opts.maxEntryBytes ?? Number.POSITIVE_INFINITY

  // fflate hands us entry data synchronously inside push(), so completed
  // entries land in this queue and are drained (awaiting the async callback)
  // between chunks rather than during one.
  const ready: ZipEntry[] = []
  let failure: Error | null = null

  const unzip = new Unzip((file) => {
    const chunks: Uint8Array[] = []
    let size = 0
    file.ondata = (err, data, final) => {
      if (failure) return
      if (err) {
        failure = new Error('zip_invalid')
        return
      }
      size += data.length
      if (size > maxEntry) {
        failure = new Error('zip_entry_too_large')
        return
      }
      chunks.push(data)
      if (final) {
        const bytes = new Uint8Array(size)
        let p = 0
        for (const c of chunks) {
          bytes.set(c, p)
          p += c.length
        }
        ready.push({ name: file.name, bytes })
      }
    }
    file.start()
  })
  unzip.register(UnzipInflate)

  const reader = body.getReader()
  let total = 0
  let sawAny = false

  async function drain() {
    if (failure) throw failure
    while (ready.length) {
      sawAny = true
      await opts.onEntry(ready.shift()!)
    }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > maxTotal) throw new Error('zip_too_large')
      try {
        unzip.push(value, false)
      } catch {
        throw new Error('zip_invalid')
      }
      await drain()
    }
    try {
      unzip.push(new Uint8Array(0), true)
    } catch {
      throw new Error('zip_invalid')
    }
    await drain()
  } finally {
    reader.releaseLock()
  }

  if (!sawAny) throw new Error('zip_invalid')
}

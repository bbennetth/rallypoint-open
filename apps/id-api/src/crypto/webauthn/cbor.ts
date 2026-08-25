// Minimal CBOR decoder — ONLY the subset WebAuthn attestation objects
// and COSE keys use: definite-length maps/arrays, byte + text strings,
// unsigned + negative integers, and the three major-7 simple values
// (false/true/null). Deliberately NOT a general CBOR library —
// indefinite lengths, tags, floats, and 64-bit-unsafe integers throw.
// CTAP2 mandates canonical, definite-length CBOR, so this decodes every
// well-formed authenticator response while keeping the attack surface
// tiny (a hand-rolled decoder is exactly where a general one's unused
// branches become risk).

export type CborValue =
  | number
  | boolean
  | null
  | Uint8Array
  | string
  | CborValue[]
  | Map<number | string, CborValue>

export class CborError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CborError'
  }
}

export interface CborDecodeResult {
  value: CborValue
  // Index just past the decoded item — lets a caller (authenticator
  // data) learn the exact byte length of an inline COSE key.
  offset: number
}

export function decodeCbor(bytes: Uint8Array, start = 0): CborDecodeResult {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return readItem(bytes, dv, start)
}

// Decode and assert nothing meaningful trails the first item.
export function decodeCborStrict(bytes: Uint8Array): CborValue {
  const { value, offset } = decodeCbor(bytes, 0)
  if (offset !== bytes.length) throw new CborError('cbor: trailing bytes after item')
  return value
}

function readArgument(
  dv: DataView,
  offset: number,
  additionalInfo: number,
): { arg: number; offset: number } {
  if (additionalInfo < 24) return { arg: additionalInfo, offset }
  if (additionalInfo === 24) return { arg: dv.getUint8(offset), offset: offset + 1 }
  if (additionalInfo === 25) return { arg: dv.getUint16(offset), offset: offset + 2 }
  if (additionalInfo === 26) return { arg: dv.getUint32(offset), offset: offset + 4 }
  if (additionalInfo === 27) {
    const hi = dv.getUint32(offset)
    const lo = dv.getUint32(offset + 4)
    const val = hi * 2 ** 32 + lo
    if (!Number.isSafeInteger(val)) throw new CborError('cbor: 64-bit value exceeds safe integer')
    return { arg: val, offset: offset + 8 }
  }
  // 28-30 reserved; 31 = indefinite length — not valid in CTAP2 canonical CBOR.
  throw new CborError(`cbor: unsupported additional info ${additionalInfo}`)
}

function readItem(bytes: Uint8Array, dv: DataView, offset: number): CborDecodeResult {
  if (offset >= bytes.length) throw new CborError('cbor: unexpected end of input')
  const initialByte = dv.getUint8(offset)
  const majorType = initialByte >> 5
  const additionalInfo = initialByte & 0x1f
  const { arg, offset: afterArg } = readArgument(dv, offset + 1, additionalInfo)
  let cur = afterArg

  switch (majorType) {
    case 0: // unsigned integer
      return { value: arg, offset: cur }
    case 1: // negative integer (COSE labels: -1, -2, -3, …)
      return { value: -1 - arg, offset: cur }
    case 2: {
      // byte string
      const end = cur + arg
      if (end > bytes.length) throw new CborError('cbor: byte string out of range')
      return { value: bytes.subarray(cur, end), offset: end }
    }
    case 3: {
      // text string
      const end = cur + arg
      if (end > bytes.length) throw new CborError('cbor: text string out of range')
      return { value: new TextDecoder().decode(bytes.subarray(cur, end)), offset: end }
    }
    case 4: {
      // array
      const arr: CborValue[] = []
      for (let i = 0; i < arg; i++) {
        const item = readItem(bytes, dv, cur)
        arr.push(item.value)
        cur = item.offset
      }
      return { value: arr, offset: cur }
    }
    case 5: {
      // map
      const map = new Map<number | string, CborValue>()
      for (let i = 0; i < arg; i++) {
        const key = readItem(bytes, dv, cur)
        cur = key.offset
        const val = readItem(bytes, dv, cur)
        cur = val.offset
        if (typeof key.value !== 'number' && typeof key.value !== 'string') {
          throw new CborError('cbor: unsupported map key type')
        }
        map.set(key.value, val.value)
      }
      return { value: map, offset: cur }
    }
    case 7:
      // simple values only (no floats).
      if (additionalInfo === 20) return { value: false, offset: cur }
      if (additionalInfo === 21) return { value: true, offset: cur }
      if (additionalInfo === 22) return { value: null, offset: cur }
      if (additionalInfo === 23) return { value: null, offset: cur } // undefined → null
      throw new CborError('cbor: unsupported simple/float value')
    default:
      throw new CborError(`cbor: unsupported major type ${majorType}`)
  }
}

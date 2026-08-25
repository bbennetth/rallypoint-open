import { decodeCbor } from './cbor.js'

// Authenticator-data parser (WebAuthn §6.1). Layout:
//   rpIdHash   32 bytes
//   flags       1 byte   (bit0 UP, bit2 UV, bit3 BE, bit4 BS, bit6 AT, bit7 ED)
//   signCount   4 bytes  big-endian uint32
//   [attestedCredentialData]  present iff AT flag:
//     aaguid           16 bytes
//     credIdLen         2 bytes  big-endian uint16
//     credId            credIdLen bytes
//     credentialPublicKey  COSE_Key (variable — decoded to learn length)
//   [extensions] present iff ED flag (ignored)

export interface AuthenticatorFlags {
  up: boolean // user present
  uv: boolean // user verified
  be: boolean // backup eligible
  bs: boolean // backup state (synced/backed up)
  at: boolean // attested credential data included
  ed: boolean // extension data included
}

export interface ParsedAuthenticatorData {
  rpIdHash: Uint8Array
  flags: AuthenticatorFlags
  signCount: number
  aaguid?: Uint8Array
  credentialId?: Uint8Array
  credentialPublicKey?: Uint8Array // the exact COSE_Key byte slice (what we store)
}

export function parseAuthenticatorData(authData: Uint8Array): ParsedAuthenticatorData {
  if (authData.length < 37) throw new Error('authData: shorter than the 37-byte fixed header')
  const dv = new DataView(authData.buffer, authData.byteOffset, authData.byteLength)

  const rpIdHash = authData.subarray(0, 32)
  const flagsByte = dv.getUint8(32)
  const flags: AuthenticatorFlags = {
    up: (flagsByte & 0x01) !== 0,
    uv: (flagsByte & 0x04) !== 0,
    be: (flagsByte & 0x08) !== 0,
    bs: (flagsByte & 0x10) !== 0,
    at: (flagsByte & 0x40) !== 0,
    ed: (flagsByte & 0x80) !== 0,
  }
  const signCount = dv.getUint32(33)
  const parsed: ParsedAuthenticatorData = { rpIdHash, flags, signCount }

  if (flags.at) {
    if (authData.length < 55) throw new Error('authData: attested-credential-data truncated')
    parsed.aaguid = authData.subarray(37, 53)
    const credIdLen = dv.getUint16(53)
    const credIdStart = 55
    const credIdEnd = credIdStart + credIdLen
    if (authData.length < credIdEnd) throw new Error('authData: credential id truncated')
    parsed.credentialId = authData.subarray(credIdStart, credIdEnd)
    // The COSE public key runs from credIdEnd to wherever its CBOR ends;
    // decode to learn that length so we store the exact key bytes.
    const { offset: keyEnd } = decodeCbor(authData, credIdEnd)
    parsed.credentialPublicKey = authData.subarray(credIdEnd, keyEnd)
  }

  return parsed
}

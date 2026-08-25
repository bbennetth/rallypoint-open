// One error type for every WebAuthn verification failure. Handlers map
// it to a single generic 401/400 so a caller can't distinguish "wrong
// origin" from "bad signature" from "replayed challenge".
export class WebAuthnError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WebAuthnError'
  }
}

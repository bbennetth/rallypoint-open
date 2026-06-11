import { errors } from '../errors.js'

// Shared JSON-body reader. Converts a malformed/absent body into the
// standard body_invalid 400 rather than letting the raw parse error
// bubble to the 500 handler.
export async function readJsonBody(c: { req: { raw: Request } }): Promise<unknown> {
  try {
    return await c.req.raw.json()
  } catch {
    throw errors.bodyInvalid()
  }
}

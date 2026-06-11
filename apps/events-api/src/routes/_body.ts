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

// Like readJsonBody but treats an empty body as `{}`. For endpoints whose
// request body is entirely optional (e.g. generate-days, where an absent
// range means "use the event's own dates").
export async function readOptionalJsonBody(c: { req: { raw: Request } }): Promise<unknown> {
  const text = await c.req.raw.text()
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw errors.bodyInvalid()
  }
}

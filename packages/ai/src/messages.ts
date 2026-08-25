import {
  type TraceContentPart,
  type TraceImage,
  type TraceMessage,
  type TraceRecord,
} from './types.js'

// Converters between the Workers-AI (OpenAI-style) chat input/output
// shapes and the vendor-neutral trace format. The input converter also
// strips multi-MB base64 data-URL images out of the messages, handing the
// raw bytes back separately so they travel to ai-api as structured-clone
// Uint8Arrays (and land in R2) instead of bloating request_json.

interface OpenAiImagePart {
  type: 'image_url'
  image_url?: { url?: string }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function dataUrlToBytes(url: string): { bytes: Uint8Array; mimeType: string } | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url)
  if (!match) return null
  try {
    const binary = atob(match[2]!)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return { bytes, mimeType: match[1]! }
  } catch {
    return null
  }
}

function toRole(role: unknown): TraceMessage['role'] {
  return role === 'system' || role === 'assistant' ? role : 'user'
}

/** Convert a Workers AI chat `input` (the object passed to `ai.run`) into
 * the trace request shape. Data-URL image parts become `image_r2`
 * placeholders (`#<index>`) with the decoded bytes collected into
 * `images`; non-message params (max_tokens, guided_json, ...) are kept as
 * `params`. Unrecognized shapes degrade to a JSON-stringified text part
 * rather than throwing — tracing must never break the call path. */
export function extractTraceRequest(input: Record<string, unknown>): {
  request: NonNullable<TraceRecord['request']>
  images: TraceImage[]
} {
  const images: TraceImage[] = []
  const messages: TraceMessage[] = []
  const rawMessages = Array.isArray(input['messages']) ? input['messages'] : []
  for (const raw of rawMessages) {
    if (!isRecord(raw)) continue
    const content = raw['content']
    const parts: TraceContentPart[] = []
    if (typeof content === 'string') {
      parts.push({ type: 'text', text: content })
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (!isRecord(part)) continue
        if (part['type'] === 'text' && typeof part['text'] === 'string') {
          parts.push({ type: 'text', text: part['text'] })
        } else if (part['type'] === 'image_url') {
          const url = (part as unknown as OpenAiImagePart).image_url?.url
          const decoded = typeof url === 'string' ? dataUrlToBytes(url) : null
          if (decoded) {
            const index = images.length
            images.push({ index, bytes: decoded.bytes, mimeType: decoded.mimeType })
            parts.push({
              type: 'image_r2',
              key: `#${index}`,
              mimeType: decoded.mimeType,
              bytes: decoded.bytes.byteLength,
            })
          } else {
            // Non-data URL (or undecodable): keep the reference as text so
            // the trace still records that an image was sent.
            parts.push({ type: 'text', text: `[image: ${typeof url === 'string' ? url.slice(0, 200) : 'unknown'}]` })
          }
        } else {
          parts.push({ type: 'text', text: JSON.stringify(part) })
        }
      }
    } else if (content !== undefined) {
      parts.push({ type: 'text', text: JSON.stringify(content) })
    }
    messages.push({ role: toRole(raw['role']), content: parts })
  }
  const params: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (key !== 'messages') params[key] = value
  }
  const request: NonNullable<TraceRecord['request']> =
    Object.keys(params).length > 0 ? { messages, params } : { messages }
  return { request, images }
}

/** Convert a Workers AI result into the trace response shape. Handles the
 * guided_json object shape (`response` already parsed), the plain text
 * shape, and the REST-style `choices` fallback. Also surfaces `usage`
 * token counts when the runtime provides them. */
export function extractTraceResponse(result: unknown): {
  response: NonNullable<TraceRecord['response']>
  tokensIn?: number | undefined
  tokensOut?: number | undefined
} {
  let text = ''
  let tokensIn: number | undefined
  let tokensOut: number | undefined
  if (isRecord(result)) {
    const response = result['response']
    if (typeof response === 'string') {
      text = response
    } else if (isRecord(response)) {
      text = JSON.stringify(response)
    } else {
      const choices = result['choices']
      const first = Array.isArray(choices) && isRecord(choices[0]) ? choices[0] : undefined
      const message = first && isRecord(first['message']) ? first['message'] : undefined
      const content = message?.['content']
      const description = result['description']
      text =
        typeof content === 'string' ? content : typeof description === 'string' ? description : ''
    }
    const usage = result['usage']
    if (isRecord(usage)) {
      if (typeof usage['prompt_tokens'] === 'number') tokensIn = usage['prompt_tokens']
      if (typeof usage['completion_tokens'] === 'number') tokensOut = usage['completion_tokens']
    }
  } else if (typeof result === 'string') {
    text = result
  }
  return {
    response: { messages: [{ role: 'assistant', content: [{ type: 'text', text }] }] },
    tokensIn,
    tokensOut,
  }
}

// Workers AI result recovery — the shared "get the JSON payload out of
// whatever shape the runtime returned" layer. Generalized from
// fitness-api's battle-tested vision parsers (vision-chat.ts /
// vision.ts), which now re-export from here.
//
// Observed result shapes across binding/model revisions:
//   - `{ response: {...} }`            guided_json, already parsed (verified
//                                      live 2026-07-14)
//   - `{ response: "…{json}…" }`       the same payload as a STRING, with or
//                                      without prose around it
//   - `{ choices: [{ message: { content } }] }`  OpenAI-compat envelope;
//                                      content is a string or a content-part
//                                      array
//   - `{ description: "..." }`         legacy caption-style results
// Schema validation stays app-side (this package is dependency-free);
// this layer only recovers a plain object + explains failures.

/** The loose union of result shapes the Workers AI binding returns for
 * chat/vision models. Kept intentionally wide — recovery probes shapes at
 * runtime rather than trusting the compile-time type. */
export interface AiRunResult {
  response?: string | Record<string, unknown>
  description?: string
  choices?: Array<{ message?: { content?: unknown } }>
}

/** Best-effort text view of a result. OpenAI-style content-part arrays
 * (`[{type:'text',text}, …]`) are joined; non-string shapes yield ''. */
export function aiResultText(res: AiRunResult): string {
  if (typeof res.response === 'string') return res.response
  const content = res.choices?.[0]?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text'
          ? String((part as { text?: unknown }).text ?? '')
          : '',
      )
      .join('')
  }
  return res.description ?? ''
}

/** The guided_json happy path: `response` arrives already parsed. Returns
 * null when the result is text-shaped (or an array — never a valid
 * payload for an object-schema'd call). */
export function aiResultObject(res: AiRunResult): Record<string, unknown> | null {
  return typeof res.response === 'object' && res.response !== null && !Array.isArray(res.response)
    ? res.response
    : null
}

// Scan `text` for the first top-level balanced {...} block and return it, or
// null if none exists. A greedy regex like /\{[\s\S]*\}/ fails when the model
// emits multiple objects or wraps the object in prose that contains braces —
// it over-captures from the first `{` to the LAST `}`. Brace-counting gives
// the correct first-balanced span even when the object contains nested objects.
// Strings with `{` inside them are handled conservatively (we skip over
// quoted runs so an escaped brace inside a JSON string doesn't mis-close the
// object). This is not a full JSON tokenizer — it's good enough for the model
// output format we expect here (a single well-formed JSON object per prompt).
export function extractFirstJsonObject(text: string): string | null {
  let start = -1
  let depth = 0
  let inString = false
  let escape = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (escape) {
      escape = false
      continue
    }
    if (ch === '\\' && inString) {
      escape = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}') {
      // Guard against a stray leading `}` (no matching open): without this,
      // depth would go negative and never return to 0 again, so a valid
      // object later in the string would be missed. Mirrors extractLastJsonObject.
      if (depth > 0) {
        depth--
        if (depth === 0 && start !== -1) {
          return text.slice(start, i + 1)
        }
      }
    }
  }
  return null
}

// Same brace-balanced scan as extractFirstJsonObject, but returns the LAST
// top-level {...} block instead of the first. Used when the model is asked to
// reason in prose before emitting the JSON: the answer object is the final
// balanced span, and any stray `{` in the reasoning precedes it, so taking the
// last object is more robust than the first for a reason-then-JSON reply.
export function extractLastJsonObject(text: string): string | null {
  let start = -1
  let depth = 0
  let inString = false
  let escape = false
  let last: string | null = null
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (escape) {
      escape = false
      continue
    }
    if (ch === '\\' && inString) {
      escape = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}') {
      if (depth > 0) {
        depth--
        if (depth === 0 && start !== -1) {
          last = text.slice(start, i + 1)
        }
      }
    }
  }
  return last
}

// True when `text` contains a top-level `{` that never balances — i.e. the
// reply was cut off mid-object at the token cap. String/escape-aware so a `{`
// inside a JSON string value isn't miscounted. Distinct from "no JSON at all":
// used to label the reason-then-JSON food failure as truncation even when an
// earlier complete (stray) object was the one extracted — a complete but
// merely schema-invalid object has balanced braces, so it is NOT flagged here.
export function hasUnterminatedJsonObject(text: string): boolean {
  let depth = 0
  let inString = false
  let escape = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (escape) {
      escape = false
      continue
    }
    if (ch === '\\' && inString) {
      escape = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === '{') depth++
    else if (ch === '}' && depth > 0) depth--
  }
  return depth > 0
}

export type JsonRecoveryFailure = 'no_json' | 'truncated' | 'malformed' | 'non_object'

/** Shape evidence attached to every recovery failure — enough to diagnose
 * a new binding/model result shape from a log line alone, without
 * reproducing the call. */
export interface JsonRecoveryDiagnostics {
  /** `typeof res.response` — 'undefined' when the key is absent. */
  responseType: string
  /** Top-level keys of the raw result object. */
  resultKeys: string[]
  /** First 300 chars of the text view (may be '' for exotic shapes). */
  rawPreview: string
}

export type JsonRecovery =
  | { ok: true; object: Record<string, unknown> }
  | { ok: false; failure: JsonRecoveryFailure; diagnostics: JsonRecoveryDiagnostics }

/** Recover the JSON payload from a Workers AI result: parsed object →
 * text view → balanced-brace extract → JSON.parse. Never throws; a
 * failure carries {@link JsonRecoveryDiagnostics} instead of a bare null
 * so no caller is ever blind to WHY a result was unusable. `extract`
 * defaults to first-object (guided/structured calls); reason-then-JSON
 * prompts should pass {@link extractLastJsonObject}. */
export function recoverJsonPayload(
  res: AiRunResult,
  opts: { extract?: (text: string) => string | null } = {},
): JsonRecovery {
  const obj = aiResultObject(res)
  if (obj) return { ok: true, object: obj }
  const raw = aiResultText(res)
  const diagnostics = (): JsonRecoveryDiagnostics => ({
    responseType: typeof res.response,
    resultKeys: Object.keys(res as Record<string, unknown>),
    rawPreview: raw.slice(0, 300),
  })
  const extract = opts.extract ?? extractFirstJsonObject
  const candidate = extract(raw)
  if (candidate === null) {
    return {
      ok: false,
      failure: hasUnterminatedJsonObject(raw) ? 'truncated' : 'no_json',
      diagnostics: diagnostics(),
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(candidate)
  } catch {
    return { ok: false, failure: 'malformed', diagnostics: diagnostics() }
  }
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    return { ok: true, object: parsed as Record<string, unknown> }
  }
  return { ok: false, failure: 'non_object', diagnostics: diagnostics() }
}

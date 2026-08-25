import type { AiRunResult } from '@rallypoint/ai'
import type { AiRunOptions } from './ai-options.js'

// Shared plumbing for the two Workers AI vision passes (WOD whiteboard
// scan + food-photo scan). Model choice is a policy decision: Meta/Llama
// models (and Llama-derived ones like Llava) are off the table — Llama
// 3.2 vision is gated behind a per-account license agreement (AiError
// 5016) whose terms we don't accept. Mistral Small 3.1 is Apache-2.0,
// vision-capable, and ungated on Workers AI.
export const VISION_MODEL = '@cf/mistralai/mistral-small-3.1-24b-instruct'

// The result union moved to @rallypoint/ai's AiRunResult when result
// recovery was lifted into the shared pipeline; the alias keeps fitness's
// existing imports stable.
export type VisionRunResult = AiRunResult

export interface AiBinding {
  run(
    model: string,
    input: Record<string, unknown>,
    options?: AiRunOptions,
  ): Promise<VisionRunResult>
}

// btoa takes a binary string; build it in chunks so a multi-MB photo
// doesn't blow the String.fromCharCode argument limit.
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

// Mistral Small 3.1 on Workers AI takes the OpenAI-style multimodal
// `messages` shape (verified against the live REST endpoint); the old
// `{ image: number[], prompt }` shape is Llama/Llava-specific.
// `guidedJson` maps to the model's vLLM-style `guided_json` parameter:
// decoding is constrained to the given JSON Schema, so the model can't
// emit prose around (or instead of) the object we parse.
export function buildVisionInput(
  prompt: string,
  image: Uint8Array,
  mimeType: string,
  maxTokens: number,
  guidedJson?: Record<string, unknown>,
): Record<string, unknown> {
  const url = `data:${mimeType};base64,${bytesToBase64(image)}`
  return {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url } },
        ],
      },
    ],
    max_tokens: maxTokens,
    ...(guidedJson ? { guided_json: guidedJson } : {}),
  }
}

/** Build a text-only chat input (no image) — the text food scan
 * ("I ate 5 cherries") rides the same model + result plumbing as the
 * vision passes, minus the image part. */
export function buildTextChatInput(
  systemPrompt: string,
  userText: string,
  maxTokens: number,
  guidedJson?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userText },
    ],
    max_tokens: maxTokens,
    ...(guidedJson ? { guided_json: guidedJson } : {}),
  }
}

export interface LabeledVisionImage {
  label: string
  image: Uint8Array
  mimeType: string
}

/** Build one ordered multimodal user message with explicit text labels
 * immediately before each image. This lets a model distinguish a primary
 * quantity photo from supporting packaging/menu evidence. */
export function buildLabeledVisionInput(
  prompt: string,
  images: LabeledVisionImage[],
  maxTokens: number,
  guidedJson?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          ...images.flatMap((image) => [
            { type: 'text', text: image.label },
            {
              type: 'image_url',
              image_url: {
                url: `data:${image.mimeType};base64,${bytesToBase64(image.image)}`,
              },
            },
          ]),
        ],
      },
    ],
    max_tokens: maxTokens,
    ...(guidedJson ? { guided_json: guidedJson } : {}),
  }
}

// Result-view helpers moved to @rallypoint/ai (aiResultText/aiResultObject)
// with the shared recovery pipeline; the aliases keep fitness's existing
// imports stable. Semantics are unchanged for every shape fitness sees,
// plus two hardenings: OpenAI-style content-part arrays now join their
// text parts (previously an unusable non-string leaked through the type),
// and an array-shaped `response` is no longer mistaken for the guided_json
// object.
export { aiResultText as visionResultText, aiResultObject as visionResultObject } from '@rallypoint/ai'

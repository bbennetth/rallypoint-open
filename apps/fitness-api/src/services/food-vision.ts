import {
  drinkScanResultSchema,
  foodScanResultSchema,
  nutritionLabelResultSchema,
  type DrinkScanResult,
  type FoodScanResult,
  type NutritionLabelResult,
} from '@rallypoint/fitness-shared'
import type { ZodType } from 'zod'
import { aiGatewayOptions } from './ai-options.js'
import {
  extractFirstJsonObject,
  extractLastJsonObject,
  hasUnterminatedJsonObject,
} from './vision.js'
import {
  VISION_MODEL,
  buildLabeledVisionInput,
  buildTextChatInput,
  buildVisionInput,
  visionResultObject,
  visionResultText,
  type AiBinding,
  type VisionRunResult,
} from './vision-chat.js'
import type { FoodVisionService } from './types.js'
import { runTracedVision, type ScanTrace } from './ai-trace-run.js'

// Workers AI vision pass for the food-photo scan (issue #700). Same
// contract as the whiteboard scan (vision.ts): image + prompt in, strict
// JSON out, Zod-validated, throw → route 502. Model choice lives in
// vision-chat.ts (Mistral Small 3.1 — no Meta/Llama models).
//
// The clarifying-question loop is stateless: when the model can't pin a
// detail down (white vs brown rice), it returns `questions`; the client
// re-POSTs the same image with the user's answers appended to `context`.

export const FOOD_VISION_MODEL = VISION_MODEL

const SYSTEM_PROMPT = `\
You are a nutrition analyst estimating one meal from labeled images. Use the
FOOD PHOTO as the source of truth for the quantity actually consumed. Use an
optional MENU OR INGREDIENT PHOTO only for identity, ingredients, and explicit
serving or recipe-yield information.
Work in two steps.
STEP 1 — think briefly (2-4 sentences). Anchor each component's size on visible
reference objects before guessing from appearance alone: a standard dinner
plate is 26-28 cm across, a fork or spoon about 18-20 cm long, an adult hand
about 18 cm, a soda can 330 ml, a water bottle 500 ml. Judge portion
depth/height as well as coverage — a heaped plate weighs far more than a thin
layer. Do NOT use the characters { or } anywhere in this reasoning.
Give your best HONEST estimate. Do not invent false precision and do not force
artificially "un-round" numbers — if a portion genuinely looks like ~100 g,
report 100 g. A real estimate is better than a fake-precise one.
For discrete COUNTABLE items — eggs, slices of bread, strips of bacon, whole
fruit, cookies, tortillas, meatballs, sausages — set "count" to how many are
visible and "unit" to the SINGULAR item noun (e.g. count 2, unit "egg"; count
3, unit "slice"). The app refines the weight of countable items from a
reference table, so get the count and unit right and don't agonise over their
grams. Leave "count" and "unit" null for amorphous foods (rice, sauce, salad,
yogurt, soup) and give those your best gram estimate. Estimate each item's
TOTAL macros for its weight (not per-100g).
STEP 2 — after the reasoning, output ONLY this JSON object as the LAST thing in
your reply (no text after it):
{
  "mealName": "short combined meal name or null",
  "estimatedServings": 1.5,
  "items": [
    { "name": "string", "count": 2 or null, "unit": "egg or null",
      "estimatedGrams": number, "kcal": number,
      "proteinG": number, "carbsG": number, "fatG": number }
  ],
  "questions": ["ask ONLY when an ambiguity materially changes the macros,
    e.g. 'Is this white or brown rice?' — otherwise []"]
}
When food is present, mealName and estimatedServings are required. Portions may
be decimal servings. Default an unresolved pictured portion to 1 serving, but
ask a question when serving/yield ambiguity would materially change nutrition.
If the user provided context (total weight, ingredients, answers to your
previous questions), treat it as ground truth and scale your estimates to it.
Lines starting with "Correction:" override what you see in the photo: if the
user says an item is not present (or names it differently), remove or rename
it and NEVER re-add an item the user said is not there.
If the food photo contains no food, return
{"mealName":null,"estimatedServings":null,"items":[],"questions":[]}.`

// The food pass deliberately runs WITHOUT guided_json. Constrained decoding
// forces the object token-by-token with no room to reason, which produces
// lazy, round-number weight guesses (an even 50/100 g on everything). Letting
// the model reason about reference objects first — then emit the JSON as the
// last balanced object (extractLastJsonObject) — yields materially better
// portion estimates. Zod (foodScanResultSchema) remains the validator, and
// reference weights (fitness-shared applyReferenceWeight) ground the countable
// items after parsing.

// 1024 proved too tight once user context is in play: the reply got cut off
// mid-object and the scan 502'd ("returned no JSON object", PostHog
// 2026-07-14). 3072 fits the reasoning preamble + 20 items + 5 questions. The
// drink pass returns a tiny object, so a smaller cap is plenty.
const MAX_TOKENS = 3072
const DRINK_MAX_TOKENS = 256

// The text-described meal pass — "the photo scanner, text only". No
// image: quantities come from the words, so stated amounts are ground
// truth and everything else defaults to one typical serving. Unlike the
// photo pass this one CAN use guided_json: there are no reference objects
// to reason about, so constrained decoding costs nothing and keeps the
// reply compact (faster + no prose extraction).
const TEXT_MAX_TOKENS = 1024
const TEXT_SYSTEM_PROMPT = `\
You are a nutrition analyst estimating a meal from the user's TEXT
description. There is no photo — quantities come from the words. When the
user states an amount ("5 cherries", "two slices of toast", "300 g of
rice"), treat it as ground truth; otherwise assume ONE typical serving of
that food as commonly eaten.
For discrete COUNTABLE items — eggs, slices of bread, strips of bacon,
whole fruit, cookies, meatballs — set "count" to the stated number and
"unit" to the SINGULAR item noun (e.g. count 5, unit "cherry"). The app
refines countable weights from a reference table, so get the count and
unit right and don't agonise over their grams. Leave "count" and "unit"
null for amorphous foods (rice, sauce, salad, soup) and give those your
best gram estimate. Estimate each item's TOTAL macros for its weight (not
per-100g). Give honest estimates — no fake precision.
Reply with ONLY this JSON object:
{
  "mealName": "short combined meal name or null",
  "estimatedServings": 1,
  "items": [
    { "name": "string", "count": 5 or null, "unit": "cherry or null",
      "estimatedGrams": number, "kcal": number,
      "proteinG": number, "carbsG": number, "fatG": number }
  ],
  "questions": ["ask ONLY when an ambiguity materially changes the macros,
    e.g. 'Was the chicken fried or grilled?' — otherwise []"]
}
When food is present, mealName and estimatedServings are required
(default 1). If the user provided context (answers to your previous
questions), treat it as ground truth. Lines starting with "Correction:"
override earlier assumptions.
If the text describes nothing edible, return
{"mealName":null,"estimatedServings":null,"items":[],"questions":[]}.`

// Shape only — foodScanResultSchema (Zod) stays the validator.
const TEXT_GUIDED_JSON_SCHEMA = {
  type: 'object',
  properties: {
    mealName: { type: ['string', 'null'] },
    estimatedServings: { type: ['number', 'null'] },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          count: { type: ['number', 'null'] },
          unit: { type: ['string', 'null'] },
          estimatedGrams: { type: 'number' },
          kcal: { type: 'number' },
          proteinG: { type: 'number' },
          carbsG: { type: 'number' },
          fatG: { type: 'number' },
        },
        required: ['name', 'count', 'unit', 'estimatedGrams', 'kcal', 'proteinG', 'carbsG', 'fatG'],
      },
    },
    questions: { type: 'array', items: { type: 'string' } },
  },
  required: ['mealName', 'estimatedServings', 'items', 'questions'],
}

// The mixed-drink pass (issue #713): identify the spirit + mixer so the
// stepper can prefill. Guesses are hints, never final — the user always
// confirms the pour, so an unsure guess should be null with low
// confidence rather than a fabricated one.
const DRINK_SYSTEM_PROMPT = `\
You are looking at a photo of an alcoholic drink or its bottles. Identify
the base spirit (vodka, gin, rum, tequila, whiskey, brandy) and the mixer
(cola, tonic, diet soda, orange juice, etc). Reply with ONLY this JSON
object (no prose):
{ "spirit": "string or null", "mixer": "string or null",
  "confidence": "low" | "medium" | "high" }
Use null for anything you cannot see. If the user provided context, treat
it as ground truth.`

const DRINK_GUIDED_JSON_SCHEMA = {
  type: 'object',
  properties: {
    spirit: { type: ['string', 'null'] },
    mixer: { type: ['string', 'null'] },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
  },
  required: ['spirit', 'mixer', 'confidence'],
}

// The nutrition-label pass (unknown-UPC fallback): transcribe the panel
// verbatim. This is OCR-of-a-printed-table, not estimation — the prompt
// leans hard on "report the exact printed values". The output is the raw
// per-serving read; normalizeNutritionLabel (fitness-shared) does the
// per-100g math and rejects implausible reads. A small object → a small
// cap. Single-shot: labels are deterministic, so no clarify loop.
const LABEL_MAX_TOKENS = 512
const LABEL_SYSTEM_PROMPT = `\
You are transcribing a packaged food's Nutrition Facts panel. Report the
EXACT printed values — do not estimate, round, or infer. Reply with ONLY
this JSON object (no prose):
{
  "name": "product name or null",
  "brand": "brand or null",
  "servingGrams": number or null,
  "servingUnit": "g" | "ml" | null,
  "perServing": { "kcal": number, "proteinG": number, "carbsG": number,
    "fatG": number } or null
}
Read macros PER SERVING (the "Amount per serving" column) — never the
per-container or any per-100g column. servingGrams is the serving size in
grams only: "55g (about 1 bar)" or "2/3 cup (55g)" → 55. If the serving
is a volume (fl oz / mL), use the mL number and set servingUnit to "ml";
otherwise servingUnit is "g". Read the product name and brand from the
PRODUCT FRONT photo when one is provided, otherwise from the label. Use
null for any field you cannot read. If the image is not a readable
nutrition label, set servingGrams and perServing to null.`

// Shape only (guided decoding just needs the structure) — Zod's
// nutritionLabelResultSchema stays the source of truth for units/bounds.
const LABEL_GUIDED_JSON_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: ['string', 'null'] },
    brand: { type: ['string', 'null'] },
    servingGrams: { type: ['number', 'null'] },
    servingUnit: { type: ['string', 'null'] },
    perServing: {
      type: ['object', 'null'],
      properties: {
        kcal: { type: 'number' },
        proteinG: { type: 'number' },
        carbsG: { type: 'number' },
        fatG: { type: 'number' },
      },
      required: ['kcal', 'proteinG', 'carbsG', 'fatG'],
    },
  },
  required: ['name', 'brand', 'servingGrams', 'servingUnit', 'perServing'],
}

// Shared extract-and-validate for every vision pass. With guided_json,
// Workers AI returns `response` as the parsed object; older/text and the
// (reasoning) food pass carry the JSON as a string in `response` /
// choices[].message.content, which the `extract` scanner recovers. The food
// pass reasons before the object, so it passes extractLastJsonObject (the
// answer is the final balanced span); the guided passes default to
// extractFirstJsonObject. A `{` with no balancing `}` means the reply was
// truncated at the token cap — a distinct failure from the model emitting no
// JSON at all; keep them separable in error tracking. `label` prefixes the
// thrown messages per pass.
function parseVisionResult<T>(
  res: VisionRunResult,
  schema: ZodType<T>,
  label: string,
  extract: (text: string) => string | null = extractFirstJsonObject,
): T {
  const objResult = visionResultObject(res)
  if (objResult !== null) {
    const validated = schema.safeParse(objResult)
    if (!validated.success) {
      throw new Error(`${label} vision model output failed schema validation.`)
    }
    return validated.data
  }
  const raw = visionResultText(res)
  const jsonCandidate = extract(raw)
  if (jsonCandidate === null) {
    throw new Error(
      hasUnterminatedJsonObject(raw)
        ? `${label} vision model returned truncated JSON (unbalanced braces).`
        : `${label} vision model returned no JSON object.`,
    )
  }
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(jsonCandidate)
  } catch {
    throw new Error(`${label} vision model returned malformed JSON.`)
  }
  const validated = schema.safeParse(parsedJson)
  if (!validated.success) {
    // In reason-then-JSON mode the extracted object may be a stray brace pair
    // from the reasoning while the real answer was truncated at the cap. A
    // dangling top-level `{` in the raw reply is the truncation tell; a
    // complete-but-schema-invalid object has balanced braces and stays a
    // schema-validation error.
    throw new Error(
      hasUnterminatedJsonObject(raw)
        ? `${label} vision model returned truncated JSON (unbalanced braces).`
        : `${label} vision model output failed schema validation.`,
    )
  }
  return validated.data
}

export function createFoodVisionService(ai: AiBinding, gatewayId?: string): FoodVisionService {
  const gateway = aiGatewayOptions(gatewayId)

  // Shared plumbing for both vision passes: build the multimodal input,
  // extract the JSON (guided-object first, text fallback), Zod-validate.
  async function runVision<T>(opts: {
    systemPrompt: string
    guidedSchema: Record<string, unknown>
    schema: ZodType<T>
    maxTokens: number
    image: Uint8Array
    mimeType: string
    context?: string
    label: string
    feature: string
    trace?: ScanTrace | undefined
  }): Promise<T> {
    const prompt =
      opts.context && opts.context.trim() !== ''
        ? `${opts.systemPrompt}\n\nUser context:\n${opts.context.trim()}`
        : opts.systemPrompt
    const res = await runTracedVision(
      ai,
      FOOD_VISION_MODEL,
      buildVisionInput(prompt, opts.image, opts.mimeType, opts.maxTokens, opts.guidedSchema),
      gateway,
      opts.feature,
      opts.trace,
    )
    return parseVisionResult(res, opts.schema, opts.label)
  }

  return {
    async analyzeFoodImage(
      image: Uint8Array,
      mimeType: string,
      context?: string,
      supportingImage?: { image: Uint8Array; mimeType: string },
      trace?: ScanTrace,
    ): Promise<FoodScanResult> {
      const prompt =
        context && context.trim() !== ''
          ? `${SYSTEM_PROMPT}\n\nUser context:\n${context.trim()}`
          : SYSTEM_PROMPT
      const images = [
        { label: 'FOOD PHOTO — consumed quantity:', image, mimeType },
        ...(supportingImage
          ? [
              {
                label: 'MENU OR INGREDIENT PHOTO — identity and serving/yield evidence:',
                image: supportingImage.image,
                mimeType: supportingImage.mimeType,
              },
            ]
          : []),
      ]
      // No guided_json here: the food pass reasons about reference objects
      // before emitting the JSON (see MAX_TOKENS note), so the answer is the
      // LAST balanced object in the reply.
      const res = await runTracedVision(
        ai,
        FOOD_VISION_MODEL,
        buildLabeledVisionInput(prompt, images, MAX_TOKENS),
        gateway,
        'food-scan',
        trace,
      )
      return parseVisionResult(res, foodScanResultSchema, 'Food', extractLastJsonObject)
    },
    async analyzeFoodText(
      text: string,
      context?: string,
      trace?: ScanTrace,
    ): Promise<FoodScanResult> {
      const prompt =
        context && context.trim() !== ''
          ? `${TEXT_SYSTEM_PROMPT}\n\nUser context:\n${context.trim()}`
          : TEXT_SYSTEM_PROMPT
      const res = await runTracedVision(
        ai,
        FOOD_VISION_MODEL,
        buildTextChatInput(prompt, text, TEXT_MAX_TOKENS, TEXT_GUIDED_JSON_SCHEMA),
        gateway,
        'food-text',
        trace,
      )
      return parseVisionResult(res, foodScanResultSchema, 'Food text')
    },
    async analyzeDrinkImage(
      image: Uint8Array,
      mimeType: string,
      context?: string,
      trace?: ScanTrace,
    ): Promise<DrinkScanResult> {
      return runVision({
        systemPrompt: DRINK_SYSTEM_PROMPT,
        guidedSchema: DRINK_GUIDED_JSON_SCHEMA,
        schema: drinkScanResultSchema,
        maxTokens: DRINK_MAX_TOKENS,
        image,
        mimeType,
        ...(context !== undefined ? { context } : {}),
        label: 'Drink',
        feature: 'drink-scan',
        trace,
      })
    },
    async analyzeNutritionLabel(
      image: Uint8Array,
      mimeType: string,
      productImage?: { image: Uint8Array; mimeType: string },
      context?: string,
      trace?: ScanTrace,
    ): Promise<NutritionLabelResult> {
      const prompt =
        context && context.trim() !== ''
          ? `${LABEL_SYSTEM_PROMPT}\n\nUser context:\n${context.trim()}`
          : LABEL_SYSTEM_PROMPT
      const images = [
        { label: 'NUTRITION FACTS LABEL — transcribe exact values:', image, mimeType },
        ...(productImage
          ? [
              {
                label: 'PRODUCT FRONT — name and brand:',
                image: productImage.image,
                mimeType: productImage.mimeType,
              },
            ]
          : []),
      ]
      const res = await runTracedVision(
        ai,
        FOOD_VISION_MODEL,
        buildLabeledVisionInput(prompt, images, LABEL_MAX_TOKENS, LABEL_GUIDED_JSON_SCHEMA),
        gateway,
        'label-scan',
        trace,
      )
      return parseVisionResult(res, nutritionLabelResultSchema, 'Nutrition label')
    },
  }
}

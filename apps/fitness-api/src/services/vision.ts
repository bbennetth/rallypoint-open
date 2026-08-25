import { z } from 'zod'
import { extractFirstJsonObject } from '@rallypoint/ai'
import { scanLoadToKg, wodTypeSchema } from '@rallypoint/fitness-shared'
import { aiGatewayOptions } from './ai-options.js'
import { VISION_MODEL, buildVisionInput, visionResultText, type AiBinding } from './vision-chat.js'
import type { ParsedWodFromImage, VisionService } from './types.js'
import { runTracedVision, type ScanTrace } from './ai-trace-run.js'

// Workers AI vision pass for the whiteboard-photo composer. Runs the
// shared vision model (vision-chat.ts) on the user's image with a
// system prompt that asks the model to emit strict JSON describing the
// WOD, parses + validates the result with Zod, and surfaces a
// 502-shaped error to the route when either step fails.
//
// The extracted shape covers ALL SIX WOD_TYPES. It briefly covered only
// three (for_time / rounds_for_time / amrap) and carried no `rounds` at
// all, so a "10 Rounds" board silently arrived in the composer as the
// emptyComposerState default of 3 — the round count had nowhere to land.
// Anything unreadable comes back null and is dropped, which leaves the
// composer field blank instead of defaulted: a visibly empty box beats a
// plausible wrong number.

const SYSTEM_PROMPT = `\
You are looking at a CrossFit-style whiteboard photo. Extract the workout
into this JSON shape and reply with ONLY the JSON object (no prose):
{
  "type": "for_time" | "rounds_for_time" | "amrap" | "emom" | "interval"
          | "max_reps_rounds" | null,
  "rounds": number or null,          // rounds_for_time / interval / max_reps_rounds
  "scheme": string or null,          // for_time only — the rep ladder, e.g. "21-15-9"
  "capMin": number or null,          // for_time / rounds_for_time — time cap, minutes
  "durationMin": number or null,     // amrap window, or max_reps_rounds clock
  "intervalS": number or null,       // emom — seconds per interval
  "totalIntervals": number or null,  // emom — how many intervals
  "workS": number or null,           // interval — work seconds per station
  "restS": number or null,           // rounds_for_time / interval — rest between rounds
  "movements": [
    { "name": string, "reps": number or null,
      "load": number or null, "loadUnit": "lb" | "kg" | null }
  ],
  "notes": string or null            // optional coach note
}

Choosing the type:
- "10 Rounds For Time"                  -> rounds_for_time
- "For Time" with a rep ladder          -> for_time
- "AMRAP in 20 minutes"                 -> amrap
- "EMOM 30", "Every 90 seconds"         -> emom
- fixed work/rest stations (Fight Gone Bad, Tabata) -> interval
- fixed rounds, each scored for max reps -> max_reps_rounds

Rules:
- "rounds" is the ROUND COUNT from the workout header. "10 Rounds" means
  rounds: 10. NEVER take it from a movement's rep count — in
  "10 Rounds / 3 Shoulder to Overhead / 5 Toes to Bar", rounds is 10, not 3.
- Each movement's "reps" is that movement's own per-round count (3 and 5
  in the example above).
- Report "load" as the number written on the board and "loadUnit" as the
  unit written on the board. Do NOT convert between pounds and kilos.
- When a load gives two values ("155/105 lbs", "95/65"), take the FIRST.
- Use null for anything you cannot read. Never guess a value.
- If you cannot read the workout at all, set every field to null and
  return an empty "movements" array.`

// Mirrors ParsedSchema for the model's constrained decoder. Every key is
// `required` with a nullable type (the vLLM convention the food passes
// use): a model that must emit `"rounds": null` to say "unreadable" is far
// likelier to emit `"rounds": 10` when it IS readable than one that can
// silently drop the key.
//
// Deliberately NO `enum` on `type` / `loadUnit`, even though ParsedSchema
// enforces both strictly. This pass ran fully unconstrained before, so
// turning guided decoding on is already a behavior change on the live
// call, and nothing else in the repo combines `enum` with a nullable
// `type` array — the food passes use `enum` only on a plain
// non-nullable string, and use nullable types only without `enum`. Support
// for that combination is vLLM-backend- and version-dependent, and a
// schema the decoder rejects would 502 every scan in production while
// every test here (which mocks `ai.run`) stayed green. The "must emit an
// explicit null" property comes from `required`, not from `enum`, so
// dropping it costs nothing: wodTypeSchema / z.enum(['lb','kg']) still
// reject a bad value after the fact.
const GUIDED_JSON_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: ['string', 'null'] },
    rounds: { type: ['number', 'null'] },
    scheme: { type: ['string', 'null'] },
    capMin: { type: ['number', 'null'] },
    durationMin: { type: ['number', 'null'] },
    intervalS: { type: ['number', 'null'] },
    totalIntervals: { type: ['number', 'null'] },
    workS: { type: ['number', 'null'] },
    restS: { type: ['number', 'null'] },
    movements: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          reps: { type: ['number', 'null'] },
          load: { type: ['number', 'null'] },
          loadUnit: { type: ['string', 'null'] },
        },
        required: ['name', 'reps', 'load', 'loadUnit'],
      },
    },
    notes: { type: ['string', 'null'] },
  },
  required: [
    'type',
    'rounds',
    'scheme',
    'capMin',
    'durationMin',
    'intervalS',
    'totalIntervals',
    'workS',
    'restS',
    'movements',
    'notes',
  ],
}

// Bounds are at least as tight as wodBodySchema
// (packages/fitness-shared/src/wods.ts) so a value that clears the scan
// can't turn around and 400 at save time. Specifically: `rounds` matches
// the interval / max_reps cap of 50 (rounds_for_time is itself unbounded,
// so 50 is the stricter of the two); `durationMin` is 90, NOT 120 — both
// amrapBodySchema.durationS and maxRepsRoundsBodySchema.durationS top out
// at 90 minutes, and a 120 that cleared this schema would fill the
// composer and then fail validation at save; `capMin` rides timeCapS,
// which allows up to 4h, so 120 is comfortably inside.
// `.nullish()` everywhere because the guided decoder emits explicit nulls
// for unreadable fields rather than omitting the key.
const ParsedSchema = z.object({
  type: wodTypeSchema.nullish(),
  rounds: z.number().int().min(1).max(50).nullish(),
  scheme: z.string().max(120).nullish(),
  capMin: z.number().int().min(1).max(120).nullish(),
  durationMin: z.number().int().min(1).max(90).nullish(),
  intervalS: z
    .number()
    .int()
    .min(5)
    .max(30 * 60)
    .nullish(),
  totalIntervals: z.number().int().min(1).max(120).nullish(),
  workS: z
    .number()
    .int()
    .min(5)
    .max(30 * 60)
    .nullish(),
  restS: z
    .number()
    .int()
    .min(0)
    .max(30 * 60)
    .nullish(),
  // max(20) matches wodBodySchema's movement cap — a hallucinated 25-row
  // list should fail here with a clear 502, not fill 25 composer rows that
  // only blow up at save.
  movements: z
    .array(
      z.object({
        name: z.string().min(1).max(60),
        reps: z.number().int().min(1).max(999).nullish(),
        // Raw board value + the unit it was written in. The lb→kg
        // conversion happens here in code (scanLoadToKg), not silently
        // inside the model, so "155/105 lbs" lands on an exact 70.31 kg.
        load: z.number().min(0).max(2000).nullish(),
        loadUnit: z.enum(['lb', 'kg']).nullish(),
      }),
    )
    .max(20),
  notes: z.string().max(280).nullish(),
})

// The brace-balanced JSON extractors (extractFirstJsonObject /
// extractLastJsonObject / hasUnterminatedJsonObject) moved to
// @rallypoint/ai's shared result-recovery module; these re-exports keep
// fitness-api's existing imports stable.
export {
  extractFirstJsonObject,
  extractLastJsonObject,
  hasUnterminatedJsonObject,
} from '@rallypoint/ai'

export function createVisionService(ai: AiBinding, gatewayId?: string): VisionService {
  const gateway = aiGatewayOptions(gatewayId)
  return {
    async parseWodFromImage(
      image: Uint8Array,
      mimeType: string,
      trace?: ScanTrace,
    ): Promise<ParsedWodFromImage> {
      const res = await runTracedVision(
        ai,
        VISION_MODEL,
        // 768 (was 512) — the object now carries the per-type fields
        // (rounds / intervalS / workS / …) plus a unit per movement.
        buildVisionInput(SYSTEM_PROMPT, image, mimeType, 768, GUIDED_JSON_SCHEMA),
        gateway,
        'wod-scan',
        trace,
      )
      const raw = visionResultText(res)
      // Extract the first balanced {...} block. The greedy /\{[\s\S]*\}/
      // would swallow everything between the first `{` and the last `}`,
      // so when the model emits trailing prose or multiple objects it
      // captures too much and JSON.parse fails. Scanning for balance is the
      // only approach that handles nested objects correctly.
      const jsonCandidate = extractFirstJsonObject(raw)
      if (jsonCandidate === null) {
        throw new Error('Vision model returned no JSON object.')
      }
      let parsedJson: unknown
      try {
        parsedJson = JSON.parse(jsonCandidate)
      } catch {
        throw new Error('Vision model returned malformed JSON.')
      }
      const validated = ParsedSchema.safeParse(parsedJson)
      if (!validated.success) {
        throw new Error('Vision model output failed schema validation.')
      }
      // Re-shape so exactOptionalPropertyTypes is happy: only assign keys
      // whose values are present. Null and undefined both mean "the scan
      // could not read this" and are dropped identically — the composer
      // then leaves the field blank rather than inheriting a default.
      const d = validated.data
      const out: ParsedWodFromImage = {
        type: d.type ?? null,
        movements: d.movements.map((m) => {
          const mv: ParsedWodFromImage['movements'][number] = { name: m.name }
          if (m.reps != null) mv.reps = m.reps
          if (m.load != null) {
            // A board with no unit written on it is pounds — the same
            // product default sanitizeWeightUnit falls back to.
            mv.loadKg = scanLoadToKg(m.load, m.loadUnit ?? 'lb')
          }
          return mv
        }),
      }
      if (d.rounds != null) out.rounds = d.rounds
      if (d.scheme != null) out.scheme = d.scheme
      if (d.capMin != null) out.capMin = d.capMin
      if (d.durationMin != null) out.durationMin = d.durationMin
      if (d.intervalS != null) out.intervalS = d.intervalS
      if (d.totalIntervals != null) out.totalIntervals = d.totalIntervals
      if (d.workS != null) out.workS = d.workS
      if (d.restS != null) out.restS = d.restS
      if (d.notes != null) out.notes = d.notes
      return out
    },
  }
}

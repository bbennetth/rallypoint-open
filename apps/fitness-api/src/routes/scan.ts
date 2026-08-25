import { Hono } from 'hono'
import { z } from 'zod'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import { captureServerException } from '../middleware/error-handler.js'
import { AI_SCAN_RATE_LIMIT, applyPerUserRateLimit } from '../middleware/rate-limit.js'
import { buildScanTrace } from '../lib/ai-trace.js'
import { aiErrorCode, isCapacityError } from '../lib/ai-retry.js'
import { readJsonBody } from './_body.js'

// POST /api/v1/ui/scan/wod — whiteboard-photo OCR backed by Workers
// AI (the design handoff's composer scan flow, Ink redesign S9).
// Body: { imageBase64: string, mimeType: string }. The base64 detour
// lets us ride the existing CSRF + JSON pipeline instead of writing
// new multipart machinery. Returns the parsed composer-shaped WOD or
// a 502 when the AI binding is absent / the parse fails.

const MAX_IMAGE_BYTES = 4 * 1024 * 1024 // 4 MiB after base64 decode
// Base64 expands the binary by 4/3 (plus optional padding). The length
// gate runs as an explicit check (not a Zod .max) so an oversized photo
// gets the specific `image_too_large` error instead of the generic
// "Request body failed validation." envelope.
const MAX_BASE64_CHARS = Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4

const ScanRequestSchema = z.object({
  imageBase64: z.string().min(1),
  mimeType: z.string().regex(/^image\//),
})

function base64ToBytes(b64: string): Uint8Array {
  // atob is available in Workers + the browser; the wrangler test
  // pool sets it up too.
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
}

export const scanRoutes = new Hono<HonoApp>().post(
  '/api/v1/ui/scan/wod',
  async (c) => {
    const vision = c.var.services.vision
    if (!vision) {
      throw errors.notFound('Photo scan is not configured for this deployment.')
    }
    await applyPerUserRateLimit(c, { userId: c.var.session!.userId, ...AI_SCAN_RATE_LIMIT })
    const raw = await readJsonBody(c)
    const parsed = ScanRequestSchema.safeParse(raw)
    if (!parsed.success) {
      throw errors.validation({ issues: parsed.error.issues })
    }
    if (parsed.data.imageBase64.length > MAX_BASE64_CHARS) {
      throw errors.imageTooLarge(MAX_IMAGE_BYTES)
    }
    const bytes = base64ToBytes(parsed.data.imageBase64)
    if (bytes.byteLength === 0) {
      throw errors.validation({
        issues: [{ code: 'custom', path: ['imageBase64'], message: 'Empty image.' }],
      })
    }
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      throw errors.imageTooLarge(MAX_IMAGE_BYTES)
    }
    const trace = await buildScanTrace(c)
    try {
      const result = await vision.parseWodFromImage(bytes, parsed.data.mimeType, trace)
      return c.json({ parsed: result, responseId: trace.lastResponseId ?? null })
    } catch (err) {
      const capacity = isCapacityError(err)
      c.var.logger.error(
        {
          err: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
          capacity,
        },
        'wod vision failed',
      )
      // Enveloped typed error (not a bare `{error: string}` 502) so the
      // browser client surfaces a real code + message; capacity blips map
      // to a retryable 503 like the food scans.
      captureServerException(c, err, {
        status: capacity ? 503 : 502,
        feature: 'wod-scan',
        scan_step: 'photo-scan',
        ai_error_code: aiErrorCode(err),
      })
      throw capacity
        ? errors.aiCapacity()
        : errors.scanFailed('Could not read the workout from that image.')
    }
  },
)

// App-icon upload constraints for the per-event PWA install. Shared so
// the browser rejects bad files before upload and the Worker re-checks
// inline before streaming to R2 — same split as map-constraints.ts.
// Evolve the limits HERE, never in two places.
//
// PNG-only, deliberately: on iOS the `apple-touch-icon` link wins over
// manifest icons, and that link only reliably renders PNG. Accepting
// jpeg/webp would mean the icon silently degrades on exactly the
// platform where "add to home screen" is most used.

export const APP_ICON_MIME_TYPES = ['image/png'] as const
export type AppIconMimeType = (typeof APP_ICON_MIME_TYPES)[number]

export const APP_ICON_MAX_BYTES = 512 * 1024 // 512 KB
// Recommended source size. Not enforced server-side: no image decoder
// runs in the Worker (no sharp/canvas/Cloudflare Images in this repo),
// so dimensions are a UI hint rather than a validated constraint.
export const APP_ICON_RECOMMENDED_EDGE = 512

export const APP_ICON_MIME_EXTENSIONS: Record<AppIconMimeType, string> = {
  'image/png': 'png',
}

export function isAppIconMimeType(value: string): value is AppIconMimeType {
  return (APP_ICON_MIME_TYPES as readonly string[]).includes(value)
}

export type AppIconUploadCheck =
  | { ok: true; mimeType: AppIconMimeType; extension: string }
  | { ok: false; code: 'unsupported_image_type'; field: 'contentType' }
  | { ok: false; code: 'image_too_large'; field: 'contentLength' }

// Pre-upload check: validates the declared MIME type + byte length.
export function validateAppIconUpload(input: {
  contentType: string
  contentLength: number
}): AppIconUploadCheck {
  if (!isAppIconMimeType(input.contentType)) {
    return { ok: false, code: 'unsupported_image_type', field: 'contentType' }
  }
  if (
    !Number.isFinite(input.contentLength) ||
    input.contentLength <= 0 ||
    input.contentLength > APP_ICON_MAX_BYTES
  ) {
    return { ok: false, code: 'image_too_large', field: 'contentLength' }
  }
  return {
    ok: true,
    mimeType: input.contentType,
    extension: APP_ICON_MIME_EXTENSIONS[input.contentType],
  }
}

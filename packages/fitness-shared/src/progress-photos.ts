import { z } from 'zod'

// Progress-picture vocabulary + validators, shared by apps/fitness-api
// and apps/fitness-web. A progress photo is one image at an instant,
// tagged with a `pose` slug (front/back/side are curated; ANY slug is
// allowed so users can add custom angles — "side_flexed", "legs" —
// without a definitions table, mirroring the metrics `kind` pattern).

export interface PoseDef {
  id: string
  label: string
}

export const KNOWN_POSES: readonly PoseDef[] = [
  { id: 'front', label: 'Front' },
  { id: 'back', label: 'Back' },
  { id: 'side', label: 'Side' },
]

export const KNOWN_POSE_IDS: ReadonlySet<string> = new Set(KNOWN_POSES.map((p) => p.id))

// pose slug: lowercase letters/digits/underscore, 1-40 chars. Same
// constraint as the metrics kind slug — queryable + index-friendly.
export const poseSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9_]+$/, 'pose must be a lowercase slug (letters, digits, underscore)')

// Human label for a pose slug: curated label when known, else the slug
// with underscores spaced ("side_flexed" → "side flexed").
export function poseLabel(pose: string): string {
  return KNOWN_POSES.find((p) => p.id === pose)?.label ?? pose.replace(/_/g, ' ')
}

// --- upload constraints ------------------------------------------------
// Shared so the browser rejects bad files before upload and the Worker
// re-checks inline before streaming to R2. Evolve the limits HERE,
// never in two places. jpeg/png/webp are the types the shared
// magic-byte gate (@rallypoint/shared matchesDeclaredType) can verify;
// HEIC is intentionally absent (iOS transcodes on file inputs).

export const PROGRESS_PHOTO_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const
export type ProgressPhotoMimeType = (typeof PROGRESS_PHOTO_MIME_TYPES)[number]

export const PROGRESS_PHOTO_MAX_BYTES = 10 * 1024 * 1024

// Default page size for the list route — shared by the route (cursor
// derivation), the repo (LIMIT fallback), and the gallery UI so they
// can never drift apart.
export const PROGRESS_PHOTO_DEFAULT_LIMIT = 60

// File extension the object key gets, keyed by accepted MIME type.
export const PROGRESS_PHOTO_MIME_EXTENSIONS: Record<ProgressPhotoMimeType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

export function isProgressPhotoMimeType(value: string): value is ProgressPhotoMimeType {
  return (PROGRESS_PHOTO_MIME_TYPES as readonly string[]).includes(value)
}

export type ProgressPhotoUploadCheck =
  | { ok: true; mimeType: ProgressPhotoMimeType; extension: string }
  | { ok: false; code: 'unsupported_photo_type'; field: 'contentType' }
  | { ok: false; code: 'photo_too_large'; field: 'contentLength' }

// Pre-upload check: validates the declared MIME type + byte length. The
// client runs this before upload; the Worker runs it again inline
// before streaming the bytes to R2.
export function validateProgressPhotoUpload(input: {
  contentType: string
  contentLength: number
}): ProgressPhotoUploadCheck {
  if (!isProgressPhotoMimeType(input.contentType)) {
    return { ok: false, code: 'unsupported_photo_type', field: 'contentType' }
  }
  if (
    !Number.isFinite(input.contentLength) ||
    input.contentLength <= 0 ||
    input.contentLength > PROGRESS_PHOTO_MAX_BYTES
  ) {
    return { ok: false, code: 'photo_too_large', field: 'contentLength' }
  }
  return {
    ok: true,
    mimeType: input.contentType,
    extension: PROGRESS_PHOTO_MIME_EXTENSIONS[input.contentType],
  }
}

// --- request/DTO shapes -------------------------------------------------

// Capture-session set id: `fps_` + a 26-char Crockford-base32 ULID.
// Shape-check only — every query is user-scoped, so a foreign setId
// can't link across users; it just tags the caller's own rows.
export const setIdSchema = z.string().regex(/^fps_[0-9A-HJKMNP-TV-Z]{26}$/)

// Metadata that rides the raw-body upload POST as query params (the
// body is the image bytes, so there is no JSON envelope to carry it).
// `setId` links a multi-angle batch: the first upload omits it (the
// server mints one, returned in the DTO); the rest pass it back.
export const progressPhotoUploadMetaSchema = z.object({
  pose: poseSchema,
  takenAt: z.string().datetime().optional(),
  note: z.string().max(2000).optional(),
  setId: setIdSchema.optional(),
})
export type ProgressPhotoUploadMeta = z.infer<typeof progressPhotoUploadMetaSchema>

export const patchProgressPhotoSchema = z.object({
  pose: poseSchema.optional(),
  takenAt: z.string().datetime().optional(),
  note: z.string().max(2000).nullish(),
})
export type PatchProgressPhotoInput = z.infer<typeof patchProgressPhotoSchema>

export interface ProgressPhotoDto {
  id: string
  // Capture-session set this photo belongs to. Null only on rows from
  // before sets existed — treat those as singleton sets keyed by `id`.
  setId: string | null
  takenAt: string
  pose: string
  contentType: string
  sizeBytes: number
  note: string | null
  createdAt: string
}

// --- pure gallery grouping (UI) ------------------------------------------

export interface ProgressPhotoDayGroup<T extends { takenAt: string }> {
  // Local calendar day key, YYYY-MM-DD (viewer's timezone).
  dayKey: string
  photos: T[]
}

function localDayKey(iso: string): string {
  const d = new Date(iso)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

// Group photos by local calendar day, newest day first; photos within a
// day stay newest-first. Input order does not matter.
export function groupPhotosByDay<T extends { takenAt: string }>(
  photos: T[],
): ProgressPhotoDayGroup<T>[] {
  const sorted = [...photos].sort((a, b) => b.takenAt.localeCompare(a.takenAt))
  const groups: ProgressPhotoDayGroup<T>[] = []
  for (const photo of sorted) {
    const dayKey = localDayKey(photo.takenAt)
    const last = groups[groups.length - 1]
    if (last && last.dayKey === dayKey) last.photos.push(photo)
    else groups.push({ dayKey, photos: [photo] })
  }
  return groups
}

// --- pure set grouping (UI) ------------------------------------------------

export interface ProgressPhotoSet<T> {
  // The set's id (a photo's own id for pre-set legacy rows).
  setKey: string
  photos: T[]
}

type SetGroupable = { id: string; setId: string | null; pose: string; takenAt: string }

// Sort a set's members for display: curated poses in KNOWN_POSES order
// first (front, back, side), then custom poses oldest-first.
function setMemberOrder(a: SetGroupable, b: SetGroupable): number {
  const posesOrder = KNOWN_POSES.map((p) => p.id)
  const ai = posesOrder.indexOf(a.pose)
  const bi = posesOrder.indexOf(b.pose)
  if (ai !== -1 || bi !== -1) {
    return (ai === -1 ? posesOrder.length : ai) - (bi === -1 ? posesOrder.length : bi)
  }
  return a.takenAt.localeCompare(b.takenAt)
}

// Group photos into capture-session sets, newest set first (by the
// set's newest photo). MAP-based, unlike the adjacency-based
// groupPhotosByDay — a set split across a pagination boundary merges
// back together when later pages are appended to the input.
export function groupPhotosBySet<T extends SetGroupable>(photos: T[]): ProgressPhotoSet<T>[] {
  const bySet = new Map<string, T[]>()
  for (const photo of photos) {
    const key = photo.setId ?? photo.id
    const list = bySet.get(key)
    if (list) list.push(photo)
    else bySet.set(key, [photo])
  }
  const sets = [...bySet.entries()].map(([setKey, members]) => ({
    setKey,
    newest: members.reduce((m, p) => (p.takenAt > m ? p.takenAt : m), members[0]!.takenAt),
    photos: [...members].sort(setMemberOrder),
  }))
  sets.sort((a, b) => b.newest.localeCompare(a.newest))
  return sets.map(({ setKey, photos }) => ({ setKey, photos }))
}

// The photo representing a set in a grid tile: front if present, else
// the set's first display-ordered photo.
export function primaryPhotoOfSet<T extends { pose: string }>(photos: T[]): T {
  return photos.find((p) => p.pose === 'front') ?? photos[0]!
}

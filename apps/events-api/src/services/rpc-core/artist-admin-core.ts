import { UniqueConstraintError } from '@rallypoint/api-kit'
import {
  adminUpdateArtistSchema,
  type ArtistAdminDto,
  type ArtistAdminPage,
} from '@rallypoint/events-shared'
import type { ArtistRecord } from '../../repos/types.js'
import {
  isAdmin,
  type AdminConflict,
  type AdminForbidden,
  type AdminInvalid,
  type AdminNotFound,
  type AdminOk,
} from './admin-events-core.js'
import type { EventsRpcDeps } from './deps.js'

// Admin artist-catalog table surface: alphabetical keyset listing of the
// whole global catalog (incl. mbid, which the public lineup search DTO
// omits) + direct inline edits. Companion to the MB sweep
// (artist-mb-sweep-core.ts), which proposes; this is the manual path
// that writes through the same repos.artists.update.

const LIST_MAX = 100
const LIST_DEFAULT = 50

function toAdminDto(a: ArtistRecord): ArtistAdminDto {
  return {
    id: a.id,
    name: a.name,
    genre: a.genre,
    soundcloud: a.soundcloud,
    spotify: a.spotify,
    appleMusic: a.appleMusic,
    youtubeMusic: a.youtubeMusic,
    instagram: a.instagram,
    mbid: a.mbid,
    updatedAt: a.updatedAt.toISOString(),
  }
}

export interface AdminListArtistsOpts {
  q?: string | undefined
  cursor?: { name: string; id: string } | null | undefined
  limit?: number | undefined
}

export async function adminListArtistsCore(
  actor: string,
  opts: AdminListArtistsOpts,
  deps: EventsRpcDeps,
): Promise<AdminOk<ArtistAdminPage> | AdminForbidden> {
  if (!isAdmin(actor, deps)) return { kind: 'forbidden' }
  const limit = Math.max(1, Math.min(LIST_MAX, opts.limit ?? LIST_DEFAULT))
  const page = await deps.repos.artists.listPage({
    q: opts.q,
    cursor: opts.cursor ?? null,
    limit,
  })
  return {
    kind: 'ok',
    data: { items: page.items.map(toAdminDto), nextCursor: page.nextCursor },
  }
}

export type AdminPatchArtistResult =
  | AdminOk<ArtistAdminDto>
  | AdminForbidden
  | AdminNotFound
  | AdminInvalid
  | AdminConflict

export async function adminPatchArtistCore(
  actor: string,
  artistId: string,
  input: unknown,
  deps: EventsRpcDeps,
): Promise<AdminPatchArtistResult> {
  if (!isAdmin(actor, deps)) return { kind: 'forbidden' }
  const parsed = adminUpdateArtistSchema.safeParse(input)
  if (!parsed.success) {
    return {
      kind: 'invalid',
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    }
  }
  if (Object.keys(parsed.data).length === 0) {
    return { kind: 'invalid', issues: [{ path: '', message: 'Empty patch.' }] }
  }
  try {
    const updated = await deps.repos.artists.update(artistId, parsed.data)
    if (!updated) return { kind: 'not_found' }
    return { kind: 'ok', data: toAdminDto(updated) }
  } catch (err) {
    // lower(name) unique index — another artist already has this name.
    if (err instanceof UniqueConstraintError) {
      return { kind: 'conflict', code: 'artist_name_taken' }
    }
    throw err
  }
}

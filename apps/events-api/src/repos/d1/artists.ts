import { asc, eq, gt, isNull, or, sql, and } from 'drizzle-orm'
import { artists } from '@rallypoint/events-db'
import type { ArtistProfileFields, ArtistRecord, ArtistRepo } from '../types.js'
import type { Db } from './db.js'
import { mapUniqueViolation } from './_errors.js'

function rowToArtist(row: typeof artists.$inferSelect): ArtistRecord {
  return {
    id: row.id,
    name: row.name,
    soundcloud: row.soundcloud ?? null,
    spotify: row.spotify ?? null,
    appleMusic: row.appleMusic ?? null,
    youtubeMusic: row.youtubeMusic ?? null,
    instagram: row.instagram ?? null,
    genre: row.genre ?? null,
    mbid: row.mbid ?? null,
    updatedAt: row.updatedAt,
  }
}

function profileColumns(fields: ArtistProfileFields): Record<string, string | null> {
  const set: Record<string, string | null> = {}
  if (fields.soundcloud !== undefined) set.soundcloud = fields.soundcloud ?? null
  if (fields.spotify !== undefined) set.spotify = fields.spotify ?? null
  if (fields.appleMusic !== undefined) set.appleMusic = fields.appleMusic ?? null
  if (fields.youtubeMusic !== undefined) set.youtubeMusic = fields.youtubeMusic ?? null
  if (fields.instagram !== undefined) set.instagram = fields.instagram ?? null
  if (fields.genre !== undefined) set.genre = fields.genre ?? null
  if (fields.mbid !== undefined) set.mbid = fields.mbid ?? null
  return set
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

export class D1ArtistRepo implements ArtistRepo {
  constructor(private readonly db: Db) {}

  async create(input: { id: string; name: string } & ArtistProfileFields): Promise<ArtistRecord> {
    try {
      const [row] = await this.db
        .insert(artists)
        .values({ id: input.id, name: input.name, ...profileColumns(input) })
        .returning()
      return rowToArtist(row!)
    } catch (err) {
      throw mapUniqueViolation(err)
    }
  }

  async findById(id: string): Promise<ArtistRecord | null> {
    const rows = await this.db.select().from(artists).where(eq(artists.id, id)).limit(1)
    return rows[0] ? rowToArtist(rows[0]) : null
  }

  async findByName(name: string): Promise<ArtistRecord | null> {
    // Case-insensitive match using lower() — mirrors the PG lower(name) unique index.
    // SQLite's LIKE is case-insensitive by default for ASCII but lower() is explicit.
    const rows = await this.db
      .select()
      .from(artists)
      .where(sql`lower(${artists.name}) = lower(${name})`)
      .limit(1)
    return rows[0] ? rowToArtist(rows[0]) : null
  }

  async search(query: string, limit: number): Promise<ArtistRecord[]> {
    // ILIKE → lower() LIKE … ESCAPE '\' — SQLite's LIKE is case-insensitive
    // for ASCII already, but using lower() on both sides is explicit and correct.
    const escaped = escapeLike(query)
    const rows = await this.db
      .select()
      .from(artists)
      .where(sql`lower(${artists.name}) LIKE lower(${'%' + escaped + '%'}) ESCAPE '\\'`)
      .orderBy(asc(artists.name))
      .limit(limit)
    return rows.map(rowToArtist)
  }

  async update(
    id: string,
    fields: { name?: string } & ArtistProfileFields,
  ): Promise<ArtistRecord | null> {
    const set: Record<string, unknown> = { ...profileColumns(fields), updatedAt: new Date() }
    if (fields.name !== undefined) set.name = fields.name
    try {
      const [row] = await this.db.update(artists).set(set).where(eq(artists.id, id)).returning()
      return row ? rowToArtist(row) : null
    } catch (err) {
      throw mapUniqueViolation(err)
    }
  }

  async listPage(opts: {
    q?: string | undefined
    cursor?: { name: string; id: string } | null | undefined
    limit: number
  }): Promise<{ items: ArtistRecord[]; nextCursor: { name: string; id: string } | null }> {
    const conds = []
    if (opts.q?.trim()) {
      const escaped = escapeLike(opts.q.trim())
      conds.push(sql`lower(${artists.name}) LIKE lower(${'%' + escaped + '%'}) ESCAPE '\\'`)
    }
    if (opts.cursor) {
      // Keyset resume on the (lower(name), id) sort key. Expanded OR form
      // rather than a row-value comparison for SQLite clarity.
      conds.push(
        sql`(lower(${artists.name}) > lower(${opts.cursor.name}) OR (lower(${artists.name}) = lower(${opts.cursor.name}) AND ${artists.id} > ${opts.cursor.id}))`,
      )
    }
    const rows = await this.db
      .select()
      .from(artists)
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(sql`lower(${artists.name})`, asc(artists.id))
      .limit(opts.limit)
    const items = rows.map(rowToArtist)
    const last = items[items.length - 1]
    return {
      items,
      nextCursor: items.length === opts.limit && last ? { name: last.name, id: last.id } : null,
    }
  }

  async listEnrichmentCandidates(opts: {
    afterId?: string | null | undefined
    limit: number
  }): Promise<ArtistRecord[]> {
    const qualifies = or(
      isNull(artists.genre),
      isNull(artists.soundcloud),
      isNull(artists.spotify),
      isNull(artists.appleMusic),
      isNull(artists.youtubeMusic),
      isNull(artists.instagram),
    )
    const rows = await this.db
      .select()
      .from(artists)
      .where(opts.afterId ? and(gt(artists.id, opts.afterId), qualifies) : qualifies)
      .orderBy(asc(artists.id))
      .limit(opts.limit)
    return rows.map(rowToArtist)
  }
}

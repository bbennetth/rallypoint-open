import { asc, eq, sql } from 'drizzle-orm'
import { artists } from '@rallypoint/events-db'
import type { ArtistLinks, ArtistRecord, ArtistRepo } from '../types.js'
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
    updatedAt: row.updatedAt,
  }
}

function linkColumns(links: ArtistLinks): Record<string, string | null> {
  const set: Record<string, string | null> = {}
  if (links.soundcloud !== undefined) set.soundcloud = links.soundcloud ?? null
  if (links.spotify !== undefined) set.spotify = links.spotify ?? null
  if (links.appleMusic !== undefined) set.appleMusic = links.appleMusic ?? null
  if (links.youtubeMusic !== undefined) set.youtubeMusic = links.youtubeMusic ?? null
  if (links.instagram !== undefined) set.instagram = links.instagram ?? null
  return set
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

export class D1ArtistRepo implements ArtistRepo {
  constructor(private readonly db: Db) {}

  async create(input: { id: string; name: string } & ArtistLinks): Promise<ArtistRecord> {
    try {
      const [row] = await this.db
        .insert(artists)
        .values({ id: input.id, name: input.name, ...linkColumns(input) })
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
    fields: { name?: string } & ArtistLinks,
  ): Promise<ArtistRecord | null> {
    const set: Record<string, unknown> = { ...linkColumns(fields), updatedAt: new Date() }
    if (fields.name !== undefined) set.name = fields.name
    try {
      const [row] = await this.db.update(artists).set(set).where(eq(artists.id, id)).returning()
      return row ? rowToArtist(row) : null
    } catch (err) {
      throw mapUniqueViolation(err)
    }
  }
}

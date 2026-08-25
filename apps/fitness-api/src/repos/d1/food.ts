import { and, desc, eq, gte, isNotNull, isNull, lte, or, sql } from 'drizzle-orm'
import type { AnyColumn, SQL } from 'drizzle-orm'
import { SEARCH_APOSTROPHE_CHARS } from '@rallypoint/fitness-shared'
import { foodItems, foodLogEntries, foodSearchQueries, foodSubmissions } from '@rallypoint/fitness-db'
import { mapUniqueViolation } from './_errors.js'
import type {
  FoodDaySummaryRow,
  FoodItemRecord,
  FoodItemRepo,
  FoodLogEntryRecord,
  FoodLogListFilter,
  FoodLogRepo,
  FoodSearchQueryRecord,
  FoodSearchQueryRepo,
  NewFoodItem,
  NewFoodLogEntry,
  OverrideFoodItemFields,
  PatchFoodLogEntryFields,
} from '../types.js'
import type {
  FoodItemSource,
  FoodLogSource,
  FoodQuantityUnit,
  FoodServingUnit,
} from '@rallypoint/fitness-shared'
import type { Db } from './db.js'

type FoodItemRow = typeof foodItems.$inferSelect
type FoodLogRow = typeof foodLogEntries.$inferSelect

function itemRowToRecord(row: FoodItemRow): FoodItemRecord {
  return {
    id: row.id,
    upc: row.upc ?? null,
    source: row.source as FoodItemSource,
    name: row.name,
    brand: row.brand ?? null,
    servingGrams: row.servingGrams ?? null,
    servingQuantity: row.servingQuantity ?? null,
    servingUnit: (row.servingUnit as FoodServingUnit | null) ?? null,
    isLiquid: row.isLiquid === null || row.isLiquid === undefined ? null : row.isLiquid === 1,
    per100g: {
      kcal: row.kcalPer100g,
      proteinG: row.proteinPer100g,
      carbsG: row.carbsPer100g,
      fatG: row.fatPer100g,
    },
    createdBy: row.createdBy ?? null,
    ownerUserId: row.ownerUserId ?? null,
    createdAt: row.createdAt,
  }
}

function logRowToRecord(row: FoodLogRow): FoodLogEntryRecord {
  return {
    id: row.id,
    userId: row.userId,
    loggedAt: row.loggedAt,
    foodItemId: row.foodItemId ?? null,
    name: row.name,
    quantityGrams: row.quantityGrams ?? null,
    quantityUnit: (row.quantityUnit as FoodQuantityUnit | null) ?? null,
    quantityAmount: row.quantityAmount ?? null,
    estimatedGrams: row.estimatedGrams ?? null,
    scanResponseId: row.scanResponseId ?? null,
    preparedMealId: row.preparedMealId ?? null,
    kcal: row.kcal,
    proteinG: row.proteinG,
    carbsG: row.carbsG,
    fatG: row.fatG,
    source: row.source as FoodLogSource,
    note: row.note ?? null,
    createdAt: row.createdAt,
  }
}

function itemInsertRow(input: NewFoodItem): typeof foodItems.$inferInsert {
  return {
    id: input.id,
    upc: input.upc ?? null,
    source: input.source,
    name: input.name,
    brand: input.brand ?? null,
    servingGrams: input.servingGrams ?? null,
    servingQuantity: input.servingQuantity ?? null,
    servingUnit: input.servingUnit ?? null,
    isLiquid:
      input.isLiquid === null || input.isLiquid === undefined ? null : input.isLiquid ? 1 : 0,
    kcalPer100g: input.per100g.kcal,
    proteinPer100g: input.per100g.proteinG,
    carbsPer100g: input.per100g.carbsG,
    fatPer100g: input.per100g.fatG,
    raw: input.raw ?? null,
    createdBy: input.createdBy ?? null,
    ownerUserId: input.ownerUserId ?? null,
    createdAt: new Date(),
  }
}

export class D1FoodItemRepo implements FoodItemRepo {
  constructor(private readonly db: Db) {}

  async getByUpc(upc: string): Promise<FoodItemRecord | null> {
    const rows = await this.db.select().from(foodItems).where(eq(foodItems.upc, upc)).limit(1)
    const row = rows[0]
    return row ? itemRowToRecord(row) : null
  }

  async getById(id: string): Promise<FoodItemRecord | null> {
    const rows = await this.db.select().from(foodItems).where(eq(foodItems.id, id)).limit(1)
    const row = rows[0]
    return row ? itemRowToRecord(row) : null
  }

  async getForActor(actorUserId: string, id: string): Promise<FoodItemRecord | null> {
    const rows = await this.db
      .select()
      .from(foodItems)
      .where(
        and(
          eq(foodItems.id, id),
          or(isNull(foodItems.ownerUserId), eq(foodItems.ownerUserId, actorUserId)),
        ),
      )
      .limit(1)
    const row = rows[0]
    return row ? itemRowToRecord(row) : null
  }

  async searchForActor(
    actorUserId: string,
    query: string,
    limit: number,
  ): Promise<FoodItemRecord[]> {
    // Escape LIKE wildcards in the user's text so "50%" searches for the
    // literal string, not "starts with 50". SQLite LIKE is
    // case-insensitive for ASCII, which is what we want here; brand is
    // nullable so a null never matches.
    const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`)
    // Apostrophe-insensitive matching: stored rows mix straight (') and
    // curly (’) apostrophes (label-scan saves store ', OFF data often
    // curly), and the incoming query is quote-folded to ASCII by
    // normalizeFoodSearchQuery. Strip apostrophes from BOTH the pattern
    // and the column so "Joe's", "Joe’s" and "Joes" all match each other
    // — without this, "Trader Joe’s abc bar" can't find a cached
    // "ABC Bars (Trader Joe's)". SEARCH_APOSTROPHE_CHARS is the shared
    // source of truth with foldQuotes (query side), so the two never
    // drift. Double-quote variants are deliberately NOT stripped here:
    // they're vanishingly rare in food/brand names and would only bloat
    // the generated SQL. Each char is a bound param (not a SQL literal),
    // so no manual quote-escaping and no injection surface.
    const stripApostrophes = (s: string) =>
      SEARCH_APOSTROPHE_CHARS.reduce((acc, ch) => acc.split(ch).join(''), s)
    const stripApostrophesSql = (col: AnyColumn) =>
      SEARCH_APOSTROPHE_CHARS.reduce<SQL>((expr, ch) => sql`replace(${expr}, ${ch}, '')`, sql`${col}`)
    const nameNorm = stripApostrophesSql(foodItems.name)
    const brandNorm = stripApostrophesSql(foodItems.brand)
    // Tokenized AND matching: every word must appear in the name OR the
    // brand, so "quest bar" finds name="Protein Bar" brand="Quest" (a
    // whole-phrase substring match can't cross the two columns). Drop
    // tokens that are entirely apostrophes (strip to '') — their pattern
    // would be a bare "%%" that matches every row and filters nothing.
    const words = query
      .split(' ')
      .map((w) => stripApostrophes(w))
      .filter((w) => w !== '')
    const wordConds = words.map((w) => {
      const p = `%${escapeLike(w)}%`
      return or(
        sql`${nameNorm} like ${p} escape '\\'`,
        sql`${brandNorm} like ${p} escape '\\'`,
      )!
    })
    // Relevance: the user's own items first, then name-prefix matches,
    // then whole-phrase matches anywhere in name or brand, then the rest
    // (word-level matches), newest first within each tier.
    const prefix = `${escapeLike(stripApostrophes(query))}%`
    const phrase = `%${escapeLike(stripApostrophes(query))}%`
    const rows = await this.db
      .select()
      .from(foodItems)
      .where(
        and(
          or(isNull(foodItems.ownerUserId), eq(foodItems.ownerUserId, actorUserId)),
          ...wordConds,
        ),
      )
      .orderBy(
        sql`case when ${foodItems.ownerUserId} = ${actorUserId} then 0 else 1 end`,
        sql`case
          when ${nameNorm} like ${prefix} escape '\\' then 0
          when ${nameNorm} like ${phrase} escape '\\'
            or ${brandNorm} like ${phrase} escape '\\' then 1
          else 2
        end`,
        desc(foodItems.createdAt),
      )
      .limit(Math.min(Math.max(limit, 1), 50))
    return rows.map(itemRowToRecord)
  }

  async searchGlobalCandidates(query: {
    upc?: string | null
    name: string
    brand?: string | null
    limit: number
  }): Promise<FoodItemRecord[]> {
    // Duplicate-scan shortlist: GLOBAL rows only (owner IS NULL) that
    // either carry the exact upc or match ANY name/brand token (OR
    // semantics — a partial-name overlap is still a candidate worth
    // showing the model). Exact-upc rows sort first.
    const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`)
    const words = [query.name, query.brand ?? '']
      .join(' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
    const wordConds = words.map((w) => {
      const p = `%${escapeLike(w)}%`
      return or(
        sql`${foodItems.name} like ${p} escape '\\'`,
        sql`${foodItems.brand} like ${p} escape '\\'`,
      )!
    })
    const matchConds = [...wordConds]
    const upc = query.upc ?? null
    const upcCond = upc ? eq(foodItems.upc, upc) : null
    if (upcCond) matchConds.push(upcCond)
    if (matchConds.length === 0) return []
    const rows = await this.db
      .select()
      .from(foodItems)
      .where(and(isNull(foodItems.ownerUserId), or(...matchConds)))
      .orderBy(
        ...(upcCond ? [sql`case when ${foodItems.upc} = ${upc} then 0 else 1 end`] : []),
        desc(foodItems.createdAt),
      )
      .limit(Math.min(Math.max(query.limit, 1), 20))
    return rows.map(itemRowToRecord)
  }

  async upsertByUpc(input: NewFoodItem & { upc: string }): Promise<FoodItemRecord> {
    // ON CONFLICT DO NOTHING + re-read: two users scanning the same
    // product concurrently must both get the (single) cached row, not
    // a unique-violation 500.
    await this.db.insert(foodItems).values(itemInsertRow(input)).onConflictDoNothing({
      target: foodItems.upc,
    })
    const row = await this.getByUpc(input.upc)
    // The row must exist now: either our insert landed or the conflict row was there.
    return row!
  }

  async overrideByUpc(
    upc: string,
    fields: OverrideFoodItemFields,
  ): Promise<FoodItemRecord | null> {
    // In-place replace of the GLOBAL cached row (never a private row) —
    // the "Incorrect?" correction path. Row id stays stable so existing
    // diary foodItemId pointers keep resolving.
    await this.db
      .update(foodItems)
      .set({
        source: 'user',
        name: fields.name,
        brand: fields.brand,
        servingGrams: fields.servingGrams,
        servingQuantity: fields.servingQuantity,
        servingUnit: fields.servingUnit,
        isLiquid: fields.isLiquid === null ? null : fields.isLiquid ? 1 : 0,
        kcalPer100g: fields.per100g.kcal,
        proteinPer100g: fields.per100g.proteinG,
        carbsPer100g: fields.per100g.carbsG,
        fatPer100g: fields.per100g.fatG,
        raw: fields.raw,
      })
      .where(and(eq(foodItems.upc, upc), isNull(foodItems.ownerUserId)))
    const row = await this.getByUpc(upc)
    return row && row.ownerUserId === null ? row : null
  }

  async refreshOffByUpc(
    upc: string,
    fields: OverrideFoodItemFields,
  ): Promise<FoodItemRecord | null> {
    // Guarded on source = 'off' so a 'user' correction (overrideByUpc)
    // can never be stomped by a background OFF refresh.
    await this.db
      .update(foodItems)
      .set({
        name: fields.name,
        brand: fields.brand,
        servingGrams: fields.servingGrams,
        servingQuantity: fields.servingQuantity,
        servingUnit: fields.servingUnit,
        isLiquid: fields.isLiquid === null ? null : fields.isLiquid ? 1 : 0,
        kcalPer100g: fields.per100g.kcal,
        proteinPer100g: fields.per100g.proteinG,
        carbsPer100g: fields.per100g.carbsG,
        fatPer100g: fields.per100g.fatG,
        raw: fields.raw,
      })
      .where(
        and(eq(foodItems.upc, upc), isNull(foodItems.ownerUserId), eq(foodItems.source, 'off')),
      )
    const row = await this.getByUpc(upc)
    return row && row.ownerUserId === null && row.source === 'off' ? row : null
  }

  async upsertCustom(input: NewFoodItem & { ownerUserId: string }): Promise<FoodItemRecord> {
    const row = itemInsertRow(input)
    await this.db
      .insert(foodItems)
      .values(row)
      .onConflictDoUpdate({
        target: [foodItems.ownerUserId, sql`lower(${foodItems.name})`],
        targetWhere: sql`${foodItems.ownerUserId} is not null and ${foodItems.source} = 'manual'`,
        set: {
          name: input.name,
          brand: input.brand ?? null,
          servingGrams: input.servingGrams ?? null,
          servingQuantity: input.servingQuantity ?? null,
          servingUnit: input.servingUnit ?? null,
          isLiquid:
            input.isLiquid === null || input.isLiquid === undefined ? null : input.isLiquid ? 1 : 0,
          kcalPer100g: input.per100g.kcal,
          proteinPer100g: input.per100g.proteinG,
          carbsPer100g: input.per100g.carbsG,
          fatPer100g: input.per100g.fatG,
        },
      })
    const rows = await this.db
      .select()
      .from(foodItems)
      .where(
        and(
          eq(foodItems.ownerUserId, input.ownerUserId),
          sql`lower(${foodItems.name}) = lower(${input.name})`,
        ),
      )
      .limit(1)
    return itemRowToRecord(rows[0]!)
  }

  async create(input: NewFoodItem): Promise<FoodItemRecord> {
    const row = itemInsertRow(input)
    await this.db.insert(foodItems).values(row)
    return itemRowToRecord({ ...row, createdAt: row.createdAt! } as FoodItemRow)
  }
}

export class D1FoodSearchQueryRepo implements FoodSearchQueryRepo {
  constructor(private readonly db: Db) {}

  async get(query: string): Promise<FoodSearchQueryRecord | null> {
    const rows = await this.db
      .select()
      .from(foodSearchQueries)
      .where(eq(foodSearchQueries.query, query))
      .limit(1)
    const row = rows[0]
    return row ? { query: row.query, resultCount: row.resultCount, fetchedAt: row.fetchedAt } : null
  }

  async record(query: string, resultCount: number, fetchedAt: Date): Promise<void> {
    await this.db
      .insert(foodSearchQueries)
      .values({ query, resultCount, fetchedAt })
      .onConflictDoUpdate({
        target: foodSearchQueries.query,
        set: { resultCount, fetchedAt },
      })
  }
}

export class D1FoodLogRepo implements FoodLogRepo {
  constructor(private readonly db: Db) {}

  async listForActor(userId: string, filter: FoodLogListFilter): Promise<FoodLogEntryRecord[]> {
    const limit = Math.min(filter.limit ?? 200, 1000)
    const conds = [eq(foodLogEntries.userId, userId)]
    if (filter.from) conds.push(gte(foodLogEntries.loggedAt, filter.from))
    if (filter.to) conds.push(lte(foodLogEntries.loggedAt, filter.to))

    const rows = await this.db
      .select()
      .from(foodLogEntries)
      .where(and(...conds))
      .orderBy(desc(foodLogEntries.loggedAt))
      .limit(limit)

    return rows.map(logRowToRecord)
  }

  async sumByLocalDay(
    userId: string,
    filter: { from?: Date; to?: Date },
    tzOffsetMinutes: number,
  ): Promise<FoodDaySummaryRow[]> {
    const conds = [eq(foodLogEntries.userId, userId)]
    if (filter.from) conds.push(gte(foodLogEntries.loggedAt, filter.from))
    if (filter.to) conds.push(lte(foodLogEntries.loggedAt, filter.to))
    // logged_at is stored as UTC ms; shifting by the client's offset
    // before the strftime bucket groups on the client's calendar day
    // (server never guesses the user's timezone — same rule as the
    // diary's client-supplied day windows).
    const offsetS = Math.trunc(tzOffsetMinutes) * 60
    const day = sql<string>`strftime('%Y-%m-%d', (${foodLogEntries.loggedAt} / 1000) + ${offsetS}, 'unixepoch')`
    const rows = await this.db
      .select({
        day,
        kcal: sql<number>`sum(${foodLogEntries.kcal})`,
        proteinG: sql<number>`sum(${foodLogEntries.proteinG})`,
        carbsG: sql<number>`sum(${foodLogEntries.carbsG})`,
        fatG: sql<number>`sum(${foodLogEntries.fatG})`,
        entries: sql<number>`count(*)`,
      })
      .from(foodLogEntries)
      .where(and(...conds))
      .groupBy(day)
      .orderBy(day)
    return rows
  }

  async getForActor(userId: string, id: string): Promise<FoodLogEntryRecord | null> {
    const rows = await this.db
      .select()
      .from(foodLogEntries)
      .where(and(eq(foodLogEntries.id, id), eq(foodLogEntries.userId, userId)))
      .limit(1)
    const row = rows[0]
    return row ? logRowToRecord(row) : null
  }

  async create(input: NewFoodLogEntry): Promise<FoodLogEntryRecord> {
    const insertRow = this.logInsertRow(input)
    await this.db.insert(foodLogEntries).values(insertRow)
    return logRowToRecord(insertRow as FoodLogRow)
  }

  private logInsertRow(input: NewFoodLogEntry): typeof foodLogEntries.$inferInsert {
    return {
      id: input.id,
      userId: input.userId,
      loggedAt: input.loggedAt,
      foodItemId: input.foodItemId ?? null,
      name: input.name,
      quantityGrams: input.quantityGrams ?? null,
      quantityUnit: input.quantityUnit ?? null,
      quantityAmount: input.quantityAmount ?? null,
      estimatedGrams: input.estimatedGrams ?? null,
      scanResponseId: input.scanResponseId ?? null,
      kcal: input.kcal,
      proteinG: input.proteinG,
      carbsG: input.carbsG,
      fatG: input.fatG,
      source: input.source,
      note: input.note ?? null,
      createdAt: new Date(),
    }
  }

  async createWithCustomFood(
    food: NewFoodItem & { ownerUserId: string },
    input: NewFoodLogEntry,
  ): Promise<FoodLogEntryRecord> {
    const foodRow = itemInsertRow(food)
    const upsert = this.db
      .insert(foodItems)
      .values(foodRow)
      .onConflictDoUpdate({
        target: [foodItems.ownerUserId, sql`lower(${foodItems.name})`],
        targetWhere: sql`${foodItems.ownerUserId} is not null and ${foodItems.source} = 'manual'`,
        set: {
          name: food.name,
          servingGrams: food.servingGrams ?? null,
          servingQuantity: food.servingQuantity ?? null,
          servingUnit: food.servingUnit ?? null,
          isLiquid: food.isLiquid ? 1 : 0,
          kcalPer100g: food.per100g.kcal,
          proteinPer100g: food.per100g.proteinG,
          carbsPer100g: food.per100g.carbsG,
          fatPer100g: food.per100g.fatG,
        },
      })
    const insertLog = this.db.insert(foodLogEntries).values({
      ...this.logInsertRow(input),
      foodItemId: sql`(select ${foodItems.id} from ${foodItems} where ${foodItems.ownerUserId} = ${food.ownerUserId} and lower(${foodItems.name}) = lower(${food.name}) limit 1)`,
    })
    await this.db.batch([upsert, insertLog])
    const created = await this.getForActor(input.userId, input.id)
    return created!
  }

  async createWithUpcFood(
    food: NewFoodItem & { upc: string },
    input: NewFoodLogEntry,
  ): Promise<FoodLogEntryRecord> {
    // Same shape as createWithCustomFood, but the shared cache row is
    // upc-keyed and global: ON CONFLICT DO NOTHING so a barcode already
    // contributed by another user is left intact, and the diary row's
    // foodItemId resolves to whichever row now owns the upc (ours or the
    // pre-existing one). The subselect sees the just-inserted row because
    // batch statements run sequentially in one transaction.
    const upsert = this.db
      .insert(foodItems)
      .values(itemInsertRow(food))
      .onConflictDoNothing({ target: foodItems.upc })
    const insertLog = this.db.insert(foodLogEntries).values({
      ...this.logInsertRow(input),
      foodItemId: sql`(select ${foodItems.id} from ${foodItems} where ${foodItems.upc} = ${food.upc} limit 1)`,
    })
    await this.db.batch([upsert, insertLog])
    const created = await this.getForActor(input.userId, input.id)
    return created!
  }

  async createWithPrivateFood(
    food: NewFoodItem & { ownerUserId: string },
    input: NewFoodLogEntry,
  ): Promise<FoodLogEntryRecord> {
    // upc is always forced null here — see FoodLogRepo.createWithPrivateFood
    // notes: the partial unique index on food_submissions/food_items upc
    // columns must stay free for the eventual global row.
    const foodRow = itemInsertRow({ ...food, upc: null })
    const insertItem = this.db.insert(foodItems).values(foodRow)
    const insertLog = this.db.insert(foodLogEntries).values({
      ...this.logInsertRow(input),
      foodItemId: foodRow.id,
    })
    await this.db.batch([insertItem, insertLog])
    const created = await this.getForActor(input.userId, input.id)
    return created!
  }

  async createWithUpcSubmission(
    food: NewFoodItem & { ownerUserId: string },
    input: NewFoodLogEntry,
    submission: { id: string; upc: string },
  ): Promise<FoodLogEntryRecord> {
    const foodRow = itemInsertRow({ ...food, upc: null })
    const insertItem = this.db.insert(foodItems).values(foodRow)
    const insertLog = this.db.insert(foodLogEntries).values({
      ...this.logInsertRow(input),
      foodItemId: foodRow.id,
    })
    const insertSubmission = this.db.insert(foodSubmissions).values({
      id: submission.id,
      userId: food.ownerUserId,
      upc: submission.upc,
      privateFoodItemId: foodRow.id,
      name: food.name,
      brand: food.brand ?? null,
      servingGrams: food.servingGrams!,
      servingQuantity: food.servingQuantity!,
      servingUnit: food.servingUnit!,
      isLiquid: food.isLiquid ? 1 : 0,
      kcalPer100g: food.per100g.kcal,
      proteinPer100g: food.per100g.proteinG,
      carbsPer100g: food.per100g.carbsG,
      fatPer100g: food.per100g.fatG,
      status: 'pending',
      migrationStatus: 'none',
      createdAt: new Date(),
    })
    try {
      // A single db.batch runs sequentially in one transaction: if the
      // submission insert loses the partial-unique-index race, the whole
      // batch (including the item + diary inserts) rolls back — the
      // caller falls back to createWithPrivateFood rather than ending up
      // with an orphaned private item and no submission.
      await this.db.batch([insertItem, insertLog, insertSubmission])
    } catch (err) {
      throw mapUniqueViolation(err)
    }
    const created = await this.getForActor(input.userId, input.id)
    return created!
  }

  async update(
    userId: string,
    id: string,
    fields: PatchFoodLogEntryFields,
  ): Promise<FoodLogEntryRecord | null> {
    const existing = await this.getForActor(userId, id)
    if (!existing) return null

    const updateVals: Partial<typeof foodLogEntries.$inferInsert> = {}
    if (fields.loggedAt !== undefined) updateVals.loggedAt = fields.loggedAt
    if (fields.name !== undefined) updateVals.name = fields.name
    if ('quantityGrams' in fields) updateVals.quantityGrams = fields.quantityGrams ?? null
    if ('quantityUnit' in fields) updateVals.quantityUnit = fields.quantityUnit ?? null
    if ('quantityAmount' in fields) updateVals.quantityAmount = fields.quantityAmount ?? null
    if (fields.kcal !== undefined) updateVals.kcal = fields.kcal
    if (fields.proteinG !== undefined) updateVals.proteinG = fields.proteinG
    if (fields.carbsG !== undefined) updateVals.carbsG = fields.carbsG
    if (fields.fatG !== undefined) updateVals.fatG = fields.fatG
    if ('note' in fields) updateVals.note = fields.note ?? null

    if (Object.keys(updateVals).length > 0) {
      await this.db.update(foodLogEntries).set(updateVals).where(eq(foodLogEntries.id, id))
    }

    return {
      ...existing,
      ...(fields.loggedAt !== undefined ? { loggedAt: fields.loggedAt } : {}),
      ...(fields.name !== undefined ? { name: fields.name } : {}),
      ...('quantityGrams' in fields ? { quantityGrams: fields.quantityGrams ?? null } : {}),
      ...('quantityUnit' in fields ? { quantityUnit: fields.quantityUnit ?? null } : {}),
      ...('quantityAmount' in fields ? { quantityAmount: fields.quantityAmount ?? null } : {}),
      ...(fields.kcal !== undefined ? { kcal: fields.kcal } : {}),
      ...(fields.proteinG !== undefined ? { proteinG: fields.proteinG } : {}),
      ...(fields.carbsG !== undefined ? { carbsG: fields.carbsG } : {}),
      ...(fields.fatG !== undefined ? { fatG: fields.fatG } : {}),
      ...('note' in fields ? { note: fields.note ?? null } : {}),
    }
  }

  async recentEstimatePairs(
    userId: string,
    limit: number,
  ): Promise<{ estimatedGrams: number; actualGrams: number }[]> {
    const rows = await this.db
      .select({
        estimatedGrams: foodLogEntries.estimatedGrams,
        actualGrams: foodLogEntries.quantityGrams,
      })
      .from(foodLogEntries)
      .where(
        and(
          eq(foodLogEntries.userId, userId),
          eq(foodLogEntries.source, 'photo'),
          isNotNull(foodLogEntries.estimatedGrams),
          isNotNull(foodLogEntries.quantityGrams),
        ),
      )
      .orderBy(desc(foodLogEntries.loggedAt))
      .limit(Math.min(Math.max(limit, 1), 200))
    return rows.map((r) => ({ estimatedGrams: r.estimatedGrams!, actualGrams: r.actualGrams! }))
  }

  async delete(userId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: foodLogEntries.id })
      .from(foodLogEntries)
      .where(and(eq(foodLogEntries.id, id), eq(foodLogEntries.userId, userId)))
      .limit(1)
    if (rows.length === 0) return false
    await this.db.delete(foodLogEntries).where(eq(foodLogEntries.id, id))
    return true
  }
}

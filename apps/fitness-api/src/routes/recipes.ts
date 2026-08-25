import { Hono } from 'hono'
import {
  patchRecipeSchema,
  type RecipeDto,
  type RecipeIngredientDto,
} from '@rallypoint/fitness-shared'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import type { PatchRecipeFields, RecipeIngredientRecord, RecipeRecord } from '../repos/types.js'
import { readJsonBody } from './_body.js'

// Recipes (reusable meal templates saved from a prepared meal). Session-
// gated in build-app; all reads/writes scope to the actor. Recipes are
// created only via POST /meal-prep/:id/save-as-recipe (see routes/meal-
// prep.ts) — this router covers list / read / rename / delete.

const round1 = (v: number) => Math.round(v * 10) / 10

export function recipeIngredientToDto(r: RecipeIngredientRecord): RecipeIngredientDto {
  return {
    id: r.id,
    name: r.name,
    brand: r.brand,
    foodItemId: r.foodItemId,
    grams: round1(r.grams),
    kcal: Math.round(r.kcal),
    proteinG: round1(r.proteinG),
    carbsG: round1(r.carbsG),
    fatG: round1(r.fatG),
    source: r.source,
  }
}

export function recipeToDto(r: RecipeRecord): RecipeDto {
  const dto: RecipeDto = {
    id: r.id,
    name: r.name,
    notes: r.notes,
    yieldGrams: r.yieldGrams === null ? null : round1(r.yieldGrams),
    servings: r.servings,
    totalKcal: Math.round(r.totalKcal),
    totalProteinG: round1(r.totalProteinG),
    totalCarbsG: round1(r.totalCarbsG),
    totalFatG: round1(r.totalFatG),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }
  if (r.ingredients) dto.ingredients = r.ingredients.map(recipeIngredientToDto)
  return dto
}

export const recipesRoutes = new Hono<HonoApp>()
  .get('/api/v1/ui/recipes', async (c) => {
    const rows = await c.var.repos.recipes.listForActor(c.var.session!.userId)
    return c.json({ recipes: rows.map(recipeToDto) })
  })
  .get('/api/v1/ui/recipes/:id', async (c) => {
    const recipe = await c.var.repos.recipes.getForActor(c.var.session!.userId, c.req.param('id'))
    if (!recipe) throw errors.notFound('Recipe not found.')
    return c.json(recipeToDto(recipe))
  })
  .patch('/api/v1/ui/recipes/:id', async (c) => {
    const parsed = patchRecipeSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const fields: PatchRecipeFields = {}
    if (parsed.data.name !== undefined) fields.name = parsed.data.name
    if ('notes' in parsed.data) fields.notes = parsed.data.notes ?? null
    if ('servings' in parsed.data) fields.servings = parsed.data.servings ?? null
    const recipe = await c.var.repos.recipes.patch(c.var.session!.userId, c.req.param('id'), fields)
    if (!recipe) throw errors.notFound('Recipe not found.')
    return c.json(recipeToDto(recipe))
  })
  .delete('/api/v1/ui/recipes/:id', async (c) => {
    const ok = await c.var.repos.recipes.delete(c.var.session!.userId, c.req.param('id'))
    if (!ok) throw errors.notFound('Recipe not found.')
    return c.json({ ok: true })
  })

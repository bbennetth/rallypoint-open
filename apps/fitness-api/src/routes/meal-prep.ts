import { Hono } from 'hono'
import { ulid } from 'ulid'
import {
  createMealPrepIngredientSchema,
  createPreparedMealSchema,
  finishPreparedMealSchema,
  logPreparedMealPortionSchema,
  mealServingGrams,
  patchPreparedMealSchema,
  remainingServings,
  saveAsRecipeSchema,
  updateMealPrepIngredientSchema,
  type PreparedMealDto,
  type PreparedMealIngredientDto,
} from '@rallypoint/fitness-shared'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import type {
  NewPreparedMealIngredient,
  NewRecipeIngredient,
  PatchPreparedMealFields,
  PreparedMealIngredientRecord,
  PreparedMealListFilter,
  PreparedMealRecord,
} from '../repos/types.js'
import { readJsonBody } from './_body.js'
import { entryToDto } from './food.js'
import { recipeToDto } from './recipes.js'

// Meal-prep tool (layered on the food logger). Cook a meal by scanning
// ingredients into a 'cooking' batch, finish it into an 'active' batch with
// a total weight + optional serving count, then log portions from it (by
// weight or serving) — each writing a normal diary entry and decrementing
// the batch until it's gone. Session-gated in build-app; everything scopes
// to the actor. Ingredient identity still comes from the existing /food/*
// scan endpoints; this router only persists already-resolved items.

const round1 = (v: number) => Math.round(v * 10) / 10

function ingredientToDto(r: PreparedMealIngredientRecord): PreparedMealIngredientDto {
  return {
    id: r.id,
    name: r.name,
    brand: r.brand,
    foodItemId: r.foodItemId,
    gramsAdded: round1(r.gramsAdded),
    kcal: Math.round(r.kcal),
    proteinG: round1(r.proteinG),
    carbsG: round1(r.carbsG),
    fatG: round1(r.fatG),
    source: r.source,
    createdAt: r.createdAt.toISOString(),
  }
}

function mealToDto(r: PreparedMealRecord): PreparedMealDto {
  // servingGrams / servingsRemaining are derived from the stored weight +
  // serving count (never a second stored counter that could drift).
  const servingGrams = mealServingGrams(r.totalGrams, r.servings)
  const dto: PreparedMealDto = {
    id: r.id,
    name: r.name,
    recipeId: r.recipeId,
    status: r.status,
    totalGrams: round1(r.totalGrams),
    totalKcal: Math.round(r.totalKcal),
    totalProteinG: round1(r.totalProteinG),
    totalCarbsG: round1(r.totalCarbsG),
    totalFatG: round1(r.totalFatG),
    gramsRemaining: round1(r.gramsRemaining),
    servings: r.servings,
    servingGrams,
    servingsRemaining: remainingServings(r.gramsRemaining, servingGrams),
    preparedAt: r.preparedAt ? r.preparedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  }
  if (r.ingredients) dto.ingredients = r.ingredients.map(ingredientToDto)
  return dto
}

export const mealPrepRoutes = new Hono<HonoApp>()
  // --- batch lifecycle -------------------------------------------------
  .post('/api/v1/ui/meal-prep', async (c) => {
    const userId = c.var.session!.userId
    const parsed = createPreparedMealSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const { name, fromRecipeId } = parsed.data

    if (fromRecipeId !== undefined) {
      // Cook from a recipe: clone its ingredient lines into a fresh
      // 'cooking' batch the user can adjust before finishing.
      const recipe = await c.var.repos.recipes.getForActor(userId, fromRecipeId)
      if (!recipe) throw errors.notFound('Recipe not found.')
      const mealId = `pmeal_${ulid()}`
      const ingredients: NewPreparedMealIngredient[] = (recipe.ingredients ?? []).map((i) => ({
        id: `pmi_${ulid()}`,
        preparedMealId: mealId,
        name: i.name,
        brand: i.brand,
        foodItemId: i.foodItemId,
        gramsAdded: i.grams,
        kcal: i.kcal,
        proteinG: i.proteinG,
        carbsG: i.carbsG,
        fatG: i.fatG,
        source: i.source,
      }))
      const meal = await c.var.repos.mealPrep.create(
        {
          id: mealId,
          ownerUserId: userId,
          name: name ?? recipe.name,
          recipeId: recipe.id,
          servings: recipe.servings,
        },
        ingredients,
      )
      return c.json(mealToDto(meal), 201)
    }

    const meal = await c.var.repos.mealPrep.create({
      id: `pmeal_${ulid()}`,
      ownerUserId: userId,
      name: name ?? 'Prepared meal',
    })
    return c.json(mealToDto(meal), 201)
  })
  .get('/api/v1/ui/meal-prep', async (c) => {
    const statusParam = c.req.query('status')
    const filter: PreparedMealListFilter = {}
    if (statusParam === 'cooking' || statusParam === 'active' || statusParam === 'finished') {
      filter.status = statusParam
    }
    const rows = await c.var.repos.mealPrep.listForActor(c.var.session!.userId, filter)
    return c.json({ meals: rows.map(mealToDto) })
  })
  .get('/api/v1/ui/meal-prep/:id', async (c) => {
    const meal = await c.var.repos.mealPrep.getForActor(c.var.session!.userId, c.req.param('id'))
    if (!meal) throw errors.notFound('Prepared meal not found.')
    return c.json(mealToDto(meal))
  })
  .patch('/api/v1/ui/meal-prep/:id', async (c) => {
    const parsed = patchPreparedMealSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const fields: PatchPreparedMealFields = {}
    if (parsed.data.name !== undefined) fields.name = parsed.data.name
    if ('servings' in parsed.data) fields.servings = parsed.data.servings ?? null
    const meal = await c.var.repos.mealPrep.patch(c.var.session!.userId, c.req.param('id'), fields)
    if (!meal) throw errors.notFound('Prepared meal not found.')
    return c.json(mealToDto(meal))
  })
  .delete('/api/v1/ui/meal-prep/:id', async (c) => {
    const ok = await c.var.repos.mealPrep.delete(c.var.session!.userId, c.req.param('id'))
    if (!ok) throw errors.notFound('Prepared meal not found.')
    return c.json({ ok: true })
  })
  // --- cooking (ingredient add/remove; 'cooking' status only) ----------
  .post('/api/v1/ui/meal-prep/:id/ingredients', async (c) => {
    const userId = c.var.session!.userId
    const mealId = c.req.param('id')
    const parsed = createMealPrepIngredientSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const b = parsed.data
    if (b.foodItemId !== undefined) {
      // Soft provenance pointer — reject an id that doesn't resolve for
      // this actor so an ingredient never references a phantom cache row.
      const item = await c.var.repos.foodItems.getForActor(userId, b.foodItemId)
      if (!item) throw errors.notFound('Food item not found.')
    }
    const res = await c.var.repos.mealPrep.addIngredient(userId, mealId, {
      id: `pmi_${ulid()}`,
      preparedMealId: mealId,
      name: b.name,
      brand: b.brand ?? null,
      foodItemId: b.foodItemId ?? null,
      gramsAdded: b.gramsAdded,
      kcal: b.kcal,
      proteinG: b.proteinG,
      carbsG: b.carbsG,
      fatG: b.fatG,
      source: b.source,
    })
    if (!res.ok) {
      if (res.reason === 'not_found') throw errors.notFound('Prepared meal not found.')
      throw errors.conflict('meal_not_cooking', 'This meal has already finished cooking.')
    }
    return c.json(mealToDto(res.meal), 201)
  })
  .patch('/api/v1/ui/meal-prep/:id/ingredients/:ingredientId', async (c) => {
    const parsed = updateMealPrepIngredientSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const b = parsed.data
    const res = await c.var.repos.mealPrep.updateIngredient(
      c.var.session!.userId,
      c.req.param('id'),
      c.req.param('ingredientId'),
      {
        name: b.name,
        brand: b.brand ?? null,
        gramsAdded: b.gramsAdded,
        kcal: b.kcal,
        proteinG: b.proteinG,
        carbsG: b.carbsG,
        fatG: b.fatG,
      },
    )
    if (!res.ok) {
      if (res.reason === 'not_found') throw errors.notFound('Prepared meal not found.')
      if (res.reason === 'ingredient_not_found') throw errors.notFound('Ingredient not found.')
      throw errors.conflict('meal_not_cooking', 'This meal has already finished cooking.')
    }
    return c.json(mealToDto(res.meal))
  })
  .delete('/api/v1/ui/meal-prep/:id/ingredients/:ingredientId', async (c) => {
    const res = await c.var.repos.mealPrep.removeIngredient(
      c.var.session!.userId,
      c.req.param('id'),
      c.req.param('ingredientId'),
    )
    if (!res.ok) {
      if (res.reason === 'not_found') throw errors.notFound('Prepared meal not found.')
      throw errors.conflict('meal_not_cooking', 'This meal has already finished cooking.')
    }
    return c.json(mealToDto(res.meal))
  })
  .post('/api/v1/ui/meal-prep/:id/finish', async (c) => {
    const parsed = finishPreparedMealSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const servings = parsed.data.servings ?? null
    const res = await c.var.repos.mealPrep.finish(
      c.var.session!.userId,
      c.req.param('id'),
      servings,
      new Date(),
    )
    if (!res.ok) {
      if (res.reason === 'not_found') throw errors.notFound('Prepared meal not found.')
      if (res.reason === 'empty') {
        throw errors.conflict('meal_empty', 'Add at least one ingredient before finishing.')
      }
      throw errors.conflict('meal_not_cooking', 'This meal has already finished cooking.')
    }
    return c.json(mealToDto(res.meal))
  })
  // Write off the rest of an 'active' batch ("it's gone" — binned, given
  // away, spoiled). Distinct from /finish above, which means "done COOKING":
  // this one ends the eat-down and, unlike /log, writes NO diary entry,
  // because the leftovers weren't eaten. Body-less by design.
  .post('/api/v1/ui/meal-prep/:id/mark-finished', async (c) => {
    const res = await c.var.repos.mealPrep.markFinished(
      c.var.session!.userId,
      c.req.param('id'),
    )
    if (!res.ok) {
      if (res.reason === 'not_found') throw errors.notFound('Prepared meal not found.')
      // One code, two causes (still cooking / already finished) — word it to
      // fit both rather than implying the batch was once being eaten down.
      throw errors.conflict(
        'meal_not_active',
        "This meal isn't being eaten down — it's either still cooking or already finished.",
      )
    }
    return c.json(mealToDto(res.meal))
  })
  // --- consume (log a portion until it's gone; 'active' status only) ---
  .post('/api/v1/ui/meal-prep/:id/log', async (c) => {
    const userId = c.var.session!.userId
    const mealId = c.req.param('id')
    const parsed = logPreparedMealPortionSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const b = parsed.data
    const res = await c.var.repos.mealPrep.logPortion(
      userId,
      mealId,
      {
        entryId: `fl_${ulid()}`,
        loggedAt: new Date(b.loggedAt),
        quantityGrams: b.quantityGrams,
        quantityUnit: b.quantityUnit ?? null,
        quantityAmount: b.quantityAmount ?? null,
        note: b.note ?? null,
      },
      new Date(),
    )
    if (!res.ok) {
      if (res.reason === 'not_found') throw errors.notFound('Prepared meal not found.')
      if (res.reason === 'not_active') {
        // Reachable for a batch that is still cooking OR already finished
        // (drained, or written off by a concurrent mark-finished) — so the
        // copy can't assume "not cooked yet" the way it once did.
        throw errors.conflict(
          'meal_not_active',
          "This meal isn't available to log from — it's either still cooking or already finished.",
        )
      }
      throw errors.conflict(
        'insufficient_remaining',
        `Only ${round1(res.availableGrams ?? 0)} g left in this meal.`,
      )
    }
    return c.json({ meal: mealToDto(res.meal), entry: entryToDto(res.entry) })
  })
  // --- save as recipe (snapshot the ingredient lines) ------------------
  .post('/api/v1/ui/meal-prep/:id/save-as-recipe', async (c) => {
    const userId = c.var.session!.userId
    const meal = await c.var.repos.mealPrep.getForActor(userId, c.req.param('id'))
    if (!meal) throw errors.notFound('Prepared meal not found.')
    const parsed = saveAsRecipeSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const b = parsed.data
    const lines = meal.ingredients ?? []
    if (lines.length === 0) {
      throw errors.conflict('meal_empty', 'Add ingredients before saving as a recipe.')
    }
    const recipeId = `rcp_${ulid()}`
    const ingredients: NewRecipeIngredient[] = lines.map((i) => ({
      id: `ri_${ulid()}`,
      recipeId,
      name: i.name,
      brand: i.brand,
      foodItemId: i.foodItemId,
      grams: i.gramsAdded,
      kcal: i.kcal,
      proteinG: i.proteinG,
      carbsG: i.carbsG,
      fatG: i.fatG,
      source: i.source,
    }))
    const recipe = await c.var.repos.recipes.create(
      {
        id: recipeId,
        ownerUserId: userId,
        name: b.name,
        notes: b.notes ?? null,
        yieldGrams: meal.totalGrams,
        servings: b.servings ?? meal.servings ?? null,
        totalKcal: meal.totalKcal,
        totalProteinG: meal.totalProteinG,
        totalCarbsG: meal.totalCarbsG,
        totalFatG: meal.totalFatG,
      },
      ingredients,
    )
    return c.json(recipeToDto(recipe), 201)
  })

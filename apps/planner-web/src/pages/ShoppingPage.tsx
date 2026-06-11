import { useCallback, useEffect, useState } from 'react'
import {
  ApiError,
  createShoppingItem,
  deleteShoppingItem,
  getShoppingList,
  listShoppingItems,
  updateShoppingItem,
  CATEGORY_KEY,
  SHOPPING_CATEGORY_LABELS,
  SHOPPING_CATEGORY_ORDER,
  type ShoppingCategory,
  type ShoppingItemDto,
  type ShoppingListDto,
} from '../lib/api.js'
import { groupItemsByCategory, isShoppingCategory } from '../lib/shopping-helpers.js'
import { onCreated } from '../lib/refresh-bus.js'
import { Check } from '../ui/bits.js'
import { Icon } from '../ui/icons.js'

// Shopping surface (issue #443). A thin view over the planner-api BFF:
// renders the user's single system-managed shopping list (auto-provisioned
// on first access), lets them add / check-off / delete items, and override
// the auto-assigned category. Items are grouped under category headers in a
// fixed display order. All persistence lives in Lists via the BFF.
// The list itself is not deletable — it is system-managed.

function errMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message
  return 'Something went wrong. Please try again.'
}

// Per-item category picker. Renders a <select> with all category options.
function CategoryPicker({
  value,
  onChange,
}: {
  value: ShoppingCategory
  onChange: (cat: ShoppingCategory) => void
}) {
  return (
    <select
      className="pl-input"
      value={value}
      onChange={(e) => {
        const v = e.target.value
        if (isShoppingCategory(v)) onChange(v)
      }}
      style={{ fontSize: 12, padding: '4px 8px', width: 'auto', minWidth: 110 }}
      aria-label="Category"
    >
      {SHOPPING_CATEGORY_ORDER.map((cat) => (
        <option key={cat} value={cat}>
          {SHOPPING_CATEGORY_LABELS[cat]}
        </option>
      ))}
    </select>
  )
}

export function ShoppingPage() {
  const [shoppingList, setShoppingList] = useState<ShoppingListDto | null>(null)
  const [items, setItems] = useState<ShoppingItemDto[]>([])
  const [newItemTitle, setNewItemTitle] = useState('')
  const [loadingList, setLoadingList] = useState(true)
  const [loadingItems, setLoadingItems] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refreshList = useCallback(async () => {
    setLoadingList(true)
    try {
      const list = await getShoppingList()
      setShoppingList(list)
    } catch (err) {
      setError(errMessage(err))
    } finally {
      setLoadingList(false)
    }
  }, [])

  useEffect(() => {
    void refreshList()
  }, [refreshList])

  const refreshItems = useCallback(async (listId: string) => {
    setLoadingItems(true)
    try {
      setItems(await listShoppingItems(listId))
    } catch (err) {
      setError(errMessage(err))
    } finally {
      setLoadingItems(false)
    }
  }, [])

  useEffect(() => {
    if (shoppingList) {
      void refreshItems(shoppingList.id)
    } else {
      setItems([])
    }
  }, [shoppingList, refreshItems])

  // Refresh items when the global quick-add FAB creates a shopping item.
  useEffect(() => onCreated('shopping', () => {
    if (shoppingList) void refreshItems(shoppingList.id)
  }), [shoppingList, refreshItems])

  async function onCreateItem(e: React.FormEvent) {
    e.preventDefault()
    const title = newItemTitle.trim()
    if (!title || !shoppingList) return
    setError(null)
    try {
      const created = await createShoppingItem(shoppingList.id, title)
      setNewItemTitle('')
      setItems((prev) => [...prev, created])
    } catch (err) {
      setError(errMessage(err))
    }
  }

  async function onToggle(item: ShoppingItemDto) {
    if (!shoppingList) return
    setError(null)
    try {
      const updated = await updateShoppingItem(shoppingList.id, item.id, {
        completed: !item.completed,
      })
      setItems((prev) => prev.map((i) => (i.id === updated.id ? updated : i)))
    } catch (err) {
      setError(errMessage(err))
    }
  }

  async function onCategoryChange(item: ShoppingItemDto, cat: ShoppingCategory) {
    if (!shoppingList) return
    setError(null)
    try {
      const updated = await updateShoppingItem(shoppingList.id, item.id, {
        customFields: { [CATEGORY_KEY]: cat },
      })
      setItems((prev) => prev.map((i) => (i.id === updated.id ? updated : i)))
    } catch (err) {
      setError(errMessage(err))
    }
  }

  async function onDelete(item: ShoppingItemDto) {
    if (!shoppingList) return
    setError(null)
    try {
      await deleteShoppingItem(shoppingList.id, item.id)
      setItems((prev) => prev.filter((i) => i.id !== item.id))
    } catch (err) {
      setError(errMessage(err))
    }
  }

  const groups = groupItemsByCategory(items)
  const doneCount = items.filter((i) => i.completed).length

  return (
    <>
      <div className="pg-head">
        <div>
          <h1>Shopping</h1>
          <div className="sub">Your personal shopping list.</div>
        </div>
      </div>

      {error && (
        <p role="alert" style={{ color: 'var(--hot)', fontSize: 13, marginTop: 0 }}>
          {error}
        </p>
      )}

      {loadingList ? (
        <p className="meta" style={{ color: 'var(--ink-mute)' }}>Loading…</p>
      ) : (
        <div style={{ display: 'grid', gap: 12, minWidth: 0 }}>
          <form style={{ display: 'flex', gap: 8 }} onSubmit={onCreateItem}>
            <input
              className="pl-input"
              aria-label="New item title"
              placeholder="Add an item…"
              value={newItemTitle}
              onChange={(e) => setNewItemTitle(e.target.value)}
            />
            <button className="pl-btn" style={{ padding: '0 16px' }} type="submit">
              <Icon name="plus" size={13} />
              Add
            </button>
          </form>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="meta" style={{ color: 'var(--ink-mute)' }}>
              {doneCount} / {items.length} done
            </span>
          </div>

          {loadingItems ? (
            <p className="meta" style={{ color: 'var(--ink-mute)' }}>Loading…</p>
          ) : items.length === 0 ? (
            <p className="meta" style={{ color: 'var(--ink-mute)' }}>
              Nothing here yet — add an item above.
            </p>
          ) : (
            <div style={{ display: 'grid', gap: 18 }}>
              {groups.map(({ category, items: groupItems }) => (
                <div key={category}>
                  <div
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      letterSpacing: '0.06em',
                      textTransform: 'uppercase',
                      color: 'var(--ink-mute)',
                      marginBottom: 6,
                      paddingBottom: 4,
                      borderBottom: '1px solid var(--line)',
                    }}
                  >
                    {SHOPPING_CATEGORY_LABELS[category]}
                  </div>
                  <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
                    {groupItems.map((item) => {
                      const cat = isShoppingCategory(item.customFields[CATEGORY_KEY])
                        ? (item.customFields[CATEGORY_KEY] as ShoppingCategory)
                        : 'other'
                      return (
                        <li
                          key={item.id}
                          className="pl-row"
                          style={{ gridTemplateColumns: '20px 1fr auto', alignItems: 'center', gap: 8 }}
                        >
                          <Check done={item.completed} onClick={() => void onToggle(item)} />
                          <span
                            style={{
                              flex: 1,
                              minWidth: 0,
                              fontSize: 14,
                              color: item.completed ? 'var(--ink-mute)' : 'var(--ink)',
                              textDecoration: item.completed ? 'line-through' : 'none',
                              display: 'flex',
                              alignItems: 'center',
                              gap: 8,
                              flexWrap: 'wrap',
                            }}
                          >
                            {item.title}
                            <CategoryPicker
                              value={cat}
                              onChange={(newCat) => void onCategoryChange(item, newCat)}
                            />
                          </span>
                          <button
                            type="button"
                            className="pl-donebtn"
                            onClick={() => void onDelete(item)}
                            aria-label={`Delete ${item.title}`}
                          >
                            Delete
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  )
}

import { useEffect, useMemo, useState } from 'react'
import {
  ApiError,
  deleteShoppingItem,
  shoppingItemsQuery,
  shoppingListQuery,
  updateShoppingItem,
  CATEGORY_KEY,
  SHOPPING_CATEGORY_LABELS,
  SHOPPING_CATEGORY_ORDER,
  type ShoppingCategory,
  type ShoppingItemDto,
} from '../lib/api.js'
import { useCachedQuery } from '../lib/offline/use-cached-query.js'
import {
  completedItemIds,
  groupItemsByCategory,
  isShoppingCategory,
  itemQuantity,
} from '../lib/shopping-helpers.js'
import { shoppingCustomFields } from '../lib/shopping-edit.js'
import { onCreated } from '../lib/refresh-bus.js'
import { ConfirmDialog, Drawer, SwipeActions } from '@rallypoint/ui'
import { Check } from '../ui/bits.js'
import { SkeletonBlock, SkeletonRows } from '../ui/Skeleton.js'
import { QuickAdd } from '../ui/QuickAdd.js'
import { ShoppingItemDetail } from '../ui/ShoppingItemDetail.js'

// Shopping surface (issue #443). A thin view over the planner-api BFF:
// renders the user's single system-managed shopping list (auto-provisioned
// on first access), lets them add / check-off / delete items, and override
// the auto-assigned category. Items are grouped under category headers in a
// fixed display order. All persistence lives in Lists via the BFF.
// The list itself is not deletable — it is system-managed.
//
// Auto-categorize on/off is controlled by the `shoppingAutoCategorize`
// planner setting (toggled in SettingsPage). The BFF reads that setting on
// item create and forwards it to lists-api — this page does not need to
// know about it; `createShoppingItem` needs no client-side flag.

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
      className="pl-input sm"
      value={value}
      onChange={(e) => {
        const v = e.target.value
        if (isShoppingCategory(v)) onChange(v)
      }}
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
  // Render-from-cache: last-known list + items paint instantly; the
  // subscription re-renders on every cache write, so the local-first
  // mutations below need no manual setItems mirroring.
  const listQ = useCachedQuery(useMemo(() => shoppingListQuery(), []))
  const listId = listQ.data?.id ?? null
  // The `quantity` custom-field def id, provisioned by the BFF with the list.
  // Null on a pre-quantity cached response — quantity affordances stay hidden
  // until the fresh fetch lands.
  const quantityFieldId = listQ.data?.quantityFieldId ?? null
  const itemsQ = useCachedQuery(
    useMemo(() => (listId ? shoppingItemsQuery(listId) : null), [listId]),
  )
  const items = useMemo(() => itemsQ.data ?? [], [itemsQ.data])

  const [error, setError] = useState<string | null>(null)
  const [clearing, setClearing] = useState(false)
  // Swipe/hover Delete stages the item here; the ConfirmDialog commits it.
  const [confirmDelete, setConfirmDelete] = useState<ShoppingItemDto | null>(null)
  // Tapping an item name opens the detail drawer (name / category / quantity).
  const [editingId, setEditingId] = useState<string | null>(null)

  const loadingList = listQ.status === 'loading'
  const loadingItems = listId !== null && itemsQ.status === 'loading'

  useEffect(() => {
    if (listQ.status === 'error') setError(errMessage(listQ.error))
    else if (itemsQ.status === 'error') setError(errMessage(itemsQ.error))
  }, [listQ.status, listQ.error, itemsQ.status, itemsQ.error])

  // Refetch when the global quick-add FAB creates a shopping item (picks
  // up the server-assigned category).
  const refetchItems = itemsQ.refetch
  useEffect(() => onCreated('shopping', () => void refetchItems()), [refetchItems])

  async function onToggle(item: ShoppingItemDto) {
    if (!listId) return
    setError(null)
    try {
      await updateShoppingItem(listId, item.id, { completed: !item.completed })
    } catch (err) {
      setError(errMessage(err))
    }
  }

  async function onCategoryChange(item: ShoppingItemDto, cat: ShoppingCategory) {
    if (!listId) return
    setError(null)
    try {
      // Resends the quantity alongside the new category: the optimistic cache
      // merge replaces customFields wholesale, so a category-only patch would
      // blank the row's quantity chip until the next refetch.
      await updateShoppingItem(listId, item.id, {
        customFields: shoppingCustomFields(
          cat,
          itemQuantity(item, quantityFieldId),
          quantityFieldId,
        ),
      })
    } catch (err) {
      setError(errMessage(err))
    }
  }

  async function onDelete(item: ShoppingItemDto) {
    if (!listId) return
    setError(null)
    try {
      await deleteShoppingItem(listId, item.id)
    } catch (err) {
      setError(errMessage(err))
    }
  }

  // Delete every checked item. Best-effort per item: failures keep their rows
  // (refetch reconciles) and surface one error message.
  async function onClearChecked() {
    if (!listId) return
    const ids = completedItemIds(items)
    if (ids.length === 0) return
    setError(null)
    setClearing(true)
    try {
      const results = await Promise.allSettled(ids.map((id) => deleteShoppingItem(listId, id)))
      if (results.some((r) => r.status === 'rejected')) {
        setError('Some items could not be cleared. Please try again.')
      }
      await refetchItems()
    } finally {
      setClearing(false)
    }
  }

  const groups = groupItemsByCategory(items)
  const doneCount = items.filter((i) => i.completed).length
  const editing = items.find((i) => i.id === editingId) ?? null

  return (
    <>
      <div className="pg-head pl-wide">
        <div>
          <h1>Shopping</h1>
          {!loadingList && items.length > 0 && (
            <div className="sub">
              {doneCount} of {items.length} in the cart
            </div>
          )}
        </div>
      </div>

      {error && (
        <p role="alert" style={{ color: 'var(--hot)', fontSize: 13, marginTop: 0 }}>
          {error}
        </p>
      )}

      {loadingList ? (
        <div role="status" aria-busy="true" aria-label="Loading shopping list">
          <SkeletonBlock height={44} style={{ marginBottom: 12 }} />
          <SkeletonRows count={5} height={46} bare />
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 12, minWidth: 0 }}>
          {/* Cart-fill progress per the Ink kit. `.progress` is defined in
              @rallypoint/ui's primitives layer; the inner div is what
              scales horizontally. */}
          {items.length > 0 && (
            <div
              className="progress"
              style={{ height: 6 }}
              role="progressbar"
              aria-valuenow={doneCount}
              aria-valuemin={0}
              aria-valuemax={items.length}
              aria-label="Shopping cart fill"
            >
              <div
                style={{
                  transform: `scaleX(${items.length ? doneCount / items.length : 0})`,
                }}
              />
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="meta" style={{ color: 'var(--ink-mute)' }}>
              {doneCount} / {items.length} done
            </span>
            {doneCount > 0 && (
              <button
                type="button"
                className="pl-btn ghost sm"
                style={{ marginLeft: 'auto' }}
                onClick={() => void onClearChecked()}
                disabled={clearing}
              >
                {clearing ? 'Clearing…' : 'Clear checked'}
              </button>
            )}
          </div>

          {loadingItems ? (
            <SkeletonRows count={5} height={46} label="Loading shopping list" />
          ) : items.length === 0 ? (
            <p className="meta" style={{ color: 'var(--ink-mute)' }}>
              Nothing here yet — add an item with the + button.
            </p>
          ) : (
            <div className="shop-groups">
              {groups.map(({ category, items: groupItems }) => (
                <div key={category}>
                  {/* Ink kit category divider: eyebrow text + hairline trailing
                      line. `.pl-eyerow` lives in @rallypoint/ui/shell.css. */}
                  <div className="pl-eyerow">
                    <span className="eyebrow">
                      {SHOPPING_CATEGORY_LABELS[category]}
                    </span>
                    <span className="ln" />
                  </div>
                  <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
                    {groupItems.map((item) => {
                      const cat = isShoppingCategory(item.customFields[CATEGORY_KEY])
                        ? (item.customFields[CATEGORY_KEY] as ShoppingCategory)
                        : 'other'
                      const qty = itemQuantity(item, quantityFieldId)
                      return (
                        // Fixed grid tracks (the .set-row recipe): the category
                        // picker owns its own column, so its position and the
                        // row's shape never depend on the item-name length or
                        // the selected option's text. The trailing track holds
                        // the quantity chip and collapses to nothing when the
                        // item has no quantity. Delete lives in the
                        // SwipeActions tray (delete-only — the category picker
                        // stays inline; the name opens the detail drawer).
                        <SwipeActions
                          key={item.id}
                          as="li"
                          actions={[
                            {
                              key: 'delete',
                              label: `Delete ${item.title}`,
                              icon: <>✕</>,
                              onAction: () => setConfirmDelete(item),
                            },
                          ]}
                          contentClassName="pl-row"
                          contentStyle={{
                            // The category track stays at 130px: that is what
                            // the longest label ("Meat & Seafood") needs, and
                            // narrowing it to buy the title back some width
                            // clips the collapsed select instead — a worse
                            // trade, since the picker is a live control while
                            // a truncated title still ellipsises legibly.
                            // The quantity track is `auto`, so it collapses
                            // to nothing on items without a quantity.
                            gridTemplateColumns: '20px minmax(0, 1fr) auto 130px',
                            alignItems: 'center',
                            gap: 8,
                          }}
                        >
                          <Check
                            done={item.completed}
                            onClick={() => void onToggle(item)}
                            label={item.completed ? `Mark ${item.title} not bought` : `Mark ${item.title} bought`}
                          />
                          <button
                            type="button"
                            className="pl-rowtitle"
                            onClick={() => setEditingId(item.id)}
                            style={{
                              minWidth: 0,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              fontSize: 14,
                              color: item.completed ? 'var(--ink-mute)' : 'var(--ink)',
                              textDecoration: item.completed ? 'line-through' : 'none',
                            }}
                            aria-label={`Edit ${item.title}`}
                          >
                            {item.title}
                          </button>
                          {qty ? <span className="pl-chip sm">{qty}</span> : <span />}
                          <CategoryPicker
                            value={cat}
                            onChange={(newCat) => void onCategoryChange(item, newCat)}
                          />
                        </SwipeActions>
                      )
                    })}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <ConfirmDialog
        open={confirmDelete !== null}
        title="Delete item?"
        body={confirmDelete ? `“${confirmDelete.title}” will be removed from the list.` : undefined}
        confirmLabel="Delete"
        confirmVariant="hot"
        onConfirm={async () => {
          const item = confirmDelete
          setConfirmDelete(null)
          if (item) await onDelete(item)
        }}
        onCancel={() => setConfirmDelete(null)}
      />
      {/* Detail editor. Held by id, not by value, so the body always sees the
          freshest cached item (its own saves rewrite the cache). */}
      <Drawer
        open={editing !== null}
        onClose={() => setEditingId(null)}
        title="Item"
        mobileSheet
      >
        {editing && listId && (
          <ShoppingItemDetail
            item={editing}
            listId={listId}
            quantityFieldId={quantityFieldId}
          />
        )}
      </Drawer>
      <QuickAdd anchor="float" />
    </>
  )
}

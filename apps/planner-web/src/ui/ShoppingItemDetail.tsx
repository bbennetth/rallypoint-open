import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ApiError,
  SHOPPING_CATEGORY_LABELS,
  SHOPPING_CATEGORY_ORDER,
  updateShoppingItem,
  type ShoppingCategory,
  type ShoppingItemDto,
} from '../lib/api.js'
import { isShoppingCategory, MAX_QUANTITY_LEN } from '../lib/shopping-helpers.js'
import {
  buildShoppingPatch,
  savedShoppingState,
  shoppingEditState,
} from '../lib/shopping-edit.js'

// Detail + quick-edit body for a shopping item, rendered inside an Ink Drawer
// by ShoppingPage. Edits the title, the category, and the free-form quantity
// (a Lists custom field — see lib/shopping-edit.ts). Edits auto-save: typing
// is debounced, discrete picks and blur flush immediately, and there is no
// Save button. Mirrors TaskDetail's editor contract.

// Debounce window before a typed edit is flushed. Field blur and drawer close
// flush immediately, so this only governs mid-typing saves.
const SAVE_DEBOUNCE_MS = 600

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

function errMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message
  return 'Something went wrong. Please try again.'
}

// No onChanged callback (unlike TaskDetail): every save goes through
// updateShoppingItem, which rewrites the offline cache, and the host page
// renders from a cache subscription — so the row updates on its own without
// a refetch per debounced keystroke.
export function ShoppingItemDetail({
  item,
  listId,
  quantityFieldId,
}: {
  item: ShoppingItemDto
  listId: string
  quantityFieldId: string | null
}) {
  const initial = shoppingEditState(item, quantityFieldId)
  const [title, setTitle] = useState(initial.title)
  const [category, setCategory] = useState<ShoppingCategory>(initial.category)
  const [quantity, setQuantity] = useState(initial.quantity)
  const [status, setStatus] = useState<SaveStatus>('idle')
  const [error, setError] = useState<string | null>(null)

  // The last-persisted baseline each edit is diffed against, and the latest
  // draft — both in refs so the debounced flush always reads current values
  // without being re-created on every keystroke.
  const savedRef = useRef(initial)
  const draftRef = useRef(initial)
  draftRef.current = { title, category, quantity }
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // A different item opened into the same drawer instance — reset baseline +
  // fields. Keyed on id ONLY: a refetch re-supplying the same item (e.g.
  // after a category save fires onChanged) must not clobber an in-progress
  // title edit.
  const itemId = item.id
  useEffect(() => {
    const next = shoppingEditState(item, quantityFieldId)
    savedRef.current = next
    setTitle(next.title)
    setCategory(next.category)
    setQuantity(next.quantity)
    setStatus('idle')
    setError(null)
  }, [itemId])

  const flush = useCallback(async () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const patch = buildShoppingPatch(savedRef.current, draftRef.current, quantityFieldId)
    if (!patch) return
    setStatus('saving')
    setError(null)
    try {
      await updateShoppingItem(listId, itemId, patch)
      savedRef.current = savedShoppingState(savedRef.current, draftRef.current)
      setStatus('saved')
    } catch (err) {
      setError(errMessage(err))
      setStatus('error')
    }
  }, [listId, itemId, quantityFieldId])

  // Flush any pending edit on unmount (drawer close) — without depending on
  // the possibly-unstable `flush` identity, which would fire mid-edit.
  const flushRef = useRef(flush)
  flushRef.current = flush
  useEffect(() => () => void flushRef.current(), [])

  function scheduleSave() {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => void flush(), SAVE_DEBOUNCE_MS)
  }

  function onTypedChange(next: Partial<{ title: string; quantity: string }>) {
    if (next.title !== undefined) setTitle(next.title)
    if (next.quantity !== undefined) setQuantity(next.quantity)
    // Clear a stale "Saved" the instant the user resumes typing, rather than
    // letting it linger through the debounce window.
    if (status !== 'idle') setStatus('idle')
    scheduleSave()
  }

  function onTitleBlur() {
    // An empty title is never persisted (buildShoppingPatch skips it); snap
    // the field back so the input doesn't sit visually empty.
    if (title.trim() === '') setTitle(savedRef.current.title)
    else void flush()
  }

  function onCategoryChange(next: ShoppingCategory) {
    setCategory(next)
    // A discrete pick, not typing — save right away.
    if (timerRef.current) clearTimeout(timerRef.current)
    draftRef.current = { ...draftRef.current, category: next }
    void flush()
  }

  return (
    <div className="pl-fab-form">
      <span
        aria-live="polite"
        className="meta"
        style={{
          textAlign: 'right',
          color: status === 'error' ? 'var(--hot)' : 'var(--ink-mute)',
          minHeight: 14,
        }}
      >
        {status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved' : ''}
      </span>
      <label className="pl-fab-label">
        Item
        <input
          className="pl-input"
          value={title}
          onChange={(e) => onTypedChange({ title: e.target.value })}
          onBlur={onTitleBlur}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              e.currentTarget.blur()
            }
          }}
          aria-label="Item name"
        />
      </label>
      <label className="pl-fab-label">
        Category
        <select
          className="pl-input"
          value={category}
          onChange={(e) => {
            if (isShoppingCategory(e.target.value)) onCategoryChange(e.target.value)
          }}
          aria-label="Category"
        >
          {SHOPPING_CATEGORY_ORDER.map((cat) => (
            <option key={cat} value={cat}>
              {SHOPPING_CATEGORY_LABELS[cat]}
            </option>
          ))}
        </select>
      </label>
      {quantityFieldId && (
        <label className="pl-fab-label">
          Quantity
          <input
            className="pl-input"
            value={quantity}
            maxLength={MAX_QUANTITY_LEN}
            placeholder="e.g. 2 or 4 bags"
            onChange={(e) => onTypedChange({ quantity: e.target.value })}
            onBlur={() => void flush()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                e.currentTarget.blur()
              }
            }}
            aria-label="Quantity"
          />
        </label>
      )}
      {error && (
        <p role="alert" className="pl-fab-error">
          {error}
        </p>
      )}
    </div>
  )
}

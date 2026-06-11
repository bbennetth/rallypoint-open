import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Button,
  ConfirmDialog,
  Drawer,
  EmptyState,
  Table,
  useToast,
  type TableColumn,
  type TableRow,
} from '@rallypoint/ui'
import {
  ApiError,
  createEventTicket,
  deleteEventTicket,
  listEventTickets,
  patchEventTicket,
  restoreEventTicket,
  type TicketDto,
} from '../../lib/api.js'
import { useEventOutlet } from './_event-outlet.js'

// Phase T owner-side Tickets tab. CRUD only — no selling yet. Uses
// the Phase 5 <Table>, <Drawer>, <ConfirmDialog>, and useToast()
// primitives.

type EditTarget =
  | { mode: 'create' }
  | { mode: 'edit'; ticket: TicketDto }

type SortKey = 'name' | 'price' | 'quantity' | 'sold' | 'sortOrder' | 'actions'

export function TicketsPage() {
  const { event } = useEventOutlet()
  const toast = useToast()
  const [tickets, setTickets] = useState<TicketDto[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [editing, setEditing] = useState<EditTarget | null>(null)
  const [confirmTarget, setConfirmTarget] = useState<TicketDto | null>(null)
  const [removing, setRemoving] = useState(false)
  const isEditor =
    event.viewer_role === 'owner' || event.viewer_role === 'editor'

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const page = await listEventTickets(event.id)
      setTickets(page.items)
      setLoadError(null)
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Failed to load tickets.')
    } finally {
      setLoading(false)
    }
  }, [event.id])

  useEffect(() => {
    void load()
  }, [load])

  const columns: TableColumn<SortKey>[] = [
    { key: 'name', header: 'Tier', sortable: true, accessor: (r) => (r.name as string) ?? '' },
    {
      key: 'price',
      header: 'Price',
      sortable: true,
      align: 'right',
      width: 110,
      accessor: (r) => (r.priceCents as number) ?? 0,
    },
    {
      key: 'quantity',
      header: 'Quantity',
      sortable: true,
      align: 'right',
      width: 110,
      accessor: (r) => {
        const q = r.quantityNum
        return typeof q === 'number' ? q : Number.POSITIVE_INFINITY
      },
    },
    {
      key: 'sold',
      header: 'Sold',
      sortable: true,
      align: 'right',
      width: 80,
      accessor: (r) => (r.soldCount as number) ?? 0,
    },
    {
      key: 'sortOrder',
      header: 'Order',
      sortable: true,
      align: 'right',
      width: 70,
      accessor: (r) => (r.sortOrderNum as number) ?? 0,
    },
    { key: 'actions', header: '', align: 'right', width: 160 },
  ]

  const rows: TableRow<SortKey>[] = tickets.map((t) => ({
    id: t.id,
    name: (
      <div className="min-w-0">
        <div className="truncate">
          {t.deleted_at ? <s className="text-white/40">{t.name}</s> : t.name}
        </div>
        {t.description && (
          <div className="text-xs text-white/40 truncate">{t.description}</div>
        )}
      </div>
    ),
    price: formatCents(t.price_cents),
    priceCents: t.price_cents,
    quantity: t.quantity === null ? '∞' : t.quantity.toLocaleString(),
    quantityNum: t.quantity,
    sold: t.sold_count.toLocaleString(),
    soldCount: t.sold_count,
    sortOrder: t.sort_order,
    sortOrderNum: t.sort_order,
    actions: isEditor ? (
      <div className="flex items-center gap-2 justify-end">
        {t.deleted_at ? (
          <Button
            variant="ghost"
            onClick={async () => {
              try {
                const restored = await restoreEventTicket(event.id, t.id)
                setTickets((prev) => prev.map((x) => (x.id === t.id ? restored : x)))
                toast({ tone: 'success', body: 'Ticket tier restored.' })
              } catch (err) {
                toast({
                  tone: 'error',
                  body: err instanceof ApiError ? err.message : 'Failed to restore tier.',
                })
              }
            }}
          >
            Restore
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={() => setEditing({ mode: 'edit', ticket: t })}>
              Edit
            </Button>
            <Button
              variant="ghost"
              onClick={() => setConfirmTarget(t)}
              aria-label={`Delete ${t.name}`}
            >
              Delete
            </Button>
          </>
        )}
      </div>
    ) : null,
  }))

  const active = tickets.filter((t) => t.deleted_at === null)

  return (
    <main className="page-pad">
      <div className="max-w-5xl mx-auto space-y-5">
        <header className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <p
              className="text-xs font-medium"
              style={{ color: 'var(--acid)' }}
            >
              Tickets
            </p>
            <h1 className="display text-2xl">{event.name}</h1>
            <p className="text-white/60 text-sm mt-1">
              Define tiers people can buy or RSVP to. Selling integration ships in
              a follow-up phase; today this defines the catalogue.
            </p>
          </div>
          {isEditor && (
            <Button variant="brutal" onClick={() => setEditing({ mode: 'create' })}>
              Add ticket tier
            </Button>
          )}
        </header>

        {loadError && (
          <div
            className="p-3"
            style={{
              border: '1.5px solid var(--hot)',
              background: 'color-mix(in srgb, var(--hot) 12%, transparent)',
            }}
          >
            <p className="text-sm text-white/80">{loadError}</p>
          </div>
        )}

        {loading && tickets.length === 0 && !loadError ? (
          <p className="text-sm text-white/60">Loading…</p>
        ) : active.length === 0 && !loadError ? (
          <EmptyState
            title="No ticket tiers yet"
            body="Add a tier (e.g. General Admission, VIP) to define what attendees can buy."
            action={
              isEditor && (
                <Button variant="brutal" onClick={() => setEditing({ mode: 'create' })}>
                  Add ticket tier
                </Button>
              )
            }
          />
        ) : (
          <div
            style={{
              border: '1.5px solid var(--line)',
              background: 'var(--surface)',
              padding: 4,
            }}
          >
            <Table<SortKey>
              columns={columns}
              rows={rows}
              sort={{ column: 'sortOrder', dir: 'asc' }}
              zebra
            />
          </div>
        )}
      </div>

      <Drawer
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing?.mode === 'edit' ? 'Edit ticket tier' : 'Add ticket tier'}
      >
        {editing && (
          <TicketForm
            initial={editing.mode === 'edit' ? editing.ticket : null}
            onCancel={() => setEditing(null)}
            onSubmit={async (input) => {
              try {
                if (editing.mode === 'edit') {
                  const updated = await patchEventTicket(
                    event.id,
                    editing.ticket.id,
                    input,
                  )
                  setTickets((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))
                  toast({ tone: 'success', body: 'Ticket tier updated.' })
                } else {
                  const created = await createEventTicket(event.id, input)
                  setTickets((prev) => [...prev, created])
                  toast({ tone: 'success', body: 'Ticket tier created.' })
                }
                setEditing(null)
              } catch (err) {
                if (err instanceof ApiError && err.code === 'ticket_name_taken') {
                  toast({
                    tone: 'error',
                    body: 'A tier with that name already exists.',
                  })
                  return
                }
                toast({
                  tone: 'error',
                  body: err instanceof ApiError ? err.message : 'Save failed.',
                })
              }
            }}
          />
        )}
      </Drawer>

      <ConfirmDialog
        open={confirmTarget !== null}
        title="Delete ticket tier?"
        body={
          confirmTarget && (
            <>
              <strong>{confirmTarget.name}</strong> will be soft-deleted. You can
              restore it later from this list.
            </>
          )
        }
        confirmLabel="Delete"
        confirmVariant="hot"
        busy={removing}
        onCancel={() => {
          if (!removing) setConfirmTarget(null)
        }}
        onConfirm={async () => {
          if (!confirmTarget) return
          setRemoving(true)
          try {
            await deleteEventTicket(event.id, confirmTarget.id)
            setTickets((prev) =>
              prev.map((t) =>
                t.id === confirmTarget.id
                  ? { ...t, deleted_at: new Date().toISOString() }
                  : t,
              ),
            )
            toast({ tone: 'success', body: 'Ticket tier deleted.' })
            setConfirmTarget(null)
          } catch (err) {
            if (err instanceof ApiError && err.code === 'ticket_has_sales') {
              toast({
                tone: 'error',
                body: 'This tier has sales and cannot be deleted.',
              })
            } else {
              toast({
                tone: 'error',
                body: err instanceof ApiError ? err.message : 'Delete failed.',
              })
            }
          } finally {
            setRemoving(false)
          }
        }}
      />
    </main>
  )
}

function TicketForm({
  initial,
  onSubmit,
  onCancel,
}: {
  initial: TicketDto | null
  onSubmit: (input: {
    name: string
    description: string | null
    priceCents: number
    quantity: number | null
    sortOrder: number
  }) => Promise<void>
  onCancel: () => void
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [priceDollars, setPriceDollars] = useState(
    initial ? (initial.price_cents / 100).toFixed(2) : '0.00',
  )
  const [unlimited, setUnlimited] = useState(
    initial ? initial.quantity === null : false,
  )
  const [quantity, setQuantity] = useState(
    initial?.quantity?.toString() ?? '100',
  )
  const [sortOrder, setSortOrder] = useState(initial?.sort_order.toString() ?? '0')
  const [submitting, setSubmitting] = useState(false)

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault()
        const priceCents = Math.round(Number.parseFloat(priceDollars) * 100)
        if (!Number.isFinite(priceCents) || priceCents < 0) return
        setSubmitting(true)
        try {
          await onSubmit({
            name: name.trim(),
            description: description.trim() === '' ? null : description.trim(),
            priceCents,
            quantity: unlimited ? null : Math.max(0, Number.parseInt(quantity, 10) || 0),
            sortOrder: Math.max(0, Number.parseInt(sortOrder, 10) || 0),
          })
        } finally {
          setSubmitting(false)
        }
      }}
      style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
    >
      <FormField label="Tier name">
        <input
          type="text"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={100}
          className="cyber-input"
          placeholder="General Admission"
        />
      </FormField>
      <FormField label="Description">
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={2000}
          rows={3}
          className="cyber-input"
          placeholder="Optional details for attendees."
        />
      </FormField>
      <FormField label="Price (USD)">
        <input
          type="number"
          min="0"
          step="0.01"
          required
          value={priceDollars}
          onChange={(e) => setPriceDollars(e.target.value)}
          className="cyber-input"
        />
      </FormField>
      <FormField label="Quantity">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <label
            className="mono"
            style={{
              fontSize: 11,
              color: 'var(--ink-dim)',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <input
              type="checkbox"
              checked={unlimited}
              onChange={(e) => setUnlimited(e.target.checked)}
            />
            Unlimited
          </label>
          {!unlimited && (
            <input
              type="number"
              min="0"
              step="1"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              className="cyber-input"
              style={{ flex: 1 }}
            />
          )}
        </div>
      </FormField>
      <FormField label="Sort order">
        <input
          type="number"
          min="0"
          step="1"
          value={sortOrder}
          onChange={(e) => setSortOrder(e.target.value)}
          className="cyber-input"
        />
      </FormField>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
        <Button variant="ghost" type="button" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button variant="brutal" type="submit" loading={submitting} disabled={submitting}>
          {initial ? 'Save' : 'Create'}
        </Button>
      </div>
    </form>
  )
}

function FormField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span
        className="mono"
        style={{
          fontSize: 11,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          color: 'var(--ink-dim)',
        }}
      >
        {label}
      </span>
      {children}
    </div>
  )
}

function formatCents(cents: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100)
}

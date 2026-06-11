import type { ReactNode } from 'react'
import {
  compareValues,
  nextSortState,
  type SortDir,
  type SortState,
} from '../lib/sort.js'

// Primitive admin table. Render-style is fully controlled — callers
// supply column defs + row data and the component handles header
// rendering, sort caret display, and the click-to-sort cycle. No
// virtualisation; the platform baseline targets ≤ ~500 rows per
// table (cap at the Attendees endpoint's pagination level).
//
//   <Table
//     columns={[
//       { key: 'name', header: 'Name', sortable: true },
//       { key: 'email', header: 'Email', sortable: true },
//       { key: 'joined', header: 'Joined', sortable: true, align: 'right' },
//       { key: 'actions', header: '', width: 56 },
//     ]}
//     rows={items.map((it) => ({
//       id: it.userId,
//       name: it.displayName ?? '—',
//       email: it.email,
//       joined: new Date(it.joinedAt),
//       actions: <Button variant="ghost" onClick={() => onRemove(it)}>×</Button>,
//     }))}
//     sort={sort}
//     onSortChange={setSort}
//   />
//
// For sort-server-side, callers pass `sortedRows` directly and ignore
// the internal compare; pass `controlledSort` to disable client-side
// sort entirely.

export type TableColumnAlign = 'left' | 'right' | 'center'

export interface TableColumn<TKey extends string> {
  key: TKey
  header: ReactNode
  sortable?: boolean
  align?: TableColumnAlign
  width?: number | string
  /**
   * Optional accessor: when client-side sort is enabled, used to
   * pluck a comparable value from the row. Defaults to `row[key]`.
   */
  accessor?: (row: TableRow<TKey>) => string | number | Date | null | undefined
}

export type TableRow<TKey extends string> = { id: string } & {
  [K in TKey]?: ReactNode | string | number | Date | null
}

export interface TableProps<TKey extends string> {
  columns: ReadonlyArray<TableColumn<TKey>>
  rows: ReadonlyArray<TableRow<TKey>>
  /** Current sort state (controlled). */
  sort?: SortState<TKey> | null
  /** Called on header click; receives the next state. */
  onSortChange?: (next: SortState<TKey>) => void
  /**
   * When true, the table does NOT sort `rows` locally — the caller
   * is expected to have pre-sorted them. Default false (client-side).
   */
  controlledSort?: boolean
  /** Optional zebra background on even rows. */
  zebra?: boolean
  /** Rendered in the body when `rows.length === 0`. */
  emptyState?: ReactNode
  /** Optional table caption for accessibility. */
  caption?: string
}

export function Table<TKey extends string>({
  columns,
  rows,
  sort,
  onSortChange,
  controlledSort = false,
  zebra = false,
  emptyState,
  caption,
}: TableProps<TKey>) {
  const ordered = (() => {
    if (controlledSort || !sort) return rows
    const col = columns.find((c) => c.key === sort.column)
    if (!col) return rows
    const acc = col.accessor ?? ((row: TableRow<TKey>) => row[sort.column] as never)
    return [...rows].sort((a, b) => compareValues(acc(a) as never, acc(b) as never, sort.dir))
  })()

  return (
    <table
      style={{
        width: '100%',
        borderCollapse: 'collapse',
        fontSize: 13,
        color: 'var(--ink)',
      }}
    >
      {caption && (
        <caption
          style={{
            captionSide: 'top',
            textAlign: 'left',
            color: 'var(--ink-dim)',
            padding: '4px 0 8px',
            fontSize: 12,
          }}
        >
          {caption}
        </caption>
      )}
      <thead>
        <tr>
          {columns.map((col) => (
            <th
              key={col.key}
              scope="col"
              aria-sort={ariaSort(sort, col)}
              style={{
                textAlign: col.align ?? 'left',
                width: col.width,
                padding: '8px 10px',
                borderBottom: '1.5px solid var(--line)',
                fontWeight: 600,
                fontSize: 11,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: 'var(--ink-dim)',
                cursor: col.sortable ? 'pointer' : 'default',
                userSelect: 'none',
                whiteSpace: 'nowrap',
              }}
              onClick={() => {
                if (!col.sortable || !onSortChange) return
                onSortChange(nextSortState<TKey>(sort ?? null, col.key))
              }}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                {col.header}
                {col.sortable && (
                  <SortCaret
                    active={sort?.column === col.key}
                    dir={sort?.column === col.key ? sort.dir : null}
                  />
                )}
              </span>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {ordered.length === 0 && emptyState ? (
          <tr>
            <td colSpan={columns.length} style={{ padding: 0 }}>
              {emptyState}
            </td>
          </tr>
        ) : (
          ordered.map((row, i) => (
            <tr
              key={row.id}
              style={{
                background: zebra && i % 2 === 1 ? 'var(--surface)' : 'transparent',
                borderBottom: '1px solid var(--line)',
              }}
            >
              {columns.map((col) => (
                <td
                  key={col.key}
                  style={{
                    padding: '10px',
                    textAlign: col.align ?? 'left',
                    verticalAlign: 'middle',
                  }}
                >
                  {renderCell(row[col.key])}
                </td>
              ))}
            </tr>
          ))
        )}
      </tbody>
    </table>
  )
}

function renderCell(value: unknown): ReactNode {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toLocaleString()
  if (typeof value === 'object') return value as ReactNode
  return String(value)
}

function ariaSort<TKey extends string>(
  sort: SortState<TKey> | null | undefined,
  col: TableColumn<TKey>,
): 'ascending' | 'descending' | 'none' | undefined {
  if (!col.sortable) return undefined
  if (!sort || sort.column !== col.key) return 'none'
  return sort.dir === 'asc' ? 'ascending' : 'descending'
}

function SortCaret({ active, dir }: { active: boolean; dir: SortDir | null }) {
  const opacity = active ? 1 : 0.3
  return (
    <span
      aria-hidden
      style={{
        fontSize: 9,
        opacity,
        lineHeight: 1,
      }}
    >
      {dir === 'desc' ? '▼' : '▲'}
    </span>
  )
}

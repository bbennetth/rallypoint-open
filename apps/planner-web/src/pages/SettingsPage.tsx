import { ACCENT_HEX, COLORS_ORDER, useThemeStore, type Theme } from '@rallypoint/ui'
import { NAV } from '../ui/nav.js'
import { useTabOrder, setTabOrder, orderNav } from '../lib/tab-order.js'

// Settings surface — the first dedicated settings page. Theme (mode + accent)
// is the first user setting; changes drive the shared store actions, which the
// bootstrap persister (main.tsx) write-throughs into the RPID `shared` bag, so
// the choice follows the user across apps + devices. More sections land here as
// settings grow.

const MODE_OPTIONS: ReadonlyArray<{ value: Theme; label: string }> = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

export function SettingsPage() {
  const mode = useThemeStore((s) => s.mode)
  const color = useThemeStore((s) => s.color)
  const setMode = useThemeStore((s) => s.setMode)
  const setColor = useThemeStore((s) => s.setColor)

  const order = useTabOrder()
  const orderedNav = orderNav(NAV, order)

  function moveTab(index: number, dir: -1 | 1) {
    const next = [...orderedNav]
    const swap = index + dir
    if (swap < 0 || swap >= next.length) return
    ;[next[index], next[swap]] = [next[swap], next[index]]
    setTabOrder(next.map((n) => n.to))
  }

  return (
    <>
      <div className="pg-head">
        <div>
          <div className="eyebrow">Settings</div>
          <h1>Theme</h1>
          <div className="sub">Saved to your account — it follows you across Rallypoint apps and devices.</div>
        </div>
      </div>

      <div className="pl-card" style={{ padding: 18, display: 'grid', gap: 22, maxWidth: 560 }}>
        <div style={{ display: 'grid', gap: 10 }}>
          <div className="eyebrow">Mode</div>
          <div className="seg" role="group" aria-label="Color mode">
            {MODE_OPTIONS.map((m) => (
              <button
                key={m.value}
                type="button"
                className={mode === m.value ? 'on' : ''}
                aria-pressed={mode === m.value}
                onClick={() => setMode(m.value)}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>

        <div style={{ display: 'grid', gap: 10 }}>
          <div className="eyebrow">Accent</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }} role="group" aria-label="Accent color">
            {COLORS_ORDER.map((c) => (
              <button
                key={c}
                type="button"
                className="tt-chip"
                aria-pressed={color === c}
                aria-label={c}
                title={c}
                onClick={() => setColor(c)}
                style={{
                  textTransform: 'capitalize',
                  outline: color === c ? '1.5px solid var(--ink)' : undefined,
                }}
              >
                <span
                  className="dot"
                  aria-hidden
                  style={{ background: ACCENT_HEX[c] }}
                />
                {c}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="pl-card" style={{ padding: 18, display: 'grid', gap: 16, maxWidth: 560, marginTop: 24 }}>
        <div style={{ display: 'grid', gap: 4 }}>
          <div className="eyebrow">Tabs</div>
          <div className="sub" style={{ fontSize: 12, color: 'var(--ink-dim)' }}>
            Tab order applies to this device.
          </div>
        </div>
        <div style={{ display: 'grid', gap: 6 }}>
          {orderedNav.map((n, i) => (
            <div
              key={n.to}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '8px 10px',
                border: '1.5px solid var(--line)',
                background: 'var(--surface)',
              }}
            >
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 12,
                  fontWeight: 700,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  color: 'var(--ink)',
                }}
              >
                {n.label}
              </span>
              <div className="seg" role="group">
                <button
                  type="button"
                  disabled={i === 0}
                  aria-label={`Move ${n.label} up`}
                  onClick={() => moveTab(i, -1)}
                >
                  ▲
                </button>
                <button
                  type="button"
                  disabled={i === orderedNav.length - 1}
                  aria-label={`Move ${n.label} down`}
                  onClick={() => moveTab(i, 1)}
                >
                  ▼
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}

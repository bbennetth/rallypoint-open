import { useEffect, useState } from 'react'
import { ACCENT_HEX, COLORS_ORDER, useThemeStore, type Theme } from '@rallypoint/ui'
import { NAV } from '../ui/nav.js'
import { useTabOrder, setTabOrder, orderNav } from '../lib/tab-order.js'
import {
  getSettings,
  updateSettings,
  sendTestPush,
  SHOW_CHORES_IN_FEEDS_KEY,
  WEATHER_UNIT_KEY,
  PUSH_NOTIFICATIONS_KEY,
} from '../lib/api.js'
import { enablePush, disablePush, pushSupported } from '../lib/push.js'
import { choresInFeedsEnabled } from '../lib/chores-helpers.js'
import { weatherUnitFromSettings, type WeatherUnit } from '../lib/weather-helpers.js'
import { holidaysEnabled, hiddenHolidays as readHiddenHolidays } from '../lib/holidays-helpers.js'
import { getHolidayDefs } from '@rallypoint/events-shared'

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

  // Shopping auto-categorize setting. Loaded from the 'planner' namespace on
  // mount; persisted back as { shoppingAutoCategorize: <bool> } on toggle.
  // Defaults to true (on) while loading or when the key is absent.
  const [autoCategorize, setAutoCategorize] = useState<boolean>(true)
  // Chores-in-feeds setting (#546). Absent → true (chores show in My Day &
  // Upcoming by default); persisted as { showChoresInFeeds: <bool> } on toggle.
  const [showChoresInFeeds, setShowChoresInFeeds] = useState<boolean>(true)
  // Holidays settings (#548). holidaysOn = master toggle; hiddenIds = per-holiday hide list.
  const [holidaysOn, setHolidaysOn] = useState<boolean>(true)
  const [hiddenIds, setHiddenIds] = useState<string[]>([])
  // My Day weather temperature unit. Absent → 'fahrenheit' (default).
  const [weatherUnit, setWeatherUnit] = useState<WeatherUnit>('fahrenheit')
  // Push notifications (planner-owned). Absent → false (opt-in). pushStatus
  // surfaces a hint when the browser blocks or can't do Web Push.
  const [notificationsOn, setNotificationsOn] = useState<boolean>(false)
  const [pushStatus, setPushStatus] = useState<string | null>(null)
  // "Send a test notification" action state.
  const [testBusy, setTestBusy] = useState(false)
  const [testStatus, setTestStatus] = useState<string | null>(null)
  const [settingsLoading, setSettingsLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    void getSettings('planner').then((s) => {
      if (cancelled) return
      // If the key is missing (new user) keep the default (true = on).
      if (s.shoppingAutoCategorize === false) setAutoCategorize(false)
      setShowChoresInFeeds(choresInFeedsEnabled(s))
      setHolidaysOn(holidaysEnabled(s))
      setHiddenIds(readHiddenHolidays(s))
      setWeatherUnit(weatherUnitFromSettings(s))
      setNotificationsOn(s[PUSH_NOTIFICATIONS_KEY] === true)
      setSettingsLoading(false)
    }).catch(() => {
      if (!cancelled) setSettingsLoading(false)
    })
    return () => { cancelled = true }
  }, [])

  function onToggleAutoCategorize() {
    const next = !autoCategorize
    setAutoCategorize(next)
    void updateSettings('planner', { shoppingAutoCategorize: next })
  }

  function onToggleChoresInFeeds() {
    const next = !showChoresInFeeds
    setShowChoresInFeeds(next)
    void updateSettings('planner', { [SHOW_CHORES_IN_FEEDS_KEY]: next })
  }

  function onToggleHolidays() {
    const next = !holidaysOn
    setHolidaysOn(next)
    void updateSettings('planner', { holidaysEnabled: next })
  }

  async function onToggleNotifications() {
    if (!notificationsOn) {
      const result = await enablePush()
      if (result === 'subscribed') {
        setNotificationsOn(true)
        setPushStatus(null)
        void updateSettings('planner', { [PUSH_NOTIFICATIONS_KEY]: true })
      } else if (result === 'denied') {
        setPushStatus('Notifications are blocked — enable them in your browser settings, then try again.')
      } else {
        setPushStatus('Push notifications aren’t supported on this device or browser.')
      }
    } else {
      setNotificationsOn(false)
      setPushStatus(null)
      setTestStatus(null)
      await disablePush()
      void updateSettings('planner', { [PUSH_NOTIFICATIONS_KEY]: false })
    }
  }

  async function onSendTestNotification() {
    setTestBusy(true)
    setTestStatus(null)
    try {
      const result = await sendTestPush()
      if (result.subscriptions === 0) {
        setTestStatus('No devices registered yet — turn notifications on first.')
      } else if (result.sent > 0) {
        setTestStatus(`Sent to ${result.sent} device${result.sent === 1 ? '' : 's'} — check for the notification.`)
      } else {
        setTestStatus('Couldn’t reach any device. Try turning notifications off and on again.')
      }
    } catch {
      setTestStatus('Test failed — please try again.')
    } finally {
      setTestBusy(false)
    }
  }

  function onSetWeatherUnit(next: WeatherUnit) {
    if (next === weatherUnit) return
    setWeatherUnit(next)
    void updateSettings('planner', { [WEATHER_UNIT_KEY]: next })
  }

  function onRestoreHoliday(id: string) {
    const next = hiddenIds.filter((x) => x !== id)
    setHiddenIds(next)
    void updateSettings('planner', { hiddenHolidays: next })
  }

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
          <div className="eyebrow">Shopping</div>
        </div>
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            cursor: settingsLoading ? 'default' : 'pointer',
            gap: 12,
          }}
        >
          <span style={{ display: 'grid', gap: 2 }}>
            <span style={{ fontSize: 14, color: 'var(--ink)' }}>Auto-categorize items</span>
            <span style={{ fontSize: 12, color: 'var(--ink-dim)' }}>
              Automatically assign a category (Produce, Dairy, etc.) when you add an item.
            </span>
          </span>
          <input
            type="checkbox"
            role="switch"
            aria-label="Auto-categorize shopping items"
            checked={autoCategorize}
            disabled={settingsLoading}
            onChange={onToggleAutoCategorize}
            style={{ width: 18, height: 18, cursor: 'pointer', accentColor: 'var(--accent)' }}
          />
        </label>
      </div>

      <div className="pl-card" style={{ padding: 18, display: 'grid', gap: 16, maxWidth: 560, marginTop: 24 }}>
        <div style={{ display: 'grid', gap: 4 }}>
          <div className="eyebrow">Chores</div>
        </div>
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            cursor: settingsLoading ? 'default' : 'pointer',
            gap: 12,
          }}
        >
          <span style={{ display: 'grid', gap: 2 }}>
            <span style={{ fontSize: 14, color: 'var(--ink)' }}>Show chores in My Day &amp; Upcoming</span>
            <span style={{ fontSize: 12, color: 'var(--ink-dim)' }}>
              When on, due chores appear alongside your tasks in the My Day and Upcoming feeds.
            </span>
          </span>
          <input
            type="checkbox"
            role="switch"
            aria-label="Show chores in My Day and Upcoming"
            checked={showChoresInFeeds}
            disabled={settingsLoading}
            onChange={onToggleChoresInFeeds}
            style={{ width: 18, height: 18, cursor: 'pointer', accentColor: 'var(--accent)' }}
          />
        </label>
      </div>

      {/* Notifications card */}
      <div className="pl-card" style={{ padding: 18, display: 'grid', gap: 16, maxWidth: 560, marginTop: 24 }}>
        <div style={{ display: 'grid', gap: 4 }}>
          <div className="eyebrow">Notifications</div>
        </div>
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            cursor: settingsLoading || !pushSupported() ? 'default' : 'pointer',
            gap: 12,
          }}
        >
          <span style={{ display: 'grid', gap: 2 }}>
            <span style={{ fontSize: 14, color: 'var(--ink)' }}>Push notifications</span>
            <span style={{ fontSize: 12, color: 'var(--ink-dim)' }}>
              Get a reminder at the due time for events, tasks &amp; chores that have a date and time.
              All-day items don’t notify.
            </span>
          </span>
          <input
            type="checkbox"
            role="switch"
            aria-label="Enable push notifications"
            checked={notificationsOn}
            disabled={settingsLoading || !pushSupported()}
            onChange={() => {
              void onToggleNotifications()
            }}
            style={{ width: 18, height: 18, cursor: 'pointer', accentColor: 'var(--accent)' }}
          />
        </label>
        {pushStatus && (
          <span style={{ fontSize: 12, color: 'var(--ink-dim)' }}>{pushStatus}</span>
        )}
        {notificationsOn && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="pl-btn ghost sm"
              disabled={testBusy}
              onClick={() => {
                void onSendTestNotification()
              }}
            >
              {testBusy ? 'Sending…' : 'Send a test notification'}
            </button>
            {testStatus && (
              <span style={{ fontSize: 12, color: 'var(--ink-dim)' }}>{testStatus}</span>
            )}
          </div>
        )}
      </div>

      {/* Weather card */}
      <div className="pl-card" style={{ padding: 18, display: 'grid', gap: 16, maxWidth: 560, marginTop: 24 }}>
        <div className="eyebrow">Weather</div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <span style={{ display: 'grid', gap: 2 }}>
            <span style={{ fontSize: 14, color: 'var(--ink)' }}>Temperature unit</span>
            <span style={{ fontSize: 12, color: 'var(--ink-dim)' }}>
              Used for the weather shown on My Day.
            </span>
          </span>
          <div className="seg" role="group" aria-label="Temperature unit">
            <button
              type="button"
              className={weatherUnit === 'fahrenheit' ? 'on' : ''}
              aria-pressed={weatherUnit === 'fahrenheit'}
              disabled={settingsLoading}
              onClick={() => onSetWeatherUnit('fahrenheit')}
            >
              °F
            </button>
            <button
              type="button"
              className={weatherUnit === 'celsius' ? 'on' : ''}
              aria-pressed={weatherUnit === 'celsius'}
              disabled={settingsLoading}
              onClick={() => onSetWeatherUnit('celsius')}
            >
              °C
            </button>
          </div>
        </div>
      </div>

      {/* Holidays card (#548) */}
      <div className="pl-card" style={{ padding: 18, display: 'grid', gap: 16, maxWidth: 560, marginTop: 24 }}>
        <div style={{ display: 'grid', gap: 4 }}>
          <div className="eyebrow">Holidays</div>
        </div>
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            cursor: settingsLoading ? 'default' : 'pointer',
            gap: 12,
          }}
        >
          <span style={{ display: 'grid', gap: 2 }}>
            <span style={{ fontSize: 14, color: 'var(--ink)' }}>Show US federal holidays</span>
            <span style={{ fontSize: 12, color: 'var(--ink-dim)' }}>
              When on, US federal holidays appear in the Events calendar and list view.
            </span>
          </span>
          <input
            type="checkbox"
            role="switch"
            aria-label="Show US federal holidays"
            checked={holidaysOn}
            disabled={settingsLoading}
            onChange={onToggleHolidays}
            style={{ width: 18, height: 18, cursor: 'pointer', accentColor: 'var(--accent)' }}
          />
        </label>
        {hiddenIds.length > 0 && (
          <div style={{ display: 'grid', gap: 6 }}>
            <div style={{ fontSize: 12, color: 'var(--ink-dim)' }}>Hidden holidays — click Restore to show again:</div>
            {hiddenIds.map((id) => {
              const def = getHolidayDefs().find((d) => d.id === id)
              if (!def) return null
              return (
                <div
                  key={id}
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13, color: 'var(--ink-dim)' }}
                >
                  <span>{def.name}</span>
                  <button
                    type="button"
                    className="pl-btn ghost sm"
                    onClick={() => onRestoreHoliday(id)}
                  >
                    Restore
                  </button>
                </div>
              )
            })}
          </div>
        )}
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

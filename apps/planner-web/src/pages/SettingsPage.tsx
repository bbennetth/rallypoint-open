import { useEffect, useMemo, useRef, useState } from 'react'
import { ACCENT_HEX, COLORS_ORDER, useThemeStore, type Theme } from '@rallypoint/ui'
import { NAV } from '../ui/nav.js'
import { useTabOrder, setTabOrder, orderNav } from '../lib/tab-order.js'
import {
  settingsQuery,
  updateSettings,
  sendTestPush,
  SHOW_CHORES_IN_FEEDS_KEY,
  WEATHER_UNIT_KEY,
  PUSH_NOTIFICATIONS_KEY,
} from '../lib/api.js'
import { useCachedQuery } from '../lib/offline/use-cached-query.js'
import { enablePush, disablePush, pushSupported, testPushStatusMessage } from '../lib/push.js'
import { choresInFeedsEnabled } from '../lib/chores-helpers.js'
import { weatherUnitFromSettings, type WeatherUnit } from '../lib/weather-helpers.js'
import { holidaysEnabled, hiddenHolidays as readHiddenHolidays } from '../lib/holidays-helpers.js'
import { getHolidayDefs } from '@rallypoint/events-shared'
import { QuickAdd } from '../ui/QuickAdd.js'
import { ApiError, exportPlannerData, importPlannerData } from '../lib/api.js'
import { exportFileName, formatImportSummary } from '../lib/import-summary-text.js'

// Settings surface — the first dedicated settings page. Theme (mode + accent)
// is the first user setting; changes drive the shared store actions, which the
// bootstrap persister (main.tsx) write-throughs into the RPID `shared` bag, so
// the choice follows the user across apps + devices. More sections land here as
// settings grow.

const MODE_OPTIONS: ReadonlyArray<{ value: Theme; label: string }> = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

/**
 * Ink kit's pill toggle (`.set-toggle` + `.knob`). Replaces the native
 * `<input type="checkbox" role="switch">` used previously — same
 * semantics (a labelled `aria-pressed` toggle), kit visual.
 */
function SetToggle({
  on,
  onChange,
  disabled,
  label,
}: {
  on: boolean
  onChange: () => void
  disabled?: boolean
  label: string
}) {
  return (
    <button
      type="button"
      className={'set-toggle' + (on ? ' on' : '')}
      aria-pressed={on}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
    >
      <span className="knob" aria-hidden />
    </button>
  )
}

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
  // Export/import (backup–restore) status line, shared by both buttons.
  const [dataStatus, setDataStatus] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [importing, setImporting] = useState(false)
  const importInput = useRef<HTMLInputElement>(null)

  async function runExport() {
    setExporting(true)
    setDataStatus(null)
    try {
      const blob = await exportPlannerData()
      // Object-URL download: the export is session-gated, so it cannot be a
      // plain <a href> the browser fetches without credentials.
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = exportFileName(new Date())
      a.click()
      URL.revokeObjectURL(url)
      setDataStatus('Your data has been downloaded.')
    } catch (err) {
      setDataStatus(err instanceof ApiError ? err.message : 'Export failed — try again.')
    } finally {
      setExporting(false)
    }
  }

  async function runImport(file: File) {
    setImporting(true)
    setDataStatus(null)
    try {
      setDataStatus(formatImportSummary(await importPlannerData(file)))
    } catch (err) {
      setDataStatus(err instanceof ApiError ? err.message : 'Import failed — try again.')
    } finally {
      setImporting(false)
    }
  }
  // "Send a test notification" action state.
  const [testBusy, setTestBusy] = useState(false)
  const [testStatus, setTestStatus] = useState<string | null>(null)

  // Render-from-cache: read-only settings load (mutations below still write
  // straight through updateSettings + local optimistic state, unchanged).
  const settingsQ = useCachedQuery(useMemo(() => settingsQuery('planner'), []))
  const settingsLoading = settingsQ.status === 'loading'

  useEffect(() => {
    const s = settingsQ.data
    if (!s) return
    // If the key is missing (new user) keep the default (true = on).
    setAutoCategorize(s.shoppingAutoCategorize !== false)
    setShowChoresInFeeds(choresInFeedsEnabled(s))
    setHolidaysOn(holidaysEnabled(s))
    setHiddenIds(readHiddenHolidays(s))
    setWeatherUnit(weatherUnitFromSettings(s))
    setNotificationsOn(s[PUSH_NOTIFICATIONS_KEY] === true)
  }, [settingsQ.data])

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
      setTestStatus(testPushStatusMessage(result))
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
    // Bounds already checked above, so both indices are in range.
    ;[next[index], next[swap]] = [next[swap]!, next[index]!]
    setTabOrder(next.map((n) => n.to))
  }

  return (
    <>
      <div className="pg-head">
        <div>
          <div className="eyebrow">Planner</div>
          <h1>Settings</h1>
          <div className="sub">Saved to your account — it follows you across Rallypoint apps and devices.</div>
        </div>
      </div>

      <h2 className="eyebrow" style={{ margin: '18px 0 10px', fontWeight: 400 }}>Appearance</h2>
      <div className="set-section" style={{ maxWidth: 560 }}>
        <div className="set-row">
          <div>
            <div className="set-label">Theme</div>
            <div className="set-sub">Dark is the Ink default.</div>
          </div>
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

        <div className="set-row">
          <div>
            <div className="set-label">Accent</div>
            <div className="set-sub">Re-tints the whole app from one variable.</div>
          </div>
          {/* Kit's accent picker: six color circles. Replaces the prior
              `.tt-chip` text buttons; the selected swatch carries an --ink
              border ring. */}
          <div className="swatch-row" role="group" aria-label="Accent color">
            {COLORS_ORDER.map((c) => (
              <button
                key={c}
                type="button"
                className={'swatch' + (color === c ? ' on' : '')}
                aria-pressed={color === c}
                aria-label={c}
                title={c}
                onClick={() => setColor(c)}
                style={{ background: ACCENT_HEX[c] }}
              />
            ))}
          </div>
        </div>
      </div>

      <h2 className="eyebrow" style={{ margin: '24px 0 10px', fontWeight: 400 }}>Preferences</h2>
      <div className="set-section" style={{ maxWidth: 560 }}>
        <div className="set-row">
          <div>
            <div className="set-label">Auto-categorize shopping items</div>
            <div className="set-sub">
              Automatically assign a category (Produce, Dairy, etc.) when you add an item.
            </div>
          </div>
          <SetToggle
            on={autoCategorize}
            disabled={settingsLoading}
            onChange={onToggleAutoCategorize}
            label="Auto-categorize shopping items"
          />
        </div>

        <div className="set-row">
          <div>
            <div className="set-label">Show chores in Upcoming &amp; calendar</div>
            <div className="set-sub">
              When on, recurring chores appear in the Coming up feed and the Week / Month
              views. Today’s chores always show in their dedicated My Day section.
            </div>
          </div>
          <SetToggle
            on={showChoresInFeeds}
            disabled={settingsLoading}
            onChange={onToggleChoresInFeeds}
            label="Show chores in Upcoming and calendar"
          />
        </div>

        <div className="set-row">
          <div>
            <div className="set-label">Push notifications</div>
            <div className="set-sub">
              Get a reminder at the due time for events, tasks &amp; chores that
              have a date and time. All-day items don’t notify.
            </div>
          </div>
          <SetToggle
            on={notificationsOn}
            disabled={settingsLoading || !pushSupported()}
            onChange={() => {
              void onToggleNotifications()
            }}
            label="Enable push notifications"
          />
        </div>
        {pushStatus && (
          <div className="set-sub" style={{ paddingTop: 10 }}>{pushStatus}</div>
        )}
        {notificationsOn && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              flexWrap: 'wrap',
              paddingTop: 10,
              borderTop: '1px solid var(--line)',
              marginTop: 6,
            }}
          >
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

      <div className="set-section" style={{ maxWidth: 560 }}>
        <div className="set-row">
          <div>
            <div className="set-label">Temperature unit</div>
            <div className="set-sub">Used for the weather shown on My Day.</div>
          </div>
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

        <div className="set-row">
          <div>
            <div className="set-label">Show US federal holidays</div>
            <div className="set-sub">
              When on, US federal holidays appear in the Events calendar and list view.
            </div>
          </div>
          <SetToggle
            on={holidaysOn}
            disabled={settingsLoading}
            onChange={onToggleHolidays}
            label="Show US federal holidays"
          />
        </div>
        {hiddenIds.length > 0 && (
          <div
            style={{
              display: 'grid',
              gap: 6,
              paddingTop: 10,
              borderTop: '1px solid var(--line)',
              marginTop: 6,
            }}
          >
            <div className="set-sub">
              Hidden holidays — click Restore to show again:
            </div>
            {hiddenIds.map((id) => {
              const def = getHolidayDefs().find((d) => d.id === id)
              if (!def) return null
              return (
                <div
                  key={id}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    fontSize: 13,
                    color: 'var(--ink-dim)',
                  }}
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

      {/* Tab order — planner-web addition not in the kit's Settings spec.
          Kept as its own .set-section because the per-tab rows aren't a
          natural fit for the .set-row label/sub/control pattern. */}
      <div className="set-section" style={{ maxWidth: 560 }}>
        <div style={{ display: 'grid', gap: 4, marginBottom: 12 }}>
          <div className="set-label">Tabs</div>
          <div className="set-sub">Tab order applies to this device.</div>
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
                border: 'var(--border-width) solid var(--line)',
                background: 'var(--bg)',
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
      <h2 className="eyebrow" style={{ margin: '24px 0 10px', fontWeight: 400 }}>Your data</h2>
      <div className="set-section" style={{ maxWidth: 560 }}>
        <div className="set-row">
          <div>
            <div className="set-label">Export</div>
            <div className="set-sub">
              Downloads your tasks, lists, notes, chores and events — with any ticket attachments —
              as a single ZIP you can keep as a backup.
            </div>
          </div>
          <button
            type="button"
            className="btn-ghost"
            style={{ whiteSpace: 'nowrap' }}
            disabled={exporting}
            onClick={() => void runExport()}
          >
            {exporting ? 'Preparing…' : 'Export data'}
          </button>
        </div>

        <div className="set-row">
          <div>
            <div className="set-label">Import</div>
            <div className="set-sub">
              Restores a ZIP exported from Planner into this account. Anything already here is kept,
              and importing the same file twice is safe — it will not duplicate.
            </div>
          </div>
          <div style={{ display: 'grid', gap: 6, justifyItems: 'end' }}>
            <input
              ref={importInput}
              type="file"
              accept=".zip,application/zip"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0]
                // Clear the input so re-picking the SAME file fires change again.
                e.target.value = ''
                if (file) void runImport(file)
              }}
            />
            <button
              type="button"
              className="btn-ghost"
              style={{ whiteSpace: 'nowrap' }}
              disabled={importing}
              onClick={() => importInput.current?.click()}
            >
              {importing ? 'Importing…' : 'Import data'}
            </button>
          </div>
        </div>

        {dataStatus && (
          <div className="set-row">
            <div className="set-sub" role="status" style={{ whiteSpace: 'pre-line' }}>
              {dataStatus}
            </div>
          </div>
        )}
      </div>

      <QuickAdd anchor="float" />
    </>
  )
}

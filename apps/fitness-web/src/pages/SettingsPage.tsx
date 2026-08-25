import { useEffect, useRef, useState } from 'react'
import { ACCENT_HEX, COLORS_ORDER, useThemeStore, type Theme } from '@rallypoint/ui'
import { formatMmss, parseMmss } from '@rallypoint/fitness-shared'
import { useWeightUnitStore, type WeightUnit } from '../lib/units.js'
import { setDefaultRestS, useDefaultRestS } from '../lib/rest-settings.js'
import {
  DEFAULT_REPS,
  setDefaultReps,
  setDefaultSets,
  useDefaultReps,
  useDefaultSets,
} from '../lib/set-defaults.js'
import { setRestAlertsMode, useRestAlertsMode } from '../lib/alert-settings.js'
import {
  ensureRestPushSubscription,
  pushSupported,
  restPushStatusMessage,
  testPushStatusMessage,
} from '../lib/rest-push.js'
import { ApiError, exportHealthData, importHealthData, sendTestPush } from '../lib/api.js'
import { exportFileName, formatImportSummary } from '../lib/import-summary-text.js'
import { MmssInput } from '../ui/MmssInput.js'
import { NumericField } from '../ui/NumericField.js'

// Fitness settings surface, mirroring planner-web's SettingsPage. The rows
// previously lived in the app-switcher flyout (AppChrome extraMenuRows);
// they moved here so the flyout stays a short app list + shortcuts. All
// state hooks are unchanged — theme writes through to the RPID `shared`
// bag, units/rest/alerts to the `fitness` bag via the main.tsx persisters.

const MODE_OPTIONS: ReadonlyArray<{ value: Theme; label: string }> = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

const UNIT_OPTIONS: readonly WeightUnit[] = ['lb', 'kg']

export function SettingsPage() {
  const mode = useThemeStore((s) => s.mode)
  const color = useThemeStore((s) => s.color)
  const setMode = useThemeStore((s) => s.setMode)
  const setColor = useThemeStore((s) => s.setColor)

  const unit = useWeightUnitStore((s) => s.unit)
  const setUnit = useWeightUnitStore((s) => s.setUnit)
  const restS = useDefaultRestS()
  const defaultSets = useDefaultSets()
  const defaultReps = useDefaultReps()
  const alertsMode = useRestAlertsMode()

  const notifySupported = typeof Notification !== 'undefined'
  // Status line under the rest-alerts row (subscribe / test-push outcome).
  const [pushStatus, setPushStatusState] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  // Export/import (backup–restore) status line, shared by both buttons.
  const [dataStatus, setDataStatus] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [importing, setImporting] = useState(false)
  const importInput = useRef<HTMLInputElement>(null)
  // Both flows await network/system prompts; drop late results if the
  // page unmounted meanwhile.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const setPushStatus = (msg: string | null) => {
    if (mounted.current) setPushStatusState(msg)
  }

  async function pickAlerts(next: 'off' | 'sound' | 'notify') {
    setPushStatus(null)
    if (next === 'notify') {
      // No Notification API (some webviews, non-installed iOS Safari):
      // 'notify' could never fire, so fall back to sound instead of
      // persisting a mode that silently under-delivers.
      if (!notifySupported) {
        setRestAlertsMode('sound')
        return
      }
      // Must run inside the tap gesture. Denied → fall back to sound.
      const perm = await Notification.requestPermission()
      if (perm !== 'granted') {
        setRestAlertsMode('sound')
        return
      }
      // Create the Web Push subscription HERE, still inside the tap's
      // activation — WebKit rejects pushManager.subscribe() outside a
      // user gesture, which is why arming it lazily from the live
      // session never worked on iOS. Failure keeps 'notify' (the local
      // SW alert still covers a backgrounded-but-alive tab) but is
      // surfaced instead of swallowed.
      const subscribed = pushSupported() ? await ensureRestPushSubscription() : false
      setPushStatus(restPushStatusMessage(subscribed, pushSupported()))
    }
    setRestAlertsMode(next)
  }

  async function runExport() {
    setExporting(true)
    setDataStatus(null)
    try {
      const blob = await exportHealthData()
      // Object-URL download: the export is session-gated, so it cannot be a
      // plain <a href> the browser fetches without credentials.
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = exportFileName(new Date())
      a.click()
      URL.revokeObjectURL(url)
      if (mounted.current) setDataStatus('Your data has been downloaded.')
    } catch (err) {
      if (mounted.current) {
        setDataStatus(err instanceof ApiError ? err.message : 'Export failed — try again.')
      }
    } finally {
      if (mounted.current) setExporting(false)
    }
  }

  async function runImport(file: File) {
    setImporting(true)
    setDataStatus(null)
    try {
      const summary = await importHealthData(file)
      if (mounted.current) setDataStatus(formatImportSummary(summary))
    } catch (err) {
      if (mounted.current) {
        setDataStatus(err instanceof ApiError ? err.message : 'Import failed — try again.')
      }
    } finally {
      if (mounted.current) setImporting(false)
    }
  }

  async function testPush() {
    setTesting(true)
    try {
      setPushStatus(testPushStatusMessage(await sendTestPush()))
    } catch {
      setPushStatus('Test failed — check your connection and try again.')
    } finally {
      if (mounted.current) setTesting(false)
    }
  }

  return (
    <>
      <div className="pg-head">
        <div>
          <div className="eyebrow">Health</div>
          <h1>Settings</h1>
          <div className="sub">Saved to your account — it follows you across Rallypoint apps and devices.</div>
        </div>
      </div>

      <h2 className="eyebrow" style={{ margin: '18px 0 10px', fontWeight: 400 }}>Appearance</h2>
      <div className="pref-section" style={{ maxWidth: 560 }}>
        <div className="pref-row">
          <div>
            <div className="pref-label">Theme</div>
            <div className="pref-sub">Dark is the Ink default.</div>
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

        <div className="pref-row">
          <div>
            <div className="pref-label">Accent</div>
            <div className="pref-sub">Re-tints the whole app from one variable.</div>
          </div>
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

      <h2 className="eyebrow" style={{ margin: '24px 0 10px', fontWeight: 400 }}>Training</h2>
      <div className="pref-section" style={{ maxWidth: 560 }}>
        <div className="pref-row">
          <div>
            <div className="pref-label">Weight units</div>
            <div className="pref-sub">Used for logging, plans and stats everywhere in Health.</div>
          </div>
          <div className="seg" role="group" aria-label="Weight units">
            {UNIT_OPTIONS.map((u) => (
              <button
                key={u}
                type="button"
                aria-pressed={unit === u}
                className={unit === u ? 'on' : ''}
                onClick={() => setUnit(u)}
              >
                {u.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        <div className="pref-row">
          <div>
            <div className="pref-label">Default sets × reps</div>
            <div className="pref-sub">
              Starting prescription for exercises added to a strength workout. Cardio and timed
              work still starts as one continuous entry.
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <NumericField
              value={defaultSets}
              min={1}
              max={20}
              // allowEmpty makes blank/garbage commit null, which is
              // ignored — the field resyncs to the previous value instead
              // of clobbering it with the 1-set clamp floor. Same
              // no-silent-reset rule as Default rest below.
              allowEmpty
              onCommit={(v) => {
                if (v != null) setDefaultSets(v)
              }}
              aria-label="Default sets"
              style={{ width: 56, textAlign: 'center' }}
            />
            <span style={{ color: 'var(--ink-mute)' }}>×</span>
            {defaultReps === 'max' ? (
              <span style={{ color: 'var(--ink-mute)' }}>max reps</span>
            ) : (
              <NumericField
                value={defaultReps}
                min={1}
                max={999}
                allowEmpty
                onCommit={(v) => {
                  if (v != null) setDefaultReps(v)
                }}
                aria-label="Default reps"
                style={{ width: 56, textAlign: 'center' }}
              />
            )}
            {/* Same MAX chip as the composer / add-exercise sheet:
                max-effort sets, achieved count entered while lifting. */}
            <button
              type="button"
              className={`pl-chip${defaultReps === 'max' ? ' pl-chip-active' : ''}`}
              style={{ cursor: 'pointer', flex: 'none' }}
              aria-pressed={defaultReps === 'max'}
              title="Max-effort sets — as many reps as possible"
              onClick={() =>
                // Toggling MAX off lands on the product-default count —
                // the store holds one value, so the pre-MAX number is
                // gone by design (same across reloads).
                setDefaultReps(defaultReps === 'max' ? DEFAULT_REPS : 'max')
              }
            >
              MAX
            </button>
          </div>
        </div>

        <div className="pref-row">
          <div>
            <div className="pref-label">Default rest</div>
            <div className="pref-sub">
              Rest between strength sets when a workout doesn’t prescribe one (mm:ss, up to 10:00).
            </div>
          </div>
          <MmssInput
            value={formatMmss(restS)}
            onCommit={(v) => {
              // Blank/garbage keeps the previous value (the field resyncs
              // to it) — silently resetting to the 90s default AND
              // persisting it would discard the user's chosen setting.
              const parsed = parseMmss(v)
              if (parsed != null) setDefaultRestS(parsed)
            }}
            maxS={600}
            aria-label="Default rest between sets (mm:ss)"
            style={{ width: 76 }}
          />
        </div>

        <div className="pref-row">
          <div>
            <div className="pref-label">Rest alerts</div>
            <div className="pref-sub">
              Sound plays 5-4-3-2-1 beeps + a go tone. +Notify adds a notification when rest ends
              with the app in the background — on iOS it needs the installed app, 16.4 or later.
            </div>
          </div>
          <div style={{ display: 'grid', gap: 6, justifyItems: 'end' }}>
            <div className="seg" role="group" aria-label="Rest timer alerts">
              {(
                [
                  { key: 'off', label: 'Off' },
                  { key: 'sound', label: 'Sound' },
                  { key: 'notify', label: '+Notify' },
                ] as const
              ).map((o) => (
                <button
                  key={o.key}
                  type="button"
                  aria-pressed={alertsMode === o.key}
                  className={alertsMode === o.key ? 'on' : ''}
                  disabled={o.key === 'notify' && !notifySupported}
                  title={
                    o.key === 'notify' && !notifySupported
                      ? 'Notifications are not supported in this browser'
                      : undefined
                  }
                  onClick={() => void pickAlerts(o.key)}
                >
                  {o.label}
                </button>
              ))}
            </div>
            {alertsMode === 'notify' && (
              <button
                type="button"
                className="btn-ghost"
                disabled={testing}
                onClick={() => void testPush()}
              >
                {testing ? 'Sending…' : 'Send test notification'}
              </button>
            )}
            {pushStatus && (
              <div className="pref-sub" role="status" style={{ textAlign: 'right', maxWidth: 260 }}>
                {pushStatus}
              </div>
            )}
          </div>
        </div>
      </div>

      <h2 className="eyebrow" style={{ margin: '24px 0 10px', fontWeight: 400 }}>Your data</h2>
      <div className="pref-section" style={{ maxWidth: 560 }}>
        <div className="pref-row">
          <div>
            <div className="pref-label">Export</div>
            <div className="pref-sub">
              Downloads everything in your account — workouts, food diary, recipes, plans and
              progress photos — as a single ZIP you can keep as a backup.
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

        <div className="pref-row">
          <div>
            <div className="pref-label">Import</div>
            <div className="pref-sub">
              Restores a ZIP exported from Health into this account. Anything already here is kept,
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
          <div className="pref-row">
            <div className="pref-sub" role="status" style={{ whiteSpace: 'pre-line' }}>
              {dataStatus}
            </div>
          </div>
        )}
      </div>
    </>
  )
}

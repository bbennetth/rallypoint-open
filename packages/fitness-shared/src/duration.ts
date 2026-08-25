// mm:ss parse/format helpers for rest-time inputs. The builder used to
// take raw seconds ("90"); the mm:ss field keeps that muscle memory —
// bare digits still parse as seconds — while accepting "1:30" / ":45".

/** 90 → "1:30", 0 → "0:00", 605 → "10:05". Negative/non-finite clamp
 *  to zero. */
export function formatMmss(s: number): string {
  const sec = Number.isFinite(s) ? Math.max(0, Math.round(s)) : 0
  const m = Math.floor(sec / 60)
  const ss = sec % 60
  return `${m}:${String(ss).padStart(2, '0')}`
}

/** Parse a rest-time string into whole seconds.
 *  - "1:30" → 90, ":45" → 45, "2:5" → 125
 *  - bare digits are SECONDS ("90" → 90) — matches the old raw field,
 *    which also accepted decimals ("45.5" → 46, rounded) — silently
 *    rejecting those would discard a value the user meaningfully typed
 *  - null for anything else (empty, negative, garbage). Callers clamp
 *    to their own ceiling. */
export function parseMmss(raw: string): number | null {
  const t = raw.trim()
  if (!t) return null
  const colon = /^(\d*):(\d{1,2})$/.exec(t)
  if (colon) {
    const m = colon[1] === '' ? 0 : Number(colon[1])
    const s = Number(colon[2])
    if (!Number.isFinite(m) || !Number.isFinite(s) || s >= 60) return null
    return m * 60 + s
  }
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t))
  return null
}

// Microwave-style digit-buffer helpers for the live mm:ss input. The
// buffer is a plain digit string that fills positionally from the right
// (type 1 → 0:01, 10 → 0:10, 100 → 1:00). While typing, the display is
// raw positional — "90" shows 0:90, not 1:30 — so every keystroke stays
// reversible; overflow seconds normalize on commit (0:90 → 90s → 1:30).

/** Normalize free text into a microwave digit buffer: strip non-digits,
 *  strip leading zeros, keep the last 4 digits. "1:30" → "130",
 *  "0:09" → "9", "12345" → "2345", "abc"/"0:00" → "". All-zero input
 *  collapses to "" on purpose — this runs on every keystroke, and a
 *  sticky "0" would make backspace unable to clear the field (use
 *  mmssSeedDigits when hydrating from a committed value instead). */
export function mmssTextToDigits(text: string): string {
  return text.replace(/\D/g, '').replace(/^0+/, '').slice(-4)
}

/** Seed a digit buffer from a COMMITTED value on focus. Same as
 *  mmssTextToDigits, except an explicit zero value ("0:00", "0") seeds
 *  "0" rather than "" so a no-edit focus/blur round-trip re-commits the
 *  zero instead of erasing it. */
export function mmssSeedDigits(text: string): string {
  const d = mmssTextToDigits(text)
  return d === '' && /\d/.test(text) ? '0' : d
}

/** Positional display of a digit buffer. "" → "", "1" → "0:01",
 *  "10" → "0:10", "100" → "1:00", "1000" → "10:00". Raw — "90" → "0:90"
 *  (normalization happens at commit, not while typing). */
export function mmssDigitsToDisplay(digits: string): string {
  if (!digits) return ''
  const ss = digits.slice(-2).padStart(2, '0')
  const mm = digits.slice(0, -2) || '0'
  return `${mm}:${ss}`
}

/** Positional seconds of a digit buffer: mm = all but the last two
 *  digits, ss = last two. "" → null, "1" → 1, "90" → 90, "130" → 90,
 *  "1000" → 600, "9999" → 99*60+99 = 6039. */
export function mmssDigitsToSeconds(digits: string): number | null {
  if (!digits) return null
  const ss = Number(digits.slice(-2))
  const mm = digits.length > 2 ? Number(digits.slice(0, -2)) : 0
  return mm * 60 + ss
}

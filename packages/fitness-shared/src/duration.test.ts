import { describe, it, expect } from 'vitest'
import {
  formatMmss,
  parseMmss,
  mmssTextToDigits,
  mmssSeedDigits,
  mmssDigitsToDisplay,
  mmssDigitsToSeconds,
} from './duration.js'

describe('formatMmss', () => {
  it('formats seconds as m:ss', () => {
    expect(formatMmss(0)).toBe('0:00')
    expect(formatMmss(5)).toBe('0:05')
    expect(formatMmss(90)).toBe('1:30')
    expect(formatMmss(600)).toBe('10:00')
    expect(formatMmss(605)).toBe('10:05')
  })
  it('clamps negatives and non-finite to 0:00', () => {
    expect(formatMmss(-3)).toBe('0:00')
    expect(formatMmss(Number.NaN)).toBe('0:00')
    expect(formatMmss(Number.POSITIVE_INFINITY)).toBe('0:00')
  })
  it('rounds fractional seconds', () => {
    expect(formatMmss(89.6)).toBe('1:30')
  })
})

describe('parseMmss', () => {
  it('parses m:ss', () => {
    expect(parseMmss('1:30')).toBe(90)
    expect(parseMmss('0:45')).toBe(45)
    expect(parseMmss('10:00')).toBe(600)
    expect(parseMmss('2:5')).toBe(125)
  })
  it('parses bare digits as seconds (legacy raw-seconds muscle memory)', () => {
    expect(parseMmss('90')).toBe(90)
    expect(parseMmss('0')).toBe(0)
    expect(parseMmss(' 120 ')).toBe(120)
  })
  it('parses bare decimal seconds, rounded (the old number inputs accepted these)', () => {
    expect(parseMmss('45.5')).toBe(46)
    expect(parseMmss('90.4')).toBe(90)
    expect(parseMmss('1.5')).toBe(2)
  })
  it('parses a leading-colon shorthand as seconds', () => {
    expect(parseMmss(':45')).toBe(45)
  })
  it('rejects empty and garbage', () => {
    expect(parseMmss('')).toBeNull()
    expect(parseMmss('  ')).toBeNull()
    expect(parseMmss('abc')).toBeNull()
    expect(parseMmss('1:75')).toBeNull() // seconds field must be < 60
    expect(parseMmss('-30')).toBeNull()
    expect(parseMmss('1:2:3')).toBeNull()
    expect(parseMmss('1.')).toBeNull() // trailing dot is not a decimal
    expect(parseMmss('.5')).toBeNull()
  })
})

describe('mmssTextToDigits', () => {
  it('strips non-digits and leading zeros', () => {
    expect(mmssTextToDigits('')).toBe('')
    expect(mmssTextToDigits('1:30')).toBe('130')
    expect(mmssTextToDigits('0:09')).toBe('9')
    expect(mmssTextToDigits('00100')).toBe('100')
    expect(mmssTextToDigits('abc')).toBe('')
    expect(mmssTextToDigits(':45')).toBe('45')
  })
  it('keeps only the last 4 digits', () => {
    expect(mmssTextToDigits('12345')).toBe('2345')
  })
  it('collapses all-zero input to empty (so backspace can clear the field)', () => {
    expect(mmssTextToDigits('0')).toBe('')
    expect(mmssTextToDigits('0:00')).toBe('')
    expect(mmssTextToDigits('0:0')).toBe('') // mid-backspace through "0:00"
  })
})

describe('mmssSeedDigits', () => {
  it('seeds like mmssTextToDigits for ordinary values', () => {
    expect(mmssSeedDigits('')).toBe('')
    expect(mmssSeedDigits('1:30')).toBe('130')
    expect(mmssSeedDigits('60')).toBe('60')
    expect(mmssSeedDigits('abc')).toBe('')
  })
  it('keeps an explicit zero value as "0" (no-edit focus/blur re-commits it)', () => {
    expect(mmssSeedDigits('0:00')).toBe('0')
    expect(mmssSeedDigits('0')).toBe('0')
  })
})

describe('mmssDigitsToDisplay', () => {
  it('fills positionally from the right', () => {
    expect(mmssDigitsToDisplay('')).toBe('')
    expect(mmssDigitsToDisplay('1')).toBe('0:01')
    expect(mmssDigitsToDisplay('10')).toBe('0:10')
    expect(mmssDigitsToDisplay('100')).toBe('1:00')
    expect(mmssDigitsToDisplay('1000')).toBe('10:00')
  })
  it('shows overflow seconds raw while typing (normalized at commit)', () => {
    expect(mmssDigitsToDisplay('90')).toBe('0:90')
  })
  it('renders an explicit zero buffer as 0:00', () => {
    expect(mmssDigitsToDisplay('0')).toBe('0:00')
    expect(mmssDigitsToSeconds('0')).toBe(0)
  })
})

describe('mmssDigitsToSeconds', () => {
  it('reads the buffer as positional mm:ss', () => {
    expect(mmssDigitsToSeconds('')).toBeNull()
    expect(mmssDigitsToSeconds('1')).toBe(1)
    expect(mmssDigitsToSeconds('90')).toBe(90)
    expect(mmssDigitsToSeconds('130')).toBe(90)
    expect(mmssDigitsToSeconds('1000')).toBe(600)
    expect(mmssDigitsToSeconds('9999')).toBe(6039)
  })
  it('round-trips: overflow buffers re-normalize through formatMmss', () => {
    const s = mmssDigitsToSeconds('90')
    expect(s).toBe(90)
    expect(mmssTextToDigits(formatMmss(s!))).toBe('130')
  })
})

import { describe, it, expect } from 'vitest'
import {
  aqiSeverityLabel,
  tempLabel,
  uvSeverity,
  uvWord,
} from './weather-severity.js'

describe('uvSeverity (WHO bands)', () => {
  it('classifies null as low (no data == no warning)', () => {
    expect(uvSeverity(null)).toBe('low')
  })

  it('returns low for 0–2', () => {
    expect(uvSeverity(0)).toBe('low')
    expect(uvSeverity(2.9)).toBe('low')
  })

  it('returns moderate for 3–5', () => {
    expect(uvSeverity(3)).toBe('moderate')
    expect(uvSeverity(5.9)).toBe('moderate')
  })

  it('returns high for 6–7', () => {
    expect(uvSeverity(6)).toBe('high')
    expect(uvSeverity(7.9)).toBe('high')
  })

  it('returns very-high for 8–10', () => {
    expect(uvSeverity(8)).toBe('very-high')
    expect(uvSeverity(10.9)).toBe('very-high')
  })

  it('returns extreme for 11+', () => {
    expect(uvSeverity(11)).toBe('extreme')
    expect(uvSeverity(15)).toBe('extreme')
  })
})

describe('uvWord', () => {
  it('renders the hyphenated very-high label as a space', () => {
    expect(uvWord('very-high')).toBe('VERY HIGH')
  })
  it('upper-cases simple bands', () => {
    expect(uvWord('low')).toBe('LOW')
    expect(uvWord('extreme')).toBe('EXTREME')
  })
})

describe('aqiSeverityLabel (US AQI / EPA AirNow)', () => {
  it('returns null when AQI is missing', () => {
    expect(aqiSeverityLabel(null)).toBe(null)
  })
  it('classifies 0–50 as GOOD', () => {
    expect(aqiSeverityLabel(0)).toBe('GOOD')
    expect(aqiSeverityLabel(50)).toBe('GOOD')
  })
  it('classifies 51–100 as MODERATE', () => {
    expect(aqiSeverityLabel(51)).toBe('MODERATE')
    expect(aqiSeverityLabel(100)).toBe('MODERATE')
  })
  it('classifies 101–150 as USG (Unhealthy for Sensitive Groups)', () => {
    expect(aqiSeverityLabel(101)).toBe('USG')
    expect(aqiSeverityLabel(150)).toBe('USG')
  })
  it('classifies 151–200 as UNHEALTHY', () => {
    expect(aqiSeverityLabel(151)).toBe('UNHEALTHY')
    expect(aqiSeverityLabel(200)).toBe('UNHEALTHY')
  })
  it('classifies 201–300 as VERY UNHEALTHY', () => {
    expect(aqiSeverityLabel(201)).toBe('VERY UNHEALTHY')
    expect(aqiSeverityLabel(300)).toBe('VERY UNHEALTHY')
  })
  it('classifies 301+ as HAZARDOUS', () => {
    expect(aqiSeverityLabel(301)).toBe('HAZARDOUS')
    expect(aqiSeverityLabel(500)).toBe('HAZARDOUS')
  })
})

describe('tempLabel', () => {
  it('shows em-dash when missing', () => {
    expect(tempLabel(null)).toBe('—')
  })
  it('rounds and appends °C', () => {
    expect(tempLabel(21.4)).toBe('21°C')
    expect(tempLabel(-3.6)).toBe('-4°C')
  })
})

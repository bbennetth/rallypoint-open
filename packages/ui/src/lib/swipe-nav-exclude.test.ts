// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { isSwipeExcluded } from './swipe-nav.js'

describe('isSwipeExcluded', () => {
  it('returns false for a plain element with no markers', () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    expect(isSwipeExcluded(el)).toBe(false)
  })

  it('returns true when the target itself has data-noswipe', () => {
    const el = document.createElement('div')
    el.setAttribute('data-noswipe', '')
    document.body.appendChild(el)
    expect(isSwipeExcluded(el)).toBe(true)
  })

  it('returns true when an ancestor has data-noswipe', () => {
    const parent = document.createElement('div')
    parent.setAttribute('data-noswipe', '')
    const child = document.createElement('button')
    parent.appendChild(child)
    document.body.appendChild(parent)
    expect(isSwipeExcluded(child)).toBe(true)
  })

  it('returns false for null and non-Element targets', () => {
    expect(isSwipeExcluded(null)).toBe(false)
    expect(isSwipeExcluded(new EventTarget())).toBe(false)
  })
})

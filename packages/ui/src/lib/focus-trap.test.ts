// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { nextFocusAfterTrap } from './focus-trap.js'

// JSDOM doesn't compute layout, so `offsetParent` is null for every
// element by default — the helper's "skip display:none / visibility:
// hidden" filter would drop everything. We force a non-null
// offsetParent on the focusables we want considered before each
// scenario; that's the same trick @testing-library uses.
function makeFocusable(el: HTMLElement): HTMLElement {
  Object.defineProperty(el, 'offsetParent', {
    configurable: true,
    get: () => document.body,
  })
  return el
}

function makeHidden(el: HTMLElement): HTMLElement {
  Object.defineProperty(el, 'offsetParent', {
    configurable: true,
    get: () => null,
  })
  return el
}

function setup(html: string): {
  container: HTMLDivElement
  focusables: HTMLElement[]
} {
  document.body.innerHTML = ''
  const container = document.createElement('div')
  container.innerHTML = html
  document.body.appendChild(container)
  const focusables = Array.from(
    container.querySelectorAll<HTMLElement>(
      'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"])',
    ),
  )
  focusables.forEach(makeFocusable)
  return { container, focusables }
}

describe('nextFocusAfterTrap', () => {
  it('returns null when the container has no focusable nodes', () => {
    const { container } = setup('<p>nothing here</p>')
    expect(nextFocusAfterTrap(container, null, 'forward')).toBeNull()
    expect(nextFocusAfterTrap(container, null, 'backward')).toBeNull()
  })

  it('returns the first focusable when current is null + forward', () => {
    const { container, focusables } = setup(
      '<button>one</button><button>two</button>',
    )
    expect(nextFocusAfterTrap(container, null, 'forward')).toBe(focusables[0])
  })

  it('returns the last focusable when current is null + backward', () => {
    const { container, focusables } = setup(
      '<button>one</button><button>two</button><a href="#">three</a>',
    )
    expect(nextFocusAfterTrap(container, null, 'backward')).toBe(
      focusables[focusables.length - 1],
    )
  })

  it('advances forward through the focusable order', () => {
    const { container, focusables } = setup(
      '<button>a</button><button>b</button><button>c</button>',
    )
    expect(nextFocusAfterTrap(container, focusables[0]!, 'forward')).toBe(
      focusables[1],
    )
    expect(nextFocusAfterTrap(container, focusables[1]!, 'forward')).toBe(
      focusables[2],
    )
  })

  it('wraps forward from the last focusable back to the first', () => {
    const { container, focusables } = setup(
      '<button>a</button><button>b</button>',
    )
    expect(nextFocusAfterTrap(container, focusables[1]!, 'forward')).toBe(
      focusables[0],
    )
  })

  it('wraps backward from the first focusable to the last', () => {
    const { container, focusables } = setup(
      '<button>a</button><button>b</button>',
    )
    expect(nextFocusAfterTrap(container, focusables[0]!, 'backward')).toBe(
      focusables[1],
    )
  })

  it('skips disabled buttons (they fail the selector)', () => {
    const { container } = setup(
      '<button>a</button><button disabled>nope</button><button>c</button>',
    )
    const focusables = Array.from(
      container.querySelectorAll<HTMLElement>('button:not([disabled])'),
    )
    focusables.forEach(makeFocusable)
    expect(nextFocusAfterTrap(container, focusables[0]!, 'forward')).toBe(
      focusables[1],
    )
  })

  it('skips visually-hidden focusables (offsetParent === null)', () => {
    document.body.innerHTML = ''
    const container = document.createElement('div')
    const a = document.createElement('button')
    a.textContent = 'a'
    const hidden = document.createElement('button')
    hidden.textContent = 'hidden'
    const c = document.createElement('button')
    c.textContent = 'c'
    container.append(a, hidden, c)
    document.body.appendChild(container)
    makeFocusable(a)
    makeHidden(hidden)
    makeFocusable(c)
    expect(nextFocusAfterTrap(container, a, 'forward')).toBe(c)
  })

  it('falls back to first focusable when current is outside the container', () => {
    const { container, focusables } = setup(
      '<button>a</button><button>b</button>',
    )
    const stranger = document.createElement('button')
    document.body.appendChild(stranger)
    expect(nextFocusAfterTrap(container, stranger, 'forward')).toBe(focusables[0])
    expect(nextFocusAfterTrap(container, stranger, 'backward')).toBe(
      focusables[focusables.length - 1],
    )
  })
})

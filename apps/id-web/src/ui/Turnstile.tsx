import { useEffect, useRef } from 'react'

// Cloudflare Turnstile widget loader. Loads the Turnstile script
// once per page; renders the widget into a div; calls onToken
// when the user solves it.
//
// Site key comes from VITE_TURNSTILE_SITE_KEY (defaults to the
// always-pass test key from .env.example so local dev works).

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js'

interface TurnstileGlobal {
  render: (
    el: HTMLElement,
    opts: {
      sitekey: string
      callback: (token: string) => void
      'error-callback'?: () => void
      'expired-callback'?: () => void
      theme?: 'light' | 'dark' | 'auto'
    },
  ) => string
  reset: (widgetId?: string) => void
}

declare global {
  interface Window {
    turnstile?: TurnstileGlobal
  }
}

let scriptPromise: Promise<void> | null = null
function loadScript(): Promise<void> {
  if (scriptPromise) return scriptPromise
  scriptPromise = new Promise<void>((resolve, reject) => {
    if (typeof document === 'undefined') return reject(new Error('SSR not supported'))
    if (window.turnstile) return resolve()
    const s = document.createElement('script')
    s.src = SCRIPT_SRC
    s.async = true
    s.defer = true
    s.onload = () => resolve()
    s.onerror = () => reject(new Error('failed to load turnstile'))
    document.head.appendChild(s)
  })
  return scriptPromise
}

export interface TurnstileProps {
  siteKey?: string
  onToken: (token: string) => void
  onError?: () => void
  onExpired?: () => void
}

export function Turnstile({ siteKey, onToken, onError, onExpired }: TurnstileProps) {
  const ref = useRef<HTMLDivElement>(null)
  const widgetId = useRef<string | undefined>(undefined)

  // Keep the latest callbacks in a ref so the render effect does NOT depend on
  // them. Callers pass inline callbacks (e.g. onError={() => setToken(null)}),
  // which are a new reference every render. If those were in the effect's dep
  // array, every parent re-render (including the setState the widget's own
  // solve triggers) would tear down and re-render the widget — spawning a
  // fresh Turnstile challenge each time, i.e. an infinite re-challenge loop.
  const cbs = useRef({ onToken, onError, onExpired })
  cbs.current = { onToken, onError, onExpired }

  const sitekey =
    siteKey ??
    (import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined) ??
    '1x00000000000000000000AA'

  useEffect(() => {
    let cancelled = false
    loadScript()
      .then(() => {
        if (cancelled) return
        if (!ref.current || !window.turnstile) return
        widgetId.current = window.turnstile.render(ref.current, {
          sitekey,
          callback: (token) => cbs.current.onToken(token),
          'error-callback': () => cbs.current.onError?.(),
          'expired-callback': () => cbs.current.onExpired?.(),
          theme: 'dark',
        })
      })
      .catch(() => {
        if (cancelled) return
        cbs.current.onError?.()
      })
    return () => {
      cancelled = true
      if (widgetId.current && window.turnstile) {
        try {
          window.turnstile.reset(widgetId.current)
        } catch {
          // ignore
        }
      }
    }
    // Render once per sitekey — NOT on callback identity (see cbs ref above).
  }, [sitekey])

  return <div ref={ref} className="mb-4" />
}

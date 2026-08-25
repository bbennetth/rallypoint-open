import { useCallback, useEffect, useRef, useState } from 'react'
import {
  applyEventPwaHead,
  restorePwaHead,
  type EventPwaHead,
} from './pwaHead.js'

// Install affordance for the per-event PWA.
//
// The two platforms behave completely differently and neither can be
// papered over:
//
//   Chromium — fires `beforeinstallprompt`, which we capture and replay
//     when the user clicks. The event is single-use; after `prompt()`
//     resolves the browser will not hand us another one.
//   iOS Safari — never fires it. Installation is Share → Add to Home
//     Screen, a manual gesture we can only *instruct*, never trigger.
//
// So the hook exposes both a `promptInstall` and an `isIos` flag, and
// the UI shows a button or an instructions sheet accordingly.

// Minimal shape of the non-standard Chromium event.
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export function isStandaloneDisplay(win: Window = window): boolean {
  // iOS uses a non-standard navigator.standalone; everything else
  // reports the display-mode media query.
  const iosStandalone = (win.navigator as { standalone?: boolean }).standalone === true
  const mq = win.matchMedia?.('(display-mode: standalone)').matches === true
  return iosStandalone || mq
}

export function isIosSafari(win: Window = window): boolean {
  const ua = win.navigator.userAgent
  const isIosDevice =
    /iPad|iPhone|iPod/.test(ua) ||
    // iPadOS 13+ reports as Mac; the touch-point count disambiguates.
    (/Macintosh/.test(ua) && (win.navigator.maxTouchPoints ?? 0) > 1)
  if (!isIosDevice) return false
  // Chrome/Firefox on iOS are Safari underneath and install the same
  // way, so don't exclude them.
  return true
}

export interface InstallPromptState {
  /** True when a captured Chromium prompt is ready to replay. */
  canPrompt: boolean
  /** True when the page is already running as an installed app. */
  isStandalone: boolean
  /** True on iOS, where install is a manual Share-sheet gesture. */
  isIos: boolean
  /** Replays the captured prompt. Resolves to the user's choice. */
  promptInstall: () => Promise<'accepted' | 'dismissed' | 'unavailable'>
}

export function useInstallPrompt(): InstallPromptState {
  const deferred = useRef<BeforeInstallPromptEvent | null>(null)
  const [canPrompt, setCanPrompt] = useState(false)
  const [isStandalone, setIsStandalone] = useState(() => isStandaloneDisplay())
  const isIos = isIosSafari()

  useEffect(() => {
    function onBeforeInstallPrompt(e: Event): void {
      // Suppress Chromium's own mini-infobar so our in-app affordance is
      // the single entry point (and so it can't fire mid-scroll).
      e.preventDefault()
      deferred.current = e as BeforeInstallPromptEvent
      setCanPrompt(true)
    }
    function onInstalled(): void {
      deferred.current = null
      setCanPrompt(false)
      setIsStandalone(true)
    }
    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  const promptInstall = useCallback(async () => {
    const evt = deferred.current
    if (!evt) return 'unavailable' as const
    await evt.prompt()
    const { outcome } = await evt.userChoice
    // The event cannot be replayed — drop it either way.
    deferred.current = null
    setCanPrompt(false)
    return outcome
  }, [])

  return { canPrompt, isStandalone, isIos, promptInstall }
}

/**
 * Point the document's PWA head tags at this event for as long as the
 * calling component is mounted, restoring the generic app tags on
 * unmount. See lib/pwaHead.ts for why the apple-* tags matter.
 */
export function useEventPwaHead(input: EventPwaHead | null): void {
  const { eventId, name, groupId, hasIcon } = input ?? {}
  useEffect(() => {
    if (!eventId || !name) return
    const snapshot = applyEventPwaHead(document, {
      eventId,
      name,
      groupId: groupId ?? null,
      hasIcon: hasIcon ?? false,
    })
    return () => restorePwaHead(document, snapshot)
  }, [eventId, name, groupId, hasIcon])
}

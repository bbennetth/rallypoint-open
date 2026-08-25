import { useCallback, useEffect, useRef, useState } from 'react'

// Thin React wrapper around the browser Web Speech API (voice → text) for AI
// Assist dictation. There is NO backend speech-to-text — this is entirely
// client-side and degrades gracefully: unsupported browsers (Firefox, some
// Android WebViews) report `supported: false` so the caller hides the mic and
// the user just types. Chrome/Edge/Safari route audio through the platform's
// recognizer, which needs network.

// Minimal typings for the vendor-prefixed Web Speech API (not in lib.dom).
interface SpeechRecognitionAlternativeLike {
  transcript: string
}
interface SpeechRecognitionResultLike {
  0: SpeechRecognitionAlternativeLike
  isFinal: boolean
  length: number
}
interface SpeechRecognitionEventLike {
  resultIndex: number
  results: {
    length: number
    [index: number]: SpeechRecognitionResultLike
  }
}
interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  start(): void
  stop(): void
  abort(): void
  onresult: ((e: SpeechRecognitionEventLike) => void) | null
  onerror: ((e: { error?: string }) => void) | null
  onend: (() => void) | null
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor
    webkitSpeechRecognition?: SpeechRecognitionCtor
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export interface SpeechInput {
  /** Whether this browser exposes the Web Speech API at all. */
  supported: boolean
  /** True between start() and the recognizer ending. */
  listening: boolean
  /** The best final + interim transcript for the current session. */
  transcript: string
  /** A user-facing error string, or null. */
  error: string | null
  start: () => void
  stop: () => void
}

// `onFinal` fires with each finalized chunk so the caller can append it to the
// text field; interim results drive the live `transcript` preview.
export function useSpeechInput(onFinal?: (text: string) => void): SpeechInput {
  const supported = getRecognitionCtor() !== null
  const [listening, setListening] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [error, setError] = useState<string | null>(null)
  const recRef = useRef<SpeechRecognitionLike | null>(null)
  const onFinalRef = useRef(onFinal)
  onFinalRef.current = onFinal

  const stop = useCallback(() => {
    recRef.current?.stop()
  }, [])

  const start = useCallback(() => {
    const Ctor = getRecognitionCtor()
    if (!Ctor) return
    // Guard against a double-start (throws in some engines).
    if (recRef.current) return
    setError(null)
    setTranscript('')
    const rec = new Ctor()
    rec.lang =
      (typeof navigator !== 'undefined' && navigator.language) || 'en-US'
    rec.continuous = true
    rec.interimResults = true
    rec.onresult = (e) => {
      let interim = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i]!
        const text = result[0].transcript
        if (result.isFinal) onFinalRef.current?.(text)
        else interim += text
      }
      setTranscript(interim)
    }
    rec.onerror = (ev) => {
      // 'no-speech' / 'aborted' are benign; surface the rest.
      const code = ev.error ?? 'error'
      if (code !== 'no-speech' && code !== 'aborted') {
        setError(code === 'not-allowed' ? 'Microphone access was denied.' : 'Could not hear that.')
      }
    }
    rec.onend = () => {
      setListening(false)
      setTranscript('')
      recRef.current = null
    }
    recRef.current = rec
    try {
      rec.start()
      setListening(true)
    } catch {
      recRef.current = null
      setError('Could not start the microphone.')
    }
  }, [])

  // Stop the recognizer if the component unmounts mid-listen.
  useEffect(() => {
    return () => {
      recRef.current?.abort()
      recRef.current = null
    }
  }, [])

  return { supported, listening, transcript, error, start, stop }
}

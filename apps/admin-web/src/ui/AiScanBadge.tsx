import { useState } from 'react'
import type { SubmissionScanDto } from '../lib/api.js'

// The automatic AI triage badge shown on both review queues: a verdict
// pill (ok / warn / flag, plus pending / failed states) that expands
// into the finding list. Advisory only — approving/rejecting stays the
// admin's call. Styled inline like the queue pages (no app-local design
// system beyond @rallypoint/ui).

const PILL: Record<string, { label: string; bg: string; fg: string }> = {
  ok: { label: 'AI: looks fine', bg: 'rgba(46, 160, 67, 0.15)', fg: '#2ea043' },
  warn: { label: 'AI: check', bg: 'rgba(210, 153, 34, 0.15)', fg: '#d29922' },
  flag: { label: 'AI: flagged', bg: 'rgba(218, 54, 51, 0.15)', fg: '#da3633' },
  pending: { label: 'AI: scanning…', bg: 'rgba(139, 148, 158, 0.15)', fg: '#8b949e' },
  failed: { label: 'AI: scan failed', bg: 'rgba(139, 148, 158, 0.15)', fg: '#8b949e' },
}

const DIMENSION_LABEL: Record<string, string> = {
  quality: 'Quality',
  duplicate: 'Duplicate',
  moderation: 'Moderation',
}

export function AiScanBadge({ scan }: { scan: SubmissionScanDto | null }) {
  const [open, setOpen] = useState(false)
  if (!scan) return null
  const key = scan.status === 'done' ? (scan.verdict ?? 'ok') : scan.status
  const pill = PILL[key] ?? PILL.failed!
  const expandable = scan.status === 'done' && scan.findings.length > 0

  return (
    <div style={{ marginTop: 6 }}>
      <button
        type="button"
        onClick={() => expandable && setOpen(!open)}
        style={{
          border: 'none',
          borderRadius: 999,
          padding: '2px 10px',
          fontSize: 12,
          fontWeight: 600,
          background: pill.bg,
          color: pill.fg,
          cursor: expandable ? 'pointer' : 'default',
        }}
        title={expandable ? 'Show AI findings' : undefined}
      >
        {pill.label}
        {expandable ? ` (${scan.findings.length})${open ? ' ▾' : ' ▸'}` : ''}
      </button>
      {open && expandable && (
        <ul className="muted" style={{ fontSize: 13, margin: '6px 0 0', paddingLeft: 18 }}>
          {scan.findings.map((f, i) => (
            <li key={i}>
              <strong>{DIMENSION_LABEL[f.dimension] ?? f.dimension}</strong> ({f.severity}):{' '}
              {f.message}
              {f.suggestedName && <> — suggested name: “{f.suggestedName}”</>}
              {f.suggestedBrand && <> — suggested brand: “{f.suggestedBrand}”</>}
              {f.duplicateId && (
                <>
                  {' '}
                  — matches <code>{f.duplicateId}</code>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

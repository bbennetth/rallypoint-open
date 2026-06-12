import { useState } from 'react'
import QRCode from 'react-qr-code'
import {
  SHARE_TARGETS,
  buildGroupInviteLink,
  buildShareUrl,
  type ShareTarget,
} from '../lib/share-invite.js'

// Group invite card (#440, festival-planner Crew-tab parity): the
// re-showable 6-char code, a scan-to-join QR (encodes the same link
// the Copy button copies), and compose-deep-link share buttons.
// Rendered for every group member — invites are a member activity,
// not an owner privilege (matches FP).

const TARGET_LABELS: Record<ShareTarget, string> = {
  sms: 'SMS',
  whatsapp: 'WhatsApp',
  x: 'X',
  line: 'Line',
}

export function GroupInviteCard({
  groupName,
  shortCode,
}: {
  groupName: string
  shortCode: string | null
}) {
  const [copied, setCopied] = useState(false)
  const inviteLink = buildGroupInviteLink({
    shortCode,
    origin: window.location.origin,
  })
  const message = `Join my group "${groupName}" on Rallypoint!`

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(inviteLink)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      window.prompt('Copy this invite link:', inviteLink)
    }
  }

  return (
    <section
      className="p-4 space-y-4"
      style={{ border: '1.5px solid var(--line)', background: 'var(--surface)' }}
    >
      <h3 className="text-xs font-medium text-[color:var(--ink-mute)]">Invite friends</h3>

      <div className="flex items-center gap-4 flex-wrap">
        <div className="space-y-1">
          <p className="mono text-xs uppercase tracking-wide text-[color:var(--ink-dim)]">
            Join code
          </p>
          <p
            className="mono display"
            style={{ fontSize: 28, letterSpacing: '0.25em' }}
            aria-label="Group join code"
          >
            {shortCode ?? '······'}
          </p>
        </div>

        {shortCode && (
          <div
            style={{ background: '#fff', padding: 8, lineHeight: 0 }}
            aria-label="Scan to join QR code"
          >
            <QRCode value={inviteLink} size={112} />
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <button type="button" onClick={() => void copyLink()} className="btn-brutal" style={{ width: 'auto' }}>
          {copied ? 'Copied!' : 'Copy invite link'}
        </button>
        {SHARE_TARGETS.map((target) => (
          <a
            key={target}
            href={buildShareUrl(target, { url: inviteLink, message })}
            className="btn-ghost"
            style={{ width: 'auto', textDecoration: 'none' }}
          >
            {TARGET_LABELS[target]}
          </a>
        ))}
      </div>

      <p className="text-xs text-[color:var(--ink-dim)]">
        Friends can scan the QR, open the link, or enter the code at Join group.
      </p>
    </section>
  )
}

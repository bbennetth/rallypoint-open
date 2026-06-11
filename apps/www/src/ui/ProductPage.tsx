import { PageShell } from './PageShell.js'

export interface ProductPageProps {
  /** Product name, e.g. "Planner". */
  name: string
  /** One-line positioning sentence under the title. */
  tagline: string
  /** Concise feature bullets — what the product actually does. */
  features: string[]
  /** Label + href for the primary "open the app" CTA. */
  cta: { label: string; href: string }
}

// Shared layout for the apex product pages (Planner, Events). Title +
// tagline, a plain feature list, and one CTA that opens the app subdomain
// (which auto-signs the user in or sends them to RPID to create an account).
export function ProductPage({ name, tagline, features, cta }: ProductPageProps) {
  return (
    <PageShell>
      <div style={{ display: 'grid', gap: 32, maxWidth: 640 }}>
        <header style={{ display: 'grid', gap: 12 }}>
          <p className="mono" style={{ fontSize: 11, color: 'var(--acid)', margin: 0 }}>
            Rallypoint {name}
          </p>
          <h1 className="display" style={{ fontSize: 34, margin: 0, lineHeight: 1.1 }}>
            {tagline}
          </h1>
        </header>

        <ul style={{ display: 'grid', gap: 10, margin: 0, padding: 0, listStyle: 'none' }}>
          {features.map((f) => (
            <li
              key={f}
              style={{ fontSize: 15, color: 'var(--ink-dim)', display: 'flex', gap: 10 }}
            >
              <span aria-hidden style={{ color: 'var(--acid)' }}>
                →
              </span>
              <span>{f}</span>
            </li>
          ))}
        </ul>

        <div>
          <a href={cta.href} className="btn-brutal" style={{ width: 'auto' }}>
            {cta.label}
          </a>
        </div>
      </div>
    </PageShell>
  )
}

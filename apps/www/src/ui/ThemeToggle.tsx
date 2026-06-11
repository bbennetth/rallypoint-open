import { useThemeStore, type Theme } from '@rallypoint/ui'

// Light/dark two-dot toggle pill, ported from id-web so the apex site has
// the same theme control without depending on an app's internals.
const THEME_COLORS: Record<Theme, string> = {
  dark: 'var(--ink)',
  light: 'var(--surface-2)',
}

const THEME_LABEL: Record<Theme, string> = {
  dark: 'Dark',
  light: 'Light',
}

export function ThemeToggle() {
  const theme = useThemeStore((s) => s.theme)
  const toggle = useThemeStore((s) => s.toggle)
  const other: Theme = theme === 'dark' ? 'light' : 'dark'

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`Switch to ${THEME_LABEL[other]} theme`}
      title={`${THEME_LABEL[theme]} theme — tap for ${THEME_LABEL[other]}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        padding: '3px 5px',
        background: 'transparent',
        border: '1.5px solid var(--line)',
        borderRadius: 999,
        cursor: 'pointer',
        lineHeight: 0,
      }}
    >
      {(['dark', 'light'] as const).map((t) => (
        <span
          key={t}
          aria-hidden
          style={{
            width: 9,
            height: 9,
            borderRadius: '50%',
            background: THEME_COLORS[t],
            outline: theme === t ? '1.5px solid var(--ink)' : '1.5px solid transparent',
            outlineOffset: 0,
            display: 'inline-block',
          }}
        />
      ))}
    </button>
  )
}

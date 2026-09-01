// The /log launch pad: the secondary logging actions — body weight,
// progress pic, run, drink — as a 2×2 tile grid under the hero, so every
// way of logging something is one tap from the home tab.
//
// Pure presentation, same tile language as TodayActions at a reduced
// scale (.fit-pad-tile shares the .fit-hero-tile declarations). Tiles
// are always tappable: a live value (`value`) is decoration on top of
// the action, never a gate — while it loads the tile shows its label
// alone, exactly like the hero tiles do.

import { Icon, type IconName } from '@rallypoint/ui'

export interface LaunchTile {
  key: 'bodyweight' | 'photo' | 'cardio' | 'drink'
  label: string
  icon: IconName
  /** Live value line ("82.4 kg"); null/absent renders the sub alone. */
  value?: string | null
  sub: string
  onSelect: () => void
}

export function LogLaunchPad({ tiles }: { tiles: readonly LaunchTile[] }) {
  return (
    <section className="fit-pad" aria-label="More logging">
      {tiles.map((t) => (
        <button key={t.key} type="button" className="fit-pad-tile" onClick={t.onSelect}>
          <span className="puck" aria-hidden>
            <Icon name={t.icon} size={16} />
          </span>
          <span className="eyebrow">{t.label}</span>
          {t.value != null && <span className="v">{t.value}</span>}
          <span className="u">{t.sub}</span>
        </button>
      ))}
    </section>
  )
}

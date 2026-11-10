import { useState } from 'react'
import { CalendarDays, CalendarOff, Check, Info, LayoutGrid, SlidersHorizontal, X } from 'lucide-react'
import type { CalendarProvider, Item } from '@blade-notes/core'
import { childrenOf, settingsOf, update, updateSettings, useStore } from './store'
import { isDesktop } from './host'
import { UpdatesSection } from './Updates'

export type SettingsSection = 'general' | 'calendars' | 'spaces' | 'about'

export const PROVIDERS: { id: CalendarProvider; name: string; detail: string }[] = [
  { id: 'google', name: 'Google Calendar', detail: 'Gmail or Google Workspace account' },
  { id: 'outlook', name: 'Outlook Calendar', detail: 'Microsoft 365, Outlook.com or work account' },
  { id: 'apple', name: 'Apple Calendar', detail: 'iCloud, with an app-specific password' },
]
const providerName = (p: CalendarProvider | null) => (p ? PROVIDERS.find((x) => x.id === p)!.name : 'No calendar')

export function SettingsDialog({ initial = 'general', onClose, dark, onToggleDark }: {
  initial?: SettingsSection
  onClose: () => void
  dark: boolean
  onToggleDark: () => void
}) {
  const [section, setSection] = useState<SettingsSection>(initial)
  const nav: [SettingsSection, string, typeof Info][] = [
    ['general', 'General', SlidersHorizontal],
    ['calendars', 'Calendars', CalendarDays],
    ['spaces', 'Spaces', LayoutGrid],
    ...(isDesktop ? ([['about', 'About & updates', Info]] as [SettingsSection, string, typeof Info][]) : []),
  ]
  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="dialog settings" role="dialog" aria-modal="true" aria-label="Settings">
        <nav className="settings-nav" aria-label="Settings sections">
          <h2>Settings</h2>
          {nav.map(([id, label, Icon]) => (
            <button key={id} className={section === id ? 'settings-tab on' : 'settings-tab'} aria-current={section === id ? 'page' : undefined} onClick={() => setSection(id)}>
              <Icon size={16} aria-hidden /> {label}
            </button>
          ))}
        </nav>
        <section className="settings-body">
          <div className="dialog-head">
            <h3>{nav.find(([id]) => id === section)?.[1]}</h3>
            <button className="ghost" aria-label="Close settings" onClick={onClose} autoFocus>
              <X size={16} aria-hidden />
            </button>
          </div>
          {section === 'general' && <General dark={dark} onToggleDark={onToggleDark} />}
          {section === 'calendars' && <Calendars />}
          {section === 'spaces' && <Spaces />}
          {section === 'about' && <UpdatesSection />}
        </section>
      </div>
    </div>
  )
}

function General({ dark, onToggleDark }: { dark: boolean; onToggleDark: () => void }) {
  const { state } = useStore()
  const settings = settingsOf(state)
  return (
    <div className="settings-rows">
      <label className="setting">
        <span>
          <strong>Open blades before folding</strong>
          <small>Older blades fold into thin strips once more than this many are open.</small>
        </span>
        <select className="field" value={settings.bladesOpen} onChange={(e) => updateSettings({ bladesOpen: Number(e.target.value) })}>
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
      </label>
      <label className="setting">
        <span>
          <strong>Dark mode</strong>
          <small>Remembered on this device.</small>
        </span>
        <input type="checkbox" className="switch" checked={dark} onChange={onToggleDark} />
      </label>
    </div>
  )
}

const PROVIDER_LOOK: { [p in CalendarProvider]: { color: string; tint: string } } = {
  google: { color: '#1a73e8', tint: 'rgba(26, 115, 232, 0.12)' },
  outlook: { color: '#0f6cbd', tint: 'rgba(15, 108, 189, 0.12)' },
  apple: { color: '#e5484d', tint: 'rgba(229, 72, 77, 0.12)' },
}

function ProviderMark({ id, size = 36 }: { id: CalendarProvider | null; size?: number }) {
  const look = id ? PROVIDER_LOOK[id] : { color: 'var(--muted-fg)', tint: 'var(--muted)' }
  return (
    <span className="provider-mark" style={{ width: size, height: size, background: look.tint, color: look.color }} aria-hidden>
      {id ? <CalendarDays size={size * 0.5} /> : <CalendarOff size={size * 0.5} />}
    </span>
  )
}

/**
 * One card per provider: pick the default calendar for every space, see whether the
 * account is connected; below, each space can follow the default or pick its own.
 */
function Calendars() {
  const { state } = useStore()
  const settings = settingsOf(state)
  const spaces: Item[] = childrenOf(state.items, null)
  const setSpace = (id: string, value: CalendarProvider | null | 'inherit') => {
    const next = { ...settings.spaceCalendars }
    if (value === 'inherit') delete next[id]
    else next[id] = value
    updateSettings({ spaceCalendars: next })
  }
  return (
    <div className="settings-rows">
      <p className="muted small">Notes and tasks with a date show up on a calendar. Pick the one every space uses; a space can still choose its own below.</p>

      <div className="provider-grid" role="radiogroup" aria-label="Default calendar">
        {PROVIDERS.map((p) => {
          const on = settings.defaultCalendar === p.id
          return (
            <div key={p.id} className={on ? 'provider-card on' : 'provider-card'}>
              <div className="provider-top">
                <ProviderMark id={p.id} />
                {on && <span className="badge"><Check size={12} aria-hidden /> Default</span>}
              </div>
              <strong>{p.name}</strong>
              <small>{p.detail}</small>
              <span className="provider-status"><span className="status-dot" /> Not connected</span>
              <div className="provider-actions">
                <button type="button" role="radio" aria-checked={on} className={on ? 'btn on' : 'btn'} onClick={() => updateSettings({ defaultCalendar: on ? null : p.id })}>
                  {on ? 'Default' : 'Use for all'}
                </button>
                <button type="button" className="btn" disabled title="Connecting comes with the calendar sync step">Connect</button>
              </div>
            </div>
          )
        })}
      </div>
      <button type="button" className={settings.defaultCalendar === null ? 'link-btn on' : 'link-btn'} onClick={() => updateSettings({ defaultCalendar: null })}>
        {settings.defaultCalendar === null ? 'No default calendar — spaces only use one if you pick it below' : 'Use no default calendar'}
      </button>

      <h4 className="settings-sub">By space</h4>
      {spaces.length === 0 && <p className="muted small">No spaces yet.</p>}
      <ul className="space-cal-list">
        {spaces.map((s) => {
          const own = s.id in settings.spaceCalendars
          const current = own ? (settings.spaceCalendars[s.id] ?? null) : 'inherit'
          const options: [CalendarProvider | null | 'inherit', string][] = [
            ['inherit', `Default${settings.defaultCalendar ? ` · ${providerName(settings.defaultCalendar).replace(' Calendar', '')}` : ''}`],
            ['google', 'Google'],
            ['outlook', 'Outlook'],
            ['apple', 'Apple'],
            [null, 'None'],
          ]
          return (
            <li key={s.id} className="space-cal">
              <span className="space-name">
                <span className="dot" style={{ background: s.color ?? 'var(--primary)' }} />
                <strong>{s.title}</strong>
              </span>
              <div className="segmented" role="radiogroup" aria-label={`Calendar for ${s.title}`}>
                {options.map(([value, label]) => (
                  <button
                    key={String(value)}
                    type="button"
                    role="radio"
                    aria-checked={current === value}
                    className={current === value ? 'seg on' : 'seg'}
                    onClick={() => setSpace(s.id, value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </li>
          )
        })}
      </ul>
      <p className="muted small">Connecting accounts comes next: it needs the app registered with Google and Microsoft. Everything you pick here is saved and applies as soon as an account is connected.</p>
    </div>
  )
}

const SPACE_COLORS = ['#6C4DFF', '#FF5E62', '#FFBE2E', '#22D3C5', '#2857e5', '#14874e', '#e5484d', '#8f4c08']

/** Per-space look: colour for now (rename by double-clicking a space's blade title). */
function Spaces() {
  const { state } = useStore()
  const spaces: Item[] = childrenOf(state.items, null)
  if (spaces.length === 0) return <p className="muted small">No spaces yet.</p>
  return (
    <div className="settings-rows">
      <p className="muted small">Each space's colour shows on its dot in the blades and on calendars. Calendar choice per space is under Calendars.</p>
      {spaces.map((s) => (
        <div key={s.id} className="setting">
          <span className="space-name">
            <span className="dot" style={{ background: s.color ?? 'var(--primary)' }} />
            <strong>{s.title}</strong>
          </span>
          <div className="swatches" role="radiogroup" aria-label={`Colour for ${s.title}`}>
            {SPACE_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={s.color === c}
                aria-label={c}
                className={s.color === c ? 'swatch on' : 'swatch'}
                style={{ background: c }}
                onClick={() => update(s.id, { color: c })}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

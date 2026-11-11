import { useCallback, useEffect, useState } from 'react'
import { AppWindow, CalendarDays, CalendarOff, Check, CircleHelp, Info, LayoutGrid, MessageSquare, NotebookText, PanelRight, Shield, SlidersHorizontal, X } from 'lucide-react'
import type { CalendarProvider, CalendarStatus, DescriptionView, Item } from '@blade-notes/core'
import { api, childrenOf, settingsOf, update, updateSettings, useStore } from './store'
import { isDesktop } from './host'
import { UpdatesSection } from './Updates'
import { SecuritySettings } from './SecuritySettings'
import { Help } from './Help'

export type SettingsSection = 'general' | 'descriptions' | 'calendars' | 'spaces' | 'security' | 'help' | 'about'

/** Lets any part of the app open Settings at a section (the Library blade owns the dialog). */
const requests = new Set<(s: SettingsSection) => void>()
export const openSettings = (section: SettingsSection) => requests.forEach((r) => r(section))
export function useSettingsRequests(open: (s: SettingsSection) => void) {
  useEffect(() => {
    requests.add(open)
    return () => void requests.delete(open)
  }, [open])
}

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
    ['descriptions', 'Descriptions', NotebookText],
    ['calendars', 'Calendars', CalendarDays],
    ['spaces', 'Spaces', LayoutGrid],
    ['security', 'Security', Shield],
    ['help', 'How to', CircleHelp],
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
          {section === 'descriptions' && <Descriptions />}
          {section === 'calendars' && <Calendars />}
          {section === 'spaces' && <Spaces />}
          {section === 'security' && <SecuritySettings />}
          {section === 'help' && <Help />}
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

const VIEWS: { id: DescriptionView; name: string; detail: string; Icon: typeof Info }[] = [
  { id: 'panel', name: 'Side blade', detail: 'Opens as a blade on the right. The note stays in view, and clicking another line switches to its description.', Icon: PanelRight },
  { id: 'modal', name: 'Window', detail: 'Opens in a window over the note. More room to write, nothing else in view.', Icon: AppWindow },
  { id: 'popover', name: 'Popup', detail: 'Opens right at the line or phrase. Quick to read; closes when you click elsewhere.', Icon: MessageSquare },
]

/** How descriptions of list items and phrases open, and whether hovering previews them. */
function Descriptions() {
  const { state } = useStore()
  const settings = settingsOf(state)
  return (
    <div className="settings-rows">
      <p className="muted small">Any bullet, numbered or checklist line, and any phrase you select, can carry a hidden description with its own text and files. Add one with the small + at the end of a line, Describe on selected text, or ⌘⇧D.</p>
      <div className="provider-grid" role="radiogroup" aria-label="Open descriptions as">
        {VIEWS.map(({ id, name, detail, Icon }) => {
          const on = settings.descriptionView === id
          return (
            <button key={id} type="button" role="radio" aria-checked={on} className={on ? 'provider-card view-card on' : 'provider-card view-card'} onClick={() => updateSettings({ descriptionView: id })}>
              <div className="provider-top">
                <span className="provider-mark" style={{ width: 36, height: 36 }} aria-hidden><Icon size={18} /></span>
                {on && <span className="badge"><Check size={12} aria-hidden /> In use</span>}
              </div>
              <strong>{name}</strong>
              <small>{detail}</small>
            </button>
          )
        })}
      </div>
      <label className="setting">
        <span>
          <strong>Preview on hover</strong>
          <small>Hovering a described phrase shows the start of its description.</small>
        </span>
        <input type="checkbox" className="switch" checked={settings.descriptionPreview} onChange={(e) => updateSettings({ descriptionPreview: e.target.checked })} />
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
/** `?calendar=google` or `?calendar-error=…` after the provider sends the browser back. */
export function calendarReturn(): { ok?: string; error?: string } | null {
  const q = new URLSearchParams(location.search)
  const ok = q.get('calendar') ?? undefined
  const error = q.get('calendar-error') ?? undefined
  return ok || error ? { ok, error } : null
}
let returned = calendarReturn()

function useCalendarStatus() {
  const [list, setList] = useState<CalendarStatus[] | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(
    () =>
      api<{ providers: CalendarStatus[] }>('GET', '/api/calendar')
        .then((r) => {
          setList(r.providers)
          setError('')
        })
        .catch((e: Error) => setError(e.message)),
    [],
  )
  useEffect(() => void load(), [load])
  return { list, error, load }
}

const when = (iso?: string) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '')

function statusLine(st: CalendarStatus | undefined, loading: boolean): string {
  if (!st) return loading ? 'Checking…' : 'Status unknown'
  if (st.connected) return `Connected${st.account ? ` as ${st.account}` : ''}${st.lastSyncAt ? ` · updated ${when(st.lastSyncAt)}` : ''}`
  if (!st.configured) return 'Not available yet: the sign-in app is not registered'
  return 'Not connected'
}

function Calendars() {
  const { state } = useStore()
  const settings = settingsOf(state)
  const { list, error, load } = useCalendarStatus()
  const [busy, setBusy] = useState('')
  const [apple, setApple] = useState(false)
  const [note, setNote] = useState(() => {
    const r = returned
    returned = null
    return r?.error ? `Could not connect: ${r.error}` : r?.ok ? `${PROVIDERS.find((p) => p.id === r.ok)?.name ?? 'Calendar'} is connected. Dates are being written to its “Blade Notes” calendar.` : ''
  })
  const run = async (label: string, job: () => Promise<unknown>) => {
    setBusy(label)
    setNote('')
    try {
      await job()
      await load()
    } catch (e) {
      setNote((e as Error).message)
    } finally {
      setBusy('')
    }
  }
  const connect = (p: CalendarProvider) => {
    if (p === 'apple') return setApple(!apple)
    void run(p, async () => location.assign((await api<{ url: string }>('POST', '/api/calendar/connect', { provider: p })).url))
  }
  const anyConnected = list?.some((x) => x.connected)
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

      {note && <p className="notice" role="status">{note}</p>}
      {error && <p className="notice warn" role="status">Could not read the calendar connections: {error}</p>}
      <div className="provider-grid" role="radiogroup" aria-label="Default calendar">
        {PROVIDERS.map((p) => {
          const on = settings.defaultCalendar === p.id
          const st = list?.find((x) => x.provider === p.id)
          return (
            <div key={p.id} className={on ? 'provider-card on' : 'provider-card'}>
              <div className="provider-top">
                <ProviderMark id={p.id} />
                {on && <span className="badge"><Check size={12} aria-hidden /> Default</span>}
              </div>
              <strong>{p.name}</strong>
              <small>{p.detail}</small>
              <span className={st?.lastError ? 'provider-status warn' : 'provider-status'}>
                <span className={st?.connected ? 'status-dot on' : 'status-dot'} /> {statusLine(st, !error)}
              </span>
              {st?.lastError && <small className="warn-text">Last write failed: {st.lastError}</small>}
              <div className="provider-actions">
                <button type="button" role="radio" aria-checked={on} className={on ? 'btn on' : 'btn'} onClick={() => updateSettings({ defaultCalendar: on ? null : p.id })}>
                  {on ? 'Default' : 'Use for all'}
                </button>
                {st?.connected ? (
                  <button type="button" className="btn" disabled={!!busy} onClick={() => confirm(`Disconnect ${p.name}? Dates already written stay in it.`) && void run(p.id, () => api('POST', '/api/calendar/disconnect', { provider: p.id }))}>
                    Disconnect
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn"
                    disabled={!!busy || !st?.configured || (isDesktop && p.id !== 'apple')}
                    title={isDesktop && p.id !== 'apple' ? 'Connect once from a web browser; it then works on every device' : undefined}
                    aria-expanded={p.id === 'apple' ? apple : undefined}
                    onClick={() => connect(p.id)}
                  >
                    {busy === p.id ? 'Connecting…' : 'Connect'}
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
      {apple && <AppleConnect busy={busy === 'apple'} onConnect={(username, password) => run('apple', () => api('POST', '/api/calendar/connect', { provider: 'apple', username, password }).then(() => setApple(false)))} />}
      {anyConnected && (
        <div className="setting">
          <span>
            <strong>Write every date again</strong>
            <small>For dates from before a calendar was connected, or after changing a space’s calendar.</small>
          </span>
          <button type="button" className="btn" disabled={!!busy} onClick={() => void run('resync', async () => {
            const r = await api<{ written: number; removed: number; failed?: number }>('POST', '/api/calendar/resync')
            setNote(`Wrote ${r.written}, removed ${r.removed}${r.failed ? `, ${r.failed} failed` : ''}.`)
          })}>
            {busy === 'resync' ? 'Writing…' : 'Sync now'}
          </button>
        </div>
      )}
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
      <p className="muted small">Each connected account gets its own “Blade Notes” calendar, so nothing else in it is touched. Dates go one way: moving an event in the calendar does not move it here.</p>
    </div>
  )
}

/** iCloud has no sign-in app: an app-specific password from appleid.apple.com does the job. */
function AppleConnect({ busy, onConnect }: { busy: boolean; onConnect: (username: string, password: string) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  return (
    <form className="apple-form" onSubmit={(e) => {
      e.preventDefault()
      onConnect(username.trim(), password.trim())
    }}>
      <p className="muted small">
        Make an app-specific password at <a href="https://account.apple.com" target="_blank" rel="noreferrer">account.apple.com</a> › Sign-In and Security › App-Specific Passwords. It is stored encrypted on the server and only used to write to a “Blade Notes” calendar.
      </p>
      <label className="stack-label">Apple ID<input className="field" type="email" autoComplete="username" required value={username} onChange={(e) => setUsername(e.target.value)} /></label>
      <label className="stack-label">App-specific password<input className="field" type="password" autoComplete="off" required placeholder="xxxx-xxxx-xxxx-xxxx" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
      <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Checking…' : 'Connect iCloud'}</button>
    </form>
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

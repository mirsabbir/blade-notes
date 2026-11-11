import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { Editor as TiptapEditor } from '@tiptap/react'
import { CalendarDays, ChevronLeft, ChevronRight, X } from 'lucide-react'
import { addDays, currentZone, isAllDay, localDay, localTime, stamp, ymd } from '@blade-notes/core'
import { fullDay, longDay, parseWhen, plainLabel, setElsewhere, type When } from './dates'
import { createEvent, settingsOf, spaceOf, ownerOf, update, useStore } from './store'
import { PROVIDERS } from './Settings'
import { dateQueryKey, lineTitle, removeChip, setChipAt, type DateQuery } from './schedule'

const WEEK = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

/** A month to pick a day from; Monday first, today marked, the chosen day filled. */
export function MiniCalendar({ selected, onPick }: { selected: string | null; onPick: (day: string) => void }) {
  const today = ymd(new Date())
  const [month, setMonth] = useState((selected ?? today).slice(0, 7))
  useEffect(() => setMonth((selected ?? today).slice(0, 7)), [selected]) // eslint-disable-line react-hooks/exhaustive-deps
  const first = new Date(`${month}-01T12:00:00Z`)
  const lead = (first.getUTCDay() + 6) % 7
  const days = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate()
  const shift = (n: number) => setMonth(new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + n, 1)).toISOString().slice(0, 7))
  const title = first.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })
  return (
    <div className="mcal">
      <div className="mcal-head">
        <strong>{title}</strong>
        <span>
          <button type="button" className="ghost" aria-label="Previous month" onMouseDown={(e) => e.preventDefault()} onClick={() => shift(-1)}><ChevronLeft size={15} aria-hidden /></button>
          <button type="button" className="ghost" aria-label="Next month" onMouseDown={(e) => e.preventDefault()} onClick={() => shift(1)}><ChevronRight size={15} aria-hidden /></button>
        </span>
      </div>
      <div className="mcal-grid" aria-hidden>{WEEK.map((d, i) => <span key={i} className="mcal-wd">{d}</span>)}</div>
      <div className="mcal-grid">
        {Array.from({ length: lead }, (_, i) => <span key={`b${i}`} />)}
        {Array.from({ length: days }, (_, i) => {
          const day = `${month}-${String(i + 1).padStart(2, '0')}`
          const cls = ['mcal-day', day < today && 'past', day === today && 'today', day === selected && 'on'].filter(Boolean).join(' ')
          return (
            <button key={day} type="button" className={cls} aria-label={fullDay(day)} aria-pressed={day === selected} onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(day)}>
              {i + 1}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** Fixed-position box under `rect` (above it when there is no room), kept inside the window. */
function Floating({ rect, width, children, label, boxRef }: { rect: DOMRect; width: number; children: ReactNode; label: string; boxRef?: React.RefObject<HTMLDivElement | null> }) {
  const own = useRef<HTMLDivElement>(null)
  const ref = boxRef ?? own
  const [pos, setPos] = useState({ left: rect.left, top: rect.bottom + 6 })
  useLayoutEffect(() => {
    const h = ref.current?.offsetHeight ?? 0
    const below = rect.bottom + 6
    const top = below + h > window.innerHeight - 8 && rect.top - h - 6 > 8 ? rect.top - h - 6 : below
    setPos({ left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), top })
  }, [rect, width, ref])
  return (
    <div ref={ref} className="floating" role="dialog" aria-label={label} style={{ left: pos.left, top: pos.top, width }}>
      {children}
    </div>
  )
}

/** The picker that opens after @: suggestions for what was typed, and a month to click. */
export function DatePicker({ editor, query, ownerId }: { editor: TiptapEditor; query: DateQuery; ownerId: string }) {
  const options = parseWhen(query.query)
  const [hi, setHi] = useState(0)
  useEffect(() => setHi(0), [query.query])
  const at = Math.min(hi, Math.max(options.length - 1, 0))
  // Typing on past a word that is no date: this @ was not meant as one.
  const hidden = options.length === 0 && /\s/.test(query.query)
  const time = /\d/.test(query.query) ? (options[0]?.time ?? null) : null

  const pick = (w: When) => {
    const storage = editor.storage.dateChip
    const typed = storage.title
    storage.title = null
    const when = stamp(w.day, w.time)
    const id = createEvent(ownerId, typed ?? lineTitle(editor, query), when, typed ? { customTitle: true } : {})
    const after = editor.state.doc.textBetween(query.to, Math.min(query.to + 1, editor.state.doc.content.size), ' ', ' ')
    editor
      .chain()
      .focus()
      .insertContentAt({ from: query.from, to: query.to }, [{ type: 'dateChip', attrs: { id, at: when } }, ...(after === ' ' ? [] : [{ type: 'text', text: ' ' }])])
      .run()
  }

  const latest = useRef({ options, at, pick, hidden })
  latest.current = { options, at, pick, hidden }
  useEffect(() => {
    const storage = editor.storage.dateChip
    storage.onKey = (e) => {
      const { options: o, at: a, pick: p, hidden: h } = latest.current
      if (h) return false
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        setHi(Math.max(0, Math.min(o.length - 1, a + (e.key === 'ArrowDown' ? 1 : -1))))
        return true
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        if (!o[a]) return false
        p(o[a]!)
        return true
      }
      if (e.key === 'Escape') {
        editor.view.dispatch(editor.state.tr.setMeta(dateQueryKey, { dismiss: query.from }))
        return true
      }
      return false
    }
    return () => {
      storage.onKey = null
    }
  }, [editor, query.from])

  if (hidden) return null
  const rect = editor.view.coordsAtPos(query.from)
  const anchor = new DOMRect(rect.left, rect.top, 1, rect.bottom - rect.top)
  return (
    <Floating rect={anchor} width={540} label="Pick a date">
      <div className="picker">
        <div className="picker-list">
          <div className="picker-head">{query.query.trim() ? `Dates for “${query.query.trim()}”` : 'Schedule this line'}</div>
          {options.map((o, i) => (
            <button key={o.day} type="button" className={i === at ? 'picker-opt on' : 'picker-opt'} aria-pressed={i === at} onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => setHi(i)} onClick={() => pick(o)}>
              <span>
                {longDay(o.day)}
                {o.label && <small>{o.label}</small>}
              </span>
              <span className="picker-side">{o.time ?? 'All day'}</span>
            </button>
          ))}
          {options.length === 0 && <p className="muted small picker-none">No date in “{query.query.trim()}” yet. Keep typing, click a day, or press Esc to keep it as text.</p>}
          <div className="picker-keys"><kbd>↑</kbd><kbd>↓</kbd> choose <kbd>Enter</kbd> insert <kbd>Esc</kbd> keep as text</div>
        </div>
        <MiniCalendar selected={options[at]?.day ?? null} onPick={(day) => pick({ day, time, label: '' })} />
      </div>
    </Floating>
  )
}
/** The popup of a chip: day, time, title in the calendar, privacy, done, remove. */
export function ChipPopover({ editor, id, anchor, onClose }: { editor: TiptapEditor; id: string; anchor: HTMLElement; onClose: () => void }) {
  const { state } = useStore()
  const box = useRef<HTMLDivElement>(null)
  const item = state.items[id]
  useEffect(() => {
    const onDown = (e: PointerEvent) => !box.current?.contains(e.target as Node) && !anchor.contains(e.target as Node) && onClose()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [anchor, onClose])
  if (!item?.at) return null
  const at = item.at
  const day = localDay(at)
  const time = localTime(at)
  const setAt = (d: string, t: string | null) => {
    const next = stamp(d, t)
    update(id, { at: next, tz: currentZone() })
    setChipAt(editor, id, next)
  }
  const owner = ownerOf(state.items, id)
  const space = owner ? spaceOf(state.items, owner.id) : undefined
  const settings = settingsOf(state)
  const provider = space && space.id in settings.spaceCalendars ? settings.spaceCalendars[space.id] : settings.defaultCalendar
  const providerName = PROVIDERS.find((p) => p.id === provider)?.name
  const elsewhere = setElsewhere(at, item.tz, currentZone())
  const done = item.status === 'done'

  return (
    <Floating rect={anchor.getBoundingClientRect()} width={560} label="Date" boxRef={box}>
      <div className="picker">
        <div className="picker-list chip-form">
          <div className="picker-head">
            <span>{plainLabel(at)}{isAllDay(at) ? ', all day' : ''}</span>
            <button type="button" className="ghost" aria-label="Close" onClick={onClose}><X size={14} aria-hidden /></button>
          </div>
          {elsewhere && <p className="muted small">{elsewhere}; shown here in your time now ({currentZone().replace(/_/g, ' ')}).</p>}
          <label className="stack-label">
            Title in the calendar
            <input
              className="field"
              defaultValue={item.title}
              key={item.title}
              onBlur={(e) => {
                const v = e.target.value.trim()
                if (v && v !== item.title) update(id, { title: v, customTitle: true })
              }}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
          </label>
          {item.customTitle && (
            <button type="button" className="link-btn" onClick={() => update(id, { customTitle: false })}>Use the line’s text again</button>
          )}
          <div className="time-row">
            <label className="stack-label">
              Time
              <input type="time" className="field" value={time ?? ''} onChange={(e) => setAt(day, e.target.value || null)} />
            </label>
            <button type="button" className={time ? 'chip' : 'chip on'} aria-pressed={!time} onClick={() => setAt(day, time ? null : '09:00')}>All day</button>
            <button type="button" className="chip" onClick={() => setAt(addDays(day, 1), time)}>+1 day</button>
            <button type="button" className="chip" onClick={() => setAt(addDays(day, 7), time)}>+1 week</button>
          </div>
          <div className="cal-target">
            <CalendarDays size={14} aria-hidden />
            <span>{providerName ? `Goes to ${providerName}${space ? ` (${space.title})` : ''}` : `No calendar for ${space ? `“${space.title}”` : 'this space'}; pick one in Settings › Calendars`}</span>
          </div>
          <label className="check-row">
            <input type="checkbox" checked={!!item.private} onChange={(e) => update(id, { private: e.target.checked })} />
            <span>Keep the text out of the calendar<small>It shows “Blade Notes reminder” and a link back.</small></span>
          </label>
          <div className="row-actions">
            <button type="button" className="btn" onClick={() => update(id, { status: done ? 'todo' : 'done' })}>{done ? 'Mark not done' : 'Mark done'}</button>
            <button
              type="button"
              className="btn warn-text"
              onClick={() => {
                removeChip(editor, id)
                update(id, { deletedAt: new Date().toISOString() })
                onClose()
              }}
            >
              Remove date
            </button>
          </div>
        </div>
        <MiniCalendar selected={day} onPick={(d) => setAt(d, time)} />
      </div>
    </Floating>
  )
}

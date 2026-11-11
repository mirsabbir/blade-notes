import { CalendarCheck, Circle, CircleCheck, PanelLeftClose } from 'lucide-react'
import { dayDiff, localDay, localTime, sortKey, ymd, type Item } from '@blade-notes/core'
import { longDay, relDay, shortDay } from './dates'
import { childrenOf, ownerOf, spaceOf, update, useStore } from './store'

/** One dated thing: a date chip's event, or a task's due date. */
export interface Entry {
  id: string
  /** The note or task to open. */
  ownerId: string
  title: string
  at: string
  done: boolean
  space?: Item
  owner?: Item
  kind: 'event' | 'task'
}

/** Everything with a date that is still open, plus what was done today or later (struck through). */
export function entriesOf(items: { [id: string]: Item }, today = ymd(new Date())): Entry[] {
  const out: Entry[] = []
  for (const it of Object.values(items)) {
    if (it.deletedAt) continue
    const isEvent = it.type === 'event' && it.at
    const isTask = it.type === 'task' && it.due
    if (!isEvent && !isTask) continue
    const owner = isEvent ? ownerOf(items, it.id) : it
    if (!owner || owner.deletedAt) continue
    const at = isEvent ? it.at! : it.due!.slice(0, 10)
    const done = it.status === 'done'
    if (done && localDay(at) < today) continue
    out.push({ id: it.id, ownerId: owner.id, title: it.title, at, done, owner, space: spaceOf(items, owner.id), kind: isEvent ? 'event' : 'task' })
  }
  return out.sort((a, b) => sortKey(a.at) - sortKey(b.at))
}

/** How many open entries are due today or late: the number on the Library's Agenda row. */
export const dueNow = (entries: Entry[], today = ymd(new Date())) => entries.filter((e) => !e.done && localDay(e.at) <= today).length

function dayHeading(day: string, today: string, long: boolean): string {
  const d = dayDiff(day, today)
  if (d < 0) return 'Overdue'
  if (!long) return relDay(day, today)
  return d === 0 ? `Today · ${shortDay(day)}` : d === 1 ? `Tomorrow · ${shortDay(day)}` : longDay(day)
}

/**
 * The Agenda blade: dates typed with @ and task due dates, grouped by space (or by day),
 * in the zone the device is in now. A row opens its note or task, and the date flashes there.
 */
export function AgendaBlade({ group, onGroup, onOpen, onFold, activeId }: {
  group: 'space' | 'day'
  onGroup: (g: 'space' | 'day') => void
  onOpen: (e: Entry) => void
  onFold: () => void
  activeId?: string
}) {
  const { state } = useStore()
  const today = ymd(new Date())
  const entries = entriesOf(state.items, today)
  const open = entries.filter((e) => !e.done).length
  const spaces = childrenOf(state.items, null)
  const sections: { key: string; title?: string; color?: string; count?: number; list: Entry[] }[] =
    group === 'space'
      ? [...spaces.map((s) => ({ key: s.id, title: s.title, color: s.color, list: entries.filter((e) => e.space?.id === s.id) }))]
          .filter((s) => s.list.length)
          .map((s) => ({ ...s, count: s.list.filter((e) => !e.done).length }))
      : [{ key: 'all', list: entries }]

  return (
    <section className="blade agenda" aria-label="Agenda">
      <div className="blade-head">
        <CalendarCheck size={16} aria-hidden className="ico" />
        <div className="blade-titles">
          <h2>Agenda</h2>
          <p>{open === 0 ? 'Nothing open' : `${open} open`} · {shortDay(today)} today</p>
        </div>
        <button type="button" className="ghost" onClick={onFold} aria-label="Close the Agenda" title="Close the Agenda">
          <PanelLeftClose size={16} aria-hidden />
        </button>
      </div>
      <div className="segmented agenda-seg" role="radiogroup" aria-label="Group the Agenda">
        {(['space', 'day'] as const).map((g) => (
          <button key={g} type="button" role="radio" aria-checked={group === g} className={group === g ? 'seg on' : 'seg'} onClick={() => onGroup(g)}>
            {g === 'space' ? 'By space' : 'By day'}
          </button>
        ))}
      </div>
      <div className="blade-body">
        {entries.length === 0 && (
          <p className="empty">No dates yet. Type <kbd>@</kbd> at the start of a word in any note or task, for example <kbd>@sun 3pm</kbd>, or give a task a due date.</p>
        )}
        {sections.map((s) => {
          let last = ''
          return (
            <div key={s.key}>
              {s.title && (
                <div className="ag-space">
                  <span className="dot" style={{ background: s.color ?? 'var(--primary)' }} />
                  <span>{s.title}</span>
                  <span className="meta">{s.count} open</span>
                </div>
              )}
              {s.list.map((e) => {
                const heading = dayHeading(localDay(e.at), today, group === 'day')
                const show = heading !== last
                last = heading
                return (
                  <div key={e.id}>
                    {show && <div className={`ag-day${group === 'day' ? ' top' : ''}${heading === 'Overdue' ? ' late' : ''}`}>{heading}</div>}
                    <AgendaRow entry={e} today={today} showSpace={group === 'day'} active={activeId === e.ownerId} onOpen={() => onOpen(e)} />
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
      <p className="ag-foot">Times are shown where you are now. A row opens its note or task.</p>
    </section>
  )
}

function AgendaRow({ entry: e, today, showSpace, active, onOpen }: { entry: Entry; today: string; showSpace: boolean; active: boolean; onOpen: () => void }) {
  const day = localDay(e.at)
  const late = !e.done && day < today
  const time = late ? relDay(day, today) : (localTime(e.at) ?? 'All day')
  const where = e.kind === 'task' ? 'Task due date' : `in ${e.owner?.title ?? 'a note'}`
  return (
    <div className={`row ag-row${active ? ' active' : ''}${e.done ? ' done' : ''}`}>
      <button
        type="button"
        className="check"
        aria-pressed={e.done}
        aria-label={`${e.done ? 'Mark as not done' : 'Mark as done'}: ${e.title}`}
        onClick={() => update(e.id, { status: e.done ? 'todo' : 'done' })}
      >
        {e.done ? <CircleCheck size={18} className="done-ico" aria-hidden /> : <Circle size={18} aria-hidden />}
      </button>
      <button type="button" className="row-main" onClick={onOpen}>
        <span className="name">
          {e.title}
          <small>
            {showSpace && e.space && <span className="dot sm" style={{ background: e.space.color ?? 'var(--primary)' }} />}
            {showSpace && e.space ? `${e.space.title} · ` : ''}
            {where}
          </small>
        </span>
        <span className={late ? 'due today' : 'meta'}>{time}</span>
      </button>
    </div>
  )
}

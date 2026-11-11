import { createHash } from 'node:crypto'
import { addDays, deepLink, isAllDay, type CalendarProvider, type Item, type Settings } from '@blade-notes/core'

/** One calendar event: everything a provider needs, and nothing from the note's text. */
export interface Entry {
  /** The item's id: an event's, or a task's (for its due date). */
  id: string
  title: string
  /** `2026-11-15` (all day) or an instant with offset; see core when.ts. */
  at: string
  tz: string
  description: string
}

const HALF_HOUR = 30 * 60_000

/** The calendar entry an item stands for, or null when it belongs on no calendar. */
export function entryOf(item: Item, site: string): Entry | null {
  if (item.deletedAt) return null
  const done = item.status === 'done' ? '✓ ' : ''
  if (item.type === 'event' && item.at && item.parentId) {
    const title = item.private ? 'Blade Notes reminder' : item.title
    const description = `Open in Blade Notes: ${deepLink(site, item.parentId, item.id)}`
    return { id: item.id, title: done + title, at: item.at, tz: item.tz ?? 'UTC', description }
  }
  if (item.type === 'task' && item.due) {
    // A due date is a day, even when an older client stored a time with it.
    const description = `Open in Blade Notes: ${deepLink(site, item.id)}`
    return { id: item.id, title: done + item.title, at: item.due.slice(0, 10), tz: 'UTC', description }
  }
  return null
}

/** Dates for all day (end exclusive, as every calendar wants), else instants 30 minutes apart. */
export function span(e: Entry): { allDay: boolean; start: string; end: string } {
  if (isAllDay(e.at)) return { allDay: true, start: e.at, end: addDays(e.at, 1) }
  return { allDay: false, start: e.at, end: new Date(Date.parse(e.at) + HALF_HOUR).toISOString() }
}

/** Changes only when something a calendar shows changes; devices re-push items often. */
export const hash = (e: Entry): string =>
  createHash('sha256').update(JSON.stringify([e.title, e.at, e.tz, e.description])).digest('base64url').slice(0, 16)

/** A space's own choice when it made one (null = no calendar), else the default. */
export function chooseProvider(settings: Settings, spaceId: string | null): CalendarProvider | null {
  if (spaceId && spaceId in settings.spaceCalendars) return settings.spaceCalendars[spaceId] ?? null
  return settings.defaultCalendar
}

/** The space an item sits in, walking up its parents (at most 50, in case of a loop). */
export async function spaceOf(item: Item, get: (id: string) => Promise<Item | undefined>): Promise<string | null> {
  let cur: Item | undefined = item
  for (let hops = 0; cur && hops < 50; hops++) {
    if (cur.type === 'space') return cur.id
    cur = cur.parentId ? await get(cur.parentId) : undefined
  }
  return null
}

/** Whether a change can touch a calendar at all: notes, folders and descriptions never do. */
export const relevant = (i: Item | undefined): boolean => !!i && (i.type === 'event' || (i.type === 'task' && !!i.due))

import { addDays, dayDiff, isAllDay, localDay, localTime, ymd } from '@blade-notes/core'

/**
 * What you type after @, and how dates read on screen. Everything is in the device's zone
 * at the moment of the call (see core when.ts), so labels follow you when you travel.
 */
export interface When {
  /** YYYY-MM-DD, local. */
  day: string
  /** HH:MM, local; null = all day. */
  time: string | null
  /** "Tomorrow", "Next week", …; empty when the date says it all. */
  label: string
}

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const pad = (n: number) => String(n).padStart(2, '0')

/** Splits a trailing time off: "sun 3pm" → ["sun", "15:00"]. Needs am/pm, a colon or "at". */
function takeTime(q: string): [string, string | null] {
  const m = /(?:^|\s)(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/.exec(q) ?? /(?:^|\s)(?:at\s*)?(\d{1,2}):(\d{2})$/.exec(q) ?? /(?:^|\s)at\s+(\d{1,2})()$/.exec(q)
  if (!m) return [q, null]
  let h = Number(m[1])
  const min = Number(m[2] || 0)
  if (m[3] === 'pm' && h < 12) h += 12
  if (m[3] === 'am' && h === 12) h = 0
  if (h > 23 || min > 59) return [q, null]
  return [q.slice(0, m.index).trim(), `${pad(h)}:${pad(min)}`]
}

/** The next `weekday` (0 = Sunday) from `today`, today itself included. */
function next(today: string, weekday: number): string {
  const now = new Date(`${today}T12:00:00Z`).getUTCDay()
  return addDays(today, (weekday - now + 7) % 7)
}

/** Day `d` of month `m` (0-based), this year or next if it has passed. */
function dayOfMonth(today: string, d: number, m: number): string | null {
  const year = Number(today.slice(0, 4))
  for (const y of [year, year + 1]) {
    const t = new Date(Date.UTC(y, m, d))
    if (t.getUTCDate() !== d || t.getUTCMonth() !== m) return null
    const s = t.toISOString().slice(0, 10)
    if (s >= today) return s
  }
  return null
}

/** The next date with day number `d`: this month, or the month after if it has passed. */
function nextDayNumbered(today: string, d: number): string | null {
  const y = Number(today.slice(0, 4))
  const m = Number(today.slice(5, 7)) - 1
  for (const k of [0, 1, 2]) {
    const t = new Date(Date.UTC(y, m + k, d))
    if (t.getUTCDate() === d && t.toISOString().slice(0, 10) >= today) return t.toISOString().slice(0, 10)
  }
  return null
}

const weekday = (w: string) => (w.length >= 2 ? DAYS.findIndex((d) => d.startsWith(w)) : -1)
const month = (w: string) => (w.length >= 3 ? MONTHS.findIndex((m) => m.startsWith(w)) : -1)

/** Suggestions for the text after @, best first, at most five. Empty when nothing reads as a date. */
export function parseWhen(query: string, today = ymd(new Date())): When[] {
  const [rest, time] = takeTime(query.trim().toLowerCase().replace(/\s+/g, ' '))
  const out: When[] = []
  const add = (day: string | null, label: string) => {
    if (day && !out.some((o) => o.day === day)) out.push({ day, time, label })
  }
  if (!rest) {
    add(today, 'Today')
    if (!time) {
      add(addDays(today, 1), 'Tomorrow')
      add(next(today, 6), 'This weekend')
      add(addDays(next(today, 1), next(today, 1) === today ? 7 : 0), 'Next week')
    }
    return out
  }
  if (rest.length >= 2 && 'today'.startsWith(rest)) add(today, 'Today')
  if ((rest.length >= 2 && 'tomorrow'.startsWith(rest)) || rest === 'tmr' || rest === 'tmrw') add(addDays(today, 1), 'Tomorrow')
  if (rest.length >= 3 && 'weekend'.startsWith(rest)) add(next(today, 6), 'This weekend')
  let m = /^next\s*([a-z]*)$/.exec(rest)
  if (m) {
    const i = weekday(m[1]!)
    if (i >= 0) add(addDays(next(today, i), 7), `Next ${cap(DAYS[i]!)}`)
    if (!m[1] || 'week'.startsWith(m[1])) add(addDays(next(today, 1), next(today, 1) === today ? 7 : 0), 'Next week')
  } else if (weekday(rest) >= 0) {
    const i = weekday(rest)
    const day = next(today, i)
    add(day, day === today ? 'Today' : `This ${cap(DAYS[i]!)}`)
  }
  if ((m = /^in\s*(\d{1,3})\s*(d|days?|w|weeks?)?$/.exec(rest))) {
    const n = Number(m[1])
    const w = m[2]?.startsWith('w')
    add(addDays(today, n * (w ? 7 : 1)), `In ${n} ${w ? 'week' : 'day'}${n === 1 ? '' : 's'}`)
  }
  if ((m = /^(\d{1,2})(?:st|nd|rd|th)?\s*([a-z]{3,})$/.exec(rest))) add(dayOfMonth(today, Number(m[1]), month(m[2]!)), '')
  if ((m = /^([a-z]{3,})\s*(\d{1,2})$/.exec(rest))) add(dayOfMonth(today, Number(m[2]), month(m[1]!)), '')
  if ((m = /^(\d{1,2})[/.](\d{1,2})$/.exec(rest))) add(dayOfMonth(today, Number(m[1]), Number(m[2]) - 1), '')
  if ((m = /^(\d{1,2})$/.exec(rest))) add(nextDayNumbered(today, Number(m[1])), '')
  return out.slice(0, 5)
}

const MON = MONTHS.map((m) => cap(m.slice(0, 3)))
const parts = (day: string) => {
  const d = new Date(`${day}T12:00:00Z`)
  return { w: cap(DAYS[d.getUTCDay()]!), d: d.getUTCDate(), m: MON[d.getUTCMonth()]!, y: d.getUTCFullYear() }
}

/** "Sun 15 Nov". */
export const shortDay = (day: string) => {
  const p = parts(day)
  return `${p.w.slice(0, 3)} ${p.d} ${p.m}`
}
/** "Sunday, 15 Nov". */
export const longDay = (day: string) => {
  const p = parts(day)
  return `${p.w}, ${p.d} ${p.m}`
}
/** "Sun 15 Nov 2026". */
export const fullDay = (day: string) => `${shortDay(day)} ${parts(day).y}`

/** Today, Tomorrow, Yesterday, or the short day. */
export function relDay(day: string, today = ymd(new Date())): string {
  const d = dayDiff(day, today)
  return d === 0 ? 'Today' : d === 1 ? 'Tomorrow' : d === -1 ? 'Yesterday' : shortDay(day)
}

/** What a chip shows: "Today · 16:00", "Sun 15 Nov". */
export function chipLabel(at: string, today = ymd(new Date())): string {
  const t = localTime(at)
  return t ? `${relDay(localDay(at), today)} · ${t}` : relDay(localDay(at), today)
}

/** What a copy of the chip says anywhere else: "Sun 15 Nov 2026, 10:00". */
export function plainLabel(at: string): string {
  const t = localTime(at)
  return t ? `${fullDay(localDay(at))}, ${t}` : fullDay(localDay(at))
}

/**
 * For a time set in another zone: "Set as 09:00 in Asia/Dhaka". Empty when it was set here,
 * or when this zone shows the same wall time.
 */
export function setElsewhere(at: string, tz: string | undefined, here: string): string {
  if (!tz || tz === here || isAllDay(at)) return ''
  const there = new Date(at).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false })
  return there === localTime(at) ? '' : `Set as ${there} in ${tz.replace(/_/g, ' ')}`
}

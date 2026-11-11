/**
 * Dates on events (and task due dates). Two kinds, and only two:
 * - all day, `2026-11-15`: the same calendar day wherever you are, like a birthday;
 * - timed, `2026-11-15T09:00:00+06:00`: one moment, written with the offset of the device that
 *   set it and always shown in the zone the device is in now. 9:00 set in Dhaka (UTC+6) shows
 *   as 8:30 in India (UTC+5:30), because it is the same moment.
 * Everything here reads the device's zone at the time of the call, never a cached one.
 */

const pad = (n: number) => String(n).padStart(2, '0')

export const isAllDay = (at: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(at)

/** YYYY-MM-DD of `d` in the device's current zone. */
export const ymd = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** `d` as local wall time plus the zone's offset at that moment: `2026-11-15T09:00:00+06:00`. */
export function withOffset(d: Date): string {
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const a = Math.abs(off)
  return `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:00${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`
}

/** A date chip's value: all day without `time` (HH:MM), else that wall time here and now. */
export function stamp(day: string, time: string | null): string {
  if (!time) return day
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  const [h, mi] = time.split(':').map(Number) as [number, number]
  return withOffset(new Date(y, m - 1, d, h, mi))
}

/** The local day `at` falls on, in the device's zone now. */
export const localDay = (at: string): string => (isAllDay(at) ? at : ymd(new Date(at)))

/** HH:MM of `at` in the device's zone now; null for all day. */
export function localTime(at: string): string | null {
  if (isAllDay(at)) return null
  const d = new Date(at)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Whole days from `from` to `to` (both YYYY-MM-DD). */
export function dayDiff(to: string, from: string): number {
  const t = (s: string) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)))
  return Math.round((t(to) - t(from)) / 86_400_000)
}

export function addDays(day: string, n: number): string {
  const d = new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)) + n))
  return d.toISOString().slice(0, 10)
}

/** For sorting: the moment; an all-day date counts as the start of its local day. */
export function sortKey(at: string): number {
  if (!isAllDay(at)) return Date.parse(at)
  return new Date(Number(at.slice(0, 4)), Number(at.slice(5, 7)) - 1, Number(at.slice(8, 10))).getTime()
}

/** The device's IANA zone now, e.g. `Asia/Kolkata`. */
export const currentZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone

/** The link a calendar event carries back to its note or task; `#<eventId>` makes the chip flash. */
export const deepLink = (site: string, ownerId: string, eventId?: string): string =>
  `${site.replace(/\/$/, '')}/t/${ownerId}${eventId ? `#${eventId}` : ''}`

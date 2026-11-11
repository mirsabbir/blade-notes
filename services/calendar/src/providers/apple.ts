import { span, type Entry } from '../entries'
import { CalendarError, request } from './http'
import type { CalendarApi } from './index'

const ROOT = 'https://caldav.icloud.com/'
const XML = 'application/xml; charset=utf-8'
const PRINCIPAL = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>'
const HOME = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>'
const MAKE =
  '<?xml version="1.0"?><c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:set><d:prop>' +
  '<d:displayname>Blade Notes</d:displayname><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>' +
  '</d:prop></d:set></c:mkcalendar>'

export const basic = (user: string, pass: string): string => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`

/** The first href inside `<prop>`, whatever namespace prefix the server picked. */
export function hrefIn(xml: string, prop: string): string | null {
  const m = new RegExp(`<(?:[\\w-]+:)?${prop}\\b[^>]*>\\s*<(?:[\\w-]+:)?href\\b[^>]*>([^<]+)<`, 'i').exec(xml)
  return m?.[1]?.trim() ?? null
}

/**
 * Finds the account's calendars and makes a "Blade Notes" calendar there (405 = it exists).
 * Returns its URL. Wrong credentials throw a CalendarError with status 401.
 */
export async function appleCalendar(auth: string): Promise<string> {
  const find = async (url: string, body: string, prop: string) => {
    const res = await request('PROPFIND', url, auth, { body, type: XML, headers: { depth: '0' } })
    const href = hrefIn(res.text, prop)
    if (!href) throw new CalendarError('iCloud did not say where your calendars are. Try again later.', 502)
    return new URL(href, url).href
  }
  const principal = await find(ROOT, PRINCIPAL, 'current-user-principal')
  const home = await find(principal, HOME, 'calendar-home-set')
  const cal = new URL('blade-notes/', home.endsWith('/') ? home : `${home}/`).href
  await request('MKCALENDAR', cal, auth, { body: MAKE, type: XML, ok: [405] })
  return cal
}

const stampOf = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '')
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')

/** Splits a content line into ≤ 75-octet pieces without cutting a UTF-8 character (RFC 5545 §3.1). */
function fold(line: string): string {
  const parts: string[] = []
  let cur = ''
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch) > (parts.length ? 74 : 75)) {
      parts.push(cur)
      cur = ''
    }
    cur += ch
  }
  return [...parts, cur].join('\r\n ')
}

export function ics(e: Entry, now = new Date()): string {
  const s = span(e)
  const when = s.allDay
    ? [`DTSTART;VALUE=DATE:${s.start.replace(/-/g, '')}`, `DTEND;VALUE=DATE:${s.end.replace(/-/g, '')}`]
    : [`DTSTART:${stampOf(new Date(s.start).toISOString())}`, `DTEND:${stampOf(s.end)}`]
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Blade Notes//EN', 'BEGIN:VEVENT',
    `UID:${e.id}`, `DTSTAMP:${stampOf(now.toISOString())}`, ...when,
    `SUMMARY:${esc(e.title)}`, `DESCRIPTION:${esc(e.description)}`,
    'END:VEVENT', 'END:VCALENDAR',
  ]
  return lines.map(fold).join('\r\n') + '\r\n'
}

/** One `.ics` per entry, named by its id, so writing again replaces it. */
export const apple: CalendarApi = {
  async upsert(auth, cal, entry) {
    await request('PUT', `${cal}${entry.id}.ics`, auth, { body: ics(entry), type: 'text/calendar; charset=utf-8' })
    return entry.id
  },
  async remove(auth, cal, id) {
    await request('DELETE', `${cal}${id}.ics`, auth, { ok: [404] })
  },
}

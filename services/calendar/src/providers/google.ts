import { createHash } from 'node:crypto'
import { span, type Entry } from '../entries'
import { enc, request } from './http'
import type { OAuthCalendarApi } from './index'

const BASE = 'https://www.googleapis.com/calendar/v3/calendars'

/** Google event ids are base32hex (0-9, a-v): a UUID without its dashes already is one. */
export const googleId = (id: string): string =>
  /^[0-9a-f-]{5,}$/.test(id) ? id.replace(/-/g, '') : createHash('sha256').update(id).digest('hex').slice(0, 32)

export function googleEvent(e: Entry) {
  const s = span(e)
  const at = (v: string) => (s.allDay ? { date: v } : { dateTime: v, timeZone: e.tz })
  return { summary: e.title, description: e.description, start: at(s.start), end: at(s.end), status: 'confirmed' }
}

/** Needs only the calendar.app.created scope: the app sees nothing but the calendar it made. */
export const google: OAuthCalendarApi = {
  async calendar(auth, previousId) {
    if (previousId && (await request('GET', `${BASE}/${enc(previousId)}`, auth, { ok: [403, 404] })).status === 200) return previousId
    return (await request('POST', BASE, auth, { json: { summary: 'Blade Notes' } })).json().id
  },
  // The id is ours, so writing is idempotent; PUT also brings back an event deleted in Google.
  async upsert(auth, cal, entry) {
    const id = googleId(entry.id)
    const url = `${BASE}/${enc(cal)}/events`
    const json = { id, ...googleEvent(entry) }
    if ((await request('PUT', `${url}/${id}`, auth, { json, ok: [404] })).status === 404) await request('POST', url, auth, { json })
    return id
  },
  async remove(auth, cal, id) {
    await request('DELETE', `${BASE}/${enc(cal)}/events/${id}`, auth, { ok: [404, 410] })
  },
}

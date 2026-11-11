import { span, type Entry } from '../entries'
import { enc, request } from './http'
import type { OAuthCalendarApi } from './index'

const ME = 'https://graph.microsoft.com/v1.0/me'

/** Graph wants a wall time plus a zone, never an offset; UTC keeps the instant exact. */
export function graphEvent(e: Entry) {
  const s = span(e)
  const at = (v: string) => ({ dateTime: s.allDay ? `${v}T00:00:00` : new Date(v).toISOString().slice(0, 19), timeZone: 'UTC' })
  return { subject: e.title, body: { contentType: 'text', content: e.description }, isAllDay: s.allDay, start: at(s.start), end: at(s.end) }
}

export const microsoft: OAuthCalendarApi = {
  async calendar(auth, previousId) {
    if (previousId && (await request('GET', `${ME}/calendars/${enc(previousId)}`, auth, { ok: [404] })).status === 200) return previousId
    const made = await request('POST', `${ME}/calendars`, auth, { json: { name: 'Blade Notes' }, ok: [409] })
    if (made.status !== 409) return made.json().id
    // Made by an earlier connection whose record is gone: find it by name.
    const list = await request('GET', `${ME}/calendars?$filter=${enc("name eq 'Blade Notes'")}`, auth)
    return list.json().value![0]!.id
  },
  async upsert(auth, cal, entry, externalId) {
    const json = graphEvent(entry)
    if (externalId && (await request('PATCH', `${ME}/events/${enc(externalId)}`, auth, { json, ok: [404] })).status !== 404) return externalId
    return (await request('POST', `${ME}/calendars/${enc(cal)}/events`, auth, { json })).json().id
  },
  async remove(auth, _cal, id) {
    await request('DELETE', `${ME}/events/${enc(id)}`, auth, { ok: [404] })
  },
}

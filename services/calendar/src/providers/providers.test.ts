import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Entry } from '../entries'
import { appleCalendar, hrefIn, ics } from './apple'
import { google, googleEvent, googleId } from './google'
import { graphEvent } from './microsoft'

const timed: Entry = { id: '0b0e8c1a-5f2d-4c3e-9a77-1234567890ab', title: 'Book; the, appointment', at: '2026-11-15T10:00:00+06:00', tz: 'Asia/Dhaka', description: 'Open in Blade Notes: https://n.example/t/t1#e1' }
const allDay: Entry = { ...timed, at: '2026-11-15', tz: 'UTC' }

function answer(status: number, body = '', type = 'application/json') {
  return new Response(status === 204 ? null : body, { status, headers: { 'content-type': type } })
}
afterEach(() => vi.unstubAllGlobals())

describe('Google', () => {
  it('uses the UUID without dashes as the event id', () => {
    expect(googleId(timed.id)).toBe('0b0e8c1a5f2d4c3e9a771234567890ab')
    expect(googleId('Not_Hex')).toMatch(/^[0-9a-f]{32}$/)
  })

  it('writes dates for all day and moments with the zone otherwise', () => {
    expect(googleEvent(allDay)).toMatchObject({ start: { date: '2026-11-15' }, end: { date: '2026-11-16' } })
    expect(googleEvent(timed)).toMatchObject({ start: { dateTime: '2026-11-15T10:00:00+06:00', timeZone: 'Asia/Dhaka' } })
  })

  it('inserts when the update finds no event', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(answer(404, '{}')).mockResolvedValueOnce(answer(200, '{"id":"x"}'))
    vi.stubGlobal('fetch', fetch)
    const id = await google.upsert('Bearer t', 'cal@group', timed)
    expect(id).toBe(googleId(timed.id))
    expect(fetch.mock.calls.map((c) => c[1].method)).toEqual(['PUT', 'POST'])
    expect(fetch.mock.calls[1]![0]).toBe('https://www.googleapis.com/calendar/v3/calendars/cal%40group/events')
    expect(JSON.parse(fetch.mock.calls[1]![1].body)).toMatchObject({ id, summary: timed.title })
  })

  it('reports a refusal in words, not retried', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(403, '{}')))
    await expect(google.upsert('Bearer t', 'c', timed)).rejects.toMatchObject({ status: 403, message: expect.stringContaining('Connect it again') })
  })
})

describe('Microsoft', () => {
  it('sends wall times in UTC, never offsets', () => {
    expect(graphEvent(timed)).toMatchObject({ isAllDay: false, start: { dateTime: '2026-11-15T04:00:00', timeZone: 'UTC' }, end: { dateTime: '2026-11-15T04:30:00' } })
    expect(graphEvent(allDay)).toMatchObject({ isAllDay: true, start: { dateTime: '2026-11-15T00:00:00' }, end: { dateTime: '2026-11-16T00:00:00' } })
  })
})

describe('iCloud', () => {
  it('writes an all-day and a timed (UTC) VEVENT with escaped text and CRLF lines', () => {
    const now = new Date('2026-11-11T08:00:00Z')
    const day = ics(allDay, now)
    expect(day).toContain('DTSTART;VALUE=DATE:20261115\r\nDTEND;VALUE=DATE:20261116\r\n')
    expect(day).toContain('SUMMARY:Book\; the\\, appointment\r\n')
    expect(day).toContain('DTSTAMP:20261111T080000Z')
    expect(ics(timed, now)).toContain('DTSTART:20261115T040000Z\r\nDTEND:20261115T043000Z\r\n')
  })

  it('folds long lines at 75 octets without splitting a character', () => {
    const out = ics({ ...allDay, title: 'বাংলা '.repeat(30) })
    for (const line of out.split('\r\n')) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75)
    expect(out.split('\r\n').map((l, i) => (i && l.startsWith(' ') ? l.slice(1) : `\n${l}`)).join('')).toContain(`SUMMARY:${'বাংলা '.repeat(30)}`)
  })

  it('reads hrefs whatever the namespace prefix', () => {
    expect(hrefIn('<D:current-user-principal><D:href>/123/principal/</D:href></D:current-user-principal>', 'current-user-principal')).toBe('/123/principal/')
    expect(hrefIn('<calendar-home-set xmlns="urn:ietf:params:xml:ns:caldav"><href xmlns="DAV:">https://p42-caldav.icloud.com/123/calendars/</href></calendar-home-set>', 'calendar-home-set'))
      .toBe('https://p42-caldav.icloud.com/123/calendars/')
  })

  it('finds the home and makes the Blade Notes calendar (405 = already there)', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(answer(207, '<d:multistatus xmlns:d="DAV:"><d:response><d:propstat><d:prop><d:current-user-principal><d:href>/123/principal/</d:href></d:current-user-principal></d:prop></d:propstat></d:response></d:multistatus>', 'application/xml'))
      .mockResolvedValueOnce(answer(207, '<multistatus><response><propstat><prop><calendar-home-set><href>https://p42-caldav.icloud.com/123/calendars/</href></calendar-home-set></prop></propstat></response></multistatus>', 'application/xml'))
      .mockResolvedValueOnce(answer(405, ''))
    vi.stubGlobal('fetch', fetch)
    expect(await appleCalendar('Basic x')).toBe('https://p42-caldav.icloud.com/123/calendars/blade-notes/')
    expect(fetch.mock.calls.map((c) => [c[0], c[1].method])).toEqual([
      ['https://caldav.icloud.com/', 'PROPFIND'],
      ['https://caldav.icloud.com/123/principal/', 'PROPFIND'],
      ['https://p42-caldav.icloud.com/123/calendars/blade-notes/', 'MKCALENDAR'],
    ])
  })

  it('says 401 when the app-specific password is wrong', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(401, '')))
    await expect(appleCalendar('Basic x')).rejects.toMatchObject({ status: 401 })
  })
})

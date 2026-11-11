import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { marshall } from '@aws-sdk/util-dynamodb'
import { DEFAULT_SETTINGS, type Item } from '@blade-notes/core'
import { entryOf, hash } from './entries'
import * as store from './store'
import { onStream, Run, syncItem } from './sync'

vi.mock('./store', () => ({
  getItem: vi.fn(), getMap: vi.fn(), getSettings: vi.fn(), getCal: vi.fn(), listItems: vi.fn(),
  markCal: vi.fn(), putCal: vi.fn(), putMap: vi.fn(), deleteMap: vi.fn(), seal: vi.fn(), unseal: vi.fn(), oauthApp: vi.fn(),
}))
const m = vi.mocked(store)

const base = { rank: 'a0', createdAt: '', updatedAt: '' }
const tree: { [id: string]: Item } = {
  s: { ...base, id: 's', type: 'space', parentId: null, title: 'Personal' },
  t1: { ...base, id: 't1', type: 'task', parentId: 's', title: 'Passport' },
}
const event: Item = { ...base, id: 'e1', type: 'event', parentId: 't1', title: 'Book it', at: '2026-11-15', tz: 'Asia/Dhaka' }
const CAL = 'https://p42-caldav.icloud.com/1/calendars/blade-notes/'
const ok = (status = 201) => new Response(null, { status })

beforeEach(() => {
  process.env.SITE_URL = 'https://n.example'
  m.getItem.mockImplementation(async (_sub, id) => tree[id])
  m.getSettings.mockResolvedValue({ ...DEFAULT_SETTINGS, defaultCalendar: 'apple' })
  m.getCal.mockImplementation(async (_sub, p) => (p === 'apple' ? { provider: 'apple', calendarId: CAL, secret: 'blob' } : undefined))
  m.unseal.mockResolvedValue({ username: 'me@icloud.com', password: 'abcd' })
  m.getMap.mockResolvedValue(undefined)
})
afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('syncItem', () => {
  it('writes a new entry to the space’s calendar and remembers where', async () => {
    const fetch = vi.fn().mockResolvedValue(ok())
    vi.stubGlobal('fetch', fetch)
    expect(await syncItem(new Run(), 'u', 'e1', event)).toBe('written')
    expect(fetch.mock.calls[0]![0]).toBe(`${CAL}e1.ics`)
    expect(m.putMap).toHaveBeenCalledWith('u', 'e1', { provider: 'apple', calendarId: CAL, externalId: 'e1', hash: hash(entryOf(event, 'https://n.example')!) })
    expect(m.markCal).toHaveBeenCalledWith('u', 'apple', undefined)
  })

  it('skips an entry the calendar already has as it is', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    m.getMap.mockResolvedValue({ provider: 'apple', calendarId: CAL, externalId: 'e1', hash: hash(entryOf(event, 'https://n.example')!) })
    expect(await syncItem(new Run(), 'u', 'e1', event)).toBe('skipped')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('takes a removed item off the calendar', async () => {
    const fetch = vi.fn().mockResolvedValue(ok(204))
    vi.stubGlobal('fetch', fetch)
    m.getMap.mockResolvedValue({ provider: 'apple', calendarId: CAL, externalId: 'e1', hash: 'h' })
    expect(await syncItem(new Run(), 'u', 'e1', undefined)).toBe('removed')
    expect(fetch.mock.calls[0]![1].method).toBe('DELETE')
    expect(m.deleteMap).toHaveBeenCalledWith('u', 'e1')
  })

  it('forgets an entry left on a calendar that is no longer connected, then writes to the new one', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok()))
    m.getMap.mockResolvedValue({ provider: 'google', calendarId: 'old', externalId: 'x', hash: 'h' })
    expect(await syncItem(new Run(), 'u', 'e1', event)).toBe('written')
    expect(m.deleteMap).toHaveBeenCalledWith('u', 'e1')
    expect(m.putMap).toHaveBeenCalled()
  })

  it('keeps a refusal on the connection and does not retry it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok(403)))
    expect(await syncItem(new Run(), 'u', 'e1', event)).toBe('failed')
    expect(m.markCal).toHaveBeenCalledWith('u', 'apple', expect.stringContaining('refused'))
    expect(m.putMap).not.toHaveBeenCalled()
  })

  it('throws on a server error so the stream retries', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok(503)))
    await expect(syncItem(new Run(), 'u', 'e1', event)).rejects.toMatchObject({ status: 503 })
  })

  it('does nothing when the space has no calendar', async () => {
    m.getSettings.mockResolvedValue({ ...DEFAULT_SETTINGS, defaultCalendar: 'apple', spaceCalendars: { s: null } })
    expect(await syncItem(new Run(), 'u', 'e1', event)).toBe('skipped')
  })
})

describe('onStream', () => {
  const record = (data: Item, seq: string) => ({
    eventSource: 'aws:dynamodb',
    dynamodb: { SequenceNumber: seq, Keys: marshall({ pk: 'USER#u', sk: `ITEM#${data.id}` }), NewImage: marshall({ data }, { removeUndefinedValues: true }) },
  })

  it('ignores notes and folders without reading anything', async () => {
    const note: Item = { ...base, id: 'n', type: 'note', parentId: 's', title: 'x' }
    expect(await onStream([record(note, '1')] as never)).toEqual({ batchItemFailures: [] })
    expect(m.getMap).not.toHaveBeenCalled()
  })

  it('stops at the first change that needs a retry', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok(503)))
    const res = await onStream([record(event, '7'), record({ ...event, id: 'e2' }, '8')] as never)
    expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: '7' }] })
  })
})

import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type Item } from '@blade-notes/core'
import { chooseProvider, entryOf, hash, relevant, spaceOf, span } from './entries'

const SITE = 'https://notes.example.com'
const base = { rank: 'a0', createdAt: '', updatedAt: '' }
const event = (extra: Partial<Item> = {}): Item => ({
  ...base, id: 'e1', type: 'event', parentId: 't1', title: 'Book the renewal appointment', at: '2026-11-15T10:00:00+06:00', tz: 'Asia/Dhaka', ...extra,
})

describe('entries', () => {
  it('maps a timed event with a link back to its task', () => {
    expect(entryOf(event(), SITE)).toEqual({
      id: 'e1', title: 'Book the renewal appointment', at: '2026-11-15T10:00:00+06:00', tz: 'Asia/Dhaka',
      description: 'Open in Blade Notes: https://notes.example.com/t/t1#e1',
    })
  })

  it('keeps a private event’s text off the calendar and marks done ones', () => {
    expect(entryOf(event({ private: true }), SITE)!.title).toBe('Blade Notes reminder')
    expect(entryOf(event({ status: 'done' }), SITE)!.title).toBe('✓ Book the renewal appointment')
  })

  it('turns a task due date into an all-day entry, even with a stored time', () => {
    const task: Item = { ...base, id: 't1', type: 'task', parentId: 'f1', title: 'Passport', due: '2026-11-20T09:00:00+06:00' }
    expect(entryOf(task, SITE)).toMatchObject({ at: '2026-11-20', description: 'Open in Blade Notes: https://notes.example.com/t/t1' })
  })

  it('has no entry for deleted items, notes, or tasks without a date', () => {
    expect(entryOf(event({ deletedAt: '2026-11-11T00:00:00Z' }), SITE)).toBeNull()
    expect(entryOf({ ...base, id: 'n', type: 'note', parentId: 'f', title: 'x' }, SITE)).toBeNull()
    expect(entryOf({ ...base, id: 't', type: 'task', parentId: 'f', title: 'x' }, SITE)).toBeNull()
    expect(relevant({ ...base, id: 't', type: 'task', parentId: 'f', title: 'x' })).toBe(false)
  })

  it('spans all day exclusively and timed for 30 minutes', () => {
    expect(span(entryOf(event({ at: '2026-12-31' }), SITE)!)).toEqual({ allDay: true, start: '2026-12-31', end: '2027-01-01' })
    expect(span(entryOf(event(), SITE)!)).toEqual({ allDay: false, start: '2026-11-15T10:00:00+06:00', end: '2026-11-15T04:30:00.000Z' })
  })

  it('hashes only what a calendar shows', () => {
    const a = entryOf(event(), SITE)!
    expect(hash(a)).toBe(hash({ ...a }))
    expect(hash(a)).not.toBe(hash({ ...a, at: '2026-11-16' }))
  })
})

describe('which calendar', () => {
  const settings = { ...DEFAULT_SETTINGS, defaultCalendar: 'google' as const, spaceCalendars: { work: 'outlook' as const, home: null } }
  it('uses the space’s own choice, its "none", or the default', () => {
    expect(chooseProvider(settings, 'work')).toBe('outlook')
    expect(chooseProvider(settings, 'home')).toBeNull()
    expect(chooseProvider(settings, 'personal')).toBe('google')
    expect(chooseProvider(settings, null)).toBe('google')
  })

  it('walks up to the space', async () => {
    const tree: { [id: string]: Item } = {
      s: { ...base, id: 's', type: 'space', parentId: null, title: 'Personal' },
      f: { ...base, id: 'f', type: 'folder', parentId: 's', title: 'Docs' },
      t1: { ...base, id: 't1', type: 'task', parentId: 'f', title: 'Passport' },
    }
    expect(await spaceOf(event(), async (id) => tree[id])).toBe('s')
    expect(await spaceOf(event({ parentId: 'gone' }), async (id) => tree[id])).toBeNull()
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import { addDays, dayDiff, isAllDay, localDay, localTime, sortKey, stamp } from './when'

const original = process.env.TZ
afterEach(() => {
  process.env.TZ = original
})

describe('dates across time zones', () => {
  it('stores a timed date as one moment with the offset where it was set', () => {
    process.env.TZ = 'Asia/Dhaka'
    expect(stamp('2026-11-12', '09:00')).toBe('2026-11-12T09:00:00+06:00')
  })

  it('shows that moment in the zone the device is in now (Dhaka 9:00 is 8:30 in India)', () => {
    process.env.TZ = 'Asia/Dhaka'
    const at = stamp('2026-11-12', '09:00')
    process.env.TZ = 'Asia/Kolkata'
    expect(localTime(at)).toBe('08:30')
    expect(localDay(at)).toBe('2026-11-12')
    process.env.TZ = 'America/New_York'
    expect(localTime(at)).toBe('22:00')
    expect(localDay(at)).toBe('2026-11-11') // the evening before, there
  })

  it('keeps an all-day date on the same day everywhere', () => {
    process.env.TZ = 'Asia/Dhaka'
    const at = stamp('2026-11-15', null)
    expect(at).toBe('2026-11-15')
    expect(isAllDay(at)).toBe(true)
    process.env.TZ = 'Pacific/Honolulu'
    expect(localDay(at)).toBe('2026-11-15')
    expect(localTime(at)).toBeNull()
  })

  it('uses the offset in force on that date (daylight saving)', () => {
    process.env.TZ = 'Europe/Berlin'
    expect(stamp('2026-07-01', '10:00')).toBe('2026-07-01T10:00:00+02:00')
    expect(stamp('2026-12-01', '10:00')).toBe('2026-12-01T10:00:00+01:00')
  })

  it('counts days and sorts all-day before timed on the same day', () => {
    expect(dayDiff('2026-11-15', '2026-11-11')).toBe(4)
    expect(dayDiff('2026-03-01', '2026-02-28')).toBe(1)
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    process.env.TZ = 'Asia/Dhaka'
    expect(sortKey('2026-11-15')).toBeLessThan(sortKey('2026-11-15T00:30:00+06:00'))
  })
})

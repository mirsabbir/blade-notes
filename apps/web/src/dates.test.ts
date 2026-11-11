import { afterEach, describe, expect, it } from 'vitest'
import { stamp } from '@blade-notes/core'
import { chipLabel, parseWhen, plainLabel, setElsewhere } from './dates'

const today = '2026-11-11' // a Wednesday
const days = (q: string) => parseWhen(q, today).map((w) => [w.day, w.time])
const original = process.env.TZ
afterEach(() => {
  process.env.TZ = original
})

describe('what you type after @', () => {
  it('reads days, weekdays, dates and times', () => {
    expect(days('')).toEqual([['2026-11-11', null], ['2026-11-12', null], ['2026-11-14', null], ['2026-11-16', null]])
    expect(days('sun')[0]).toEqual(['2026-11-15', null])
    expect(days('tom 9am')[0]).toEqual(['2026-11-12', '09:00'])
    expect(days('next fri 3pm')[0]).toEqual(['2026-11-20', '15:00'])
    expect(days('15 nov')[0]).toEqual(['2026-11-15', null])
    expect(days('nov 15')[0]).toEqual(['2026-11-15', null])
    expect(days('in 3 days')[0]).toEqual(['2026-11-14', null])
    expect(days('in 2w')[0]).toEqual(['2026-11-25', null])
    expect(days('3pm')).toEqual([['2026-11-11', '15:00']])
    expect(days('sun 3p')[0]).toEqual(['2026-11-15', '15:00'])
    expect(days('tom 12a')[0]).toEqual(['2026-11-12', '00:00'])
    expect(days('sun at 18:30')[0]).toEqual(['2026-11-15', '18:30'])
    expect(days('5')[0]).toEqual(['2026-12-05', null]) // the 5th has passed this month
    expect(days('1 jan')[0]).toEqual(['2027-01-01', null])
  })

  it('offers both when a prefix fits both, and nothing for plain words', () => {
    expect(days('to').map((d) => d[0])).toEqual(['2026-11-11', '2026-11-12'])
    expect(days('mirsabbir')).toEqual([])
    expect(days('31 feb')).toEqual([])
    expect(days('25:00')).toEqual([])
  })
})

describe('labels follow the zone you are in', () => {
  it('shows a Dhaka 9:00 as 8:30 in India and says where it was set', () => {
    process.env.TZ = 'Asia/Dhaka'
    const at = stamp('2026-11-12', '09:00')
    expect(chipLabel(at, today)).toBe('Tomorrow · 09:00')
    process.env.TZ = 'Asia/Kolkata'
    expect(chipLabel(at, today)).toBe('Tomorrow · 08:30')
    expect(plainLabel(at)).toBe('Thu 12 Nov 2026, 08:30')
    expect(setElsewhere(at, 'Asia/Dhaka', 'Asia/Kolkata')).toBe('Set as 09:00 in Asia/Dhaka')
    expect(setElsewhere(at, 'Asia/Kolkata', 'Asia/Kolkata')).toBe('')
  })

  it('keeps an all-day date as it is', () => {
    process.env.TZ = 'America/Los_Angeles'
    expect(chipLabel('2026-11-15', today)).toBe('Sun 15 Nov')
    expect(plainLabel('2026-11-15')).toBe('Sun 15 Nov 2026')
  })
})

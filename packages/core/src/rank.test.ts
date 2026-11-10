import { describe, expect, it } from 'vitest'
import { between } from './rank'

describe('between', () => {
  it('orders inserts at the start, end and middle', () => {
    let ranks = [between(null, null)]
    for (let i = 0; i < 200; i++) {
      const pick = i % 3
      if (pick === 0) ranks = [between(null, ranks[0]!), ...ranks]
      else if (pick === 1) ranks = [...ranks, between(ranks.at(-1)!, null)]
      else {
        const j = Math.floor(ranks.length / 2)
        ranks.splice(j, 0, between(ranks[j - 1]!, ranks[j]!))
      }
    }
    const sorted = [...ranks].sort()
    expect(ranks).toEqual(sorted)
    expect(new Set(ranks).size).toBe(ranks.length)
  })

  it('keeps splitting the same gap', () => {
    let lo = 'a'
    const hi = 'b'
    for (let i = 0; i < 100; i++) {
      const m = between(lo, hi)
      expect(lo < m && m < hi).toBe(true)
      lo = m
    }
  })

  it('rejects a reversed pair', () => {
    expect(() => between('b', 'a')).toThrow()
  })
})

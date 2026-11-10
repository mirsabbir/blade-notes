/**
 * Fractional ranks: base-36 digit strings that sort with plain `<`.
 * `between(a, b)` returns a rank strictly between `a` and `b`, so moving an item
 * rewrites only that one item. `null` means "no neighbour on that side".
 * Same midpoint idea as rocicorp's fractional-indexing, without the integer part.
 */
const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz'
const BASE = DIGITS.length
const at = (s: string, i: number) => DIGITS.indexOf(s[i] ?? '0')

function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    let n = 0
    while ((a[n] ?? '0') === b[n]) n++
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n))
  }
  const da = a ? at(a, 0) : 0
  const db = b !== null ? at(b, 0) : BASE
  if (db - da > 1) return DIGITS[Math.round((da + db) / 2)]!
  if (b !== null && b.length > 1) return b.slice(0, 1)
  return DIGITS[da]! + midpoint(a.slice(1), null)
}

export function between(a: string | null, b: string | null): string {
  if (a !== null && b !== null && !(a < b)) throw new Error(`rank: "${a}" is not before "${b}"`)
  return midpoint(a ?? '', b)
}

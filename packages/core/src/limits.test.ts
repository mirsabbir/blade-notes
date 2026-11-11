import { describe, expect, it } from 'vitest'
import { MAX_BODY_BYTES, MAX_TITLE_CHARS, tooLarge, utf8Bytes } from './limits'
import type { Change } from './types'

const body = (text: string): Change => ({
  kind: 'body',
  baseSeq: 0,
  data: { id: 'b1', updatedAt: '2026-11-11T00:00:00.000Z', doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } },
})
const item = (title: string): Change => ({
  kind: 'item',
  data: { id: 'i1', type: 'note', parentId: null, rank: 'a0', title, createdAt: '', updatedAt: '' },
})

describe('utf8Bytes', () => {
  it.each([
    ['ASCII', 'abc', 3],
    ['German ß ä ö ü', 'ßäöü', 8],
    ['Greek', 'αβγΩ', 8],
    ['Bangla', 'বাংলা', 15],
    ['emoji (a surrogate pair)', '😀', 4],
    ['family emoji (ZWJ sequence)', '👨‍👩‍👧', 18],
    ['Chinese', '中文', 6],
    ['Arabic (right to left)', 'مرحبا', 10],
  ])('%s', (_, s, n) => expect(utf8Bytes(s)).toBe(n))
})

describe('tooLarge', () => {
  it('lets a normal note through', () => expect(tooLarge(body('Grüße, αβγ, বাংলা, 😀'))).toBeNull())

  it('counts bytes, not characters: 200,000 Bangla letters are 600 kB', () => {
    const c = body('ক'.repeat(200_000))
    expect(JSON.stringify(c.data).length).toBeLessThan(MAX_BODY_BYTES) // the old check passed this
    expect(tooLarge(c)).toMatch(/limit is 350 kB/)
  })

  it('accepts a body just under the limit and rejects one just over', () => {
    const overhead = utf8Bytes(JSON.stringify(body('').data))
    expect(tooLarge(body('a'.repeat(MAX_BODY_BYTES - overhead)))).toBeNull()
    expect(tooLarge(body('a'.repeat(MAX_BODY_BYTES - overhead + 1)))).not.toBeNull()
  })

  it('limits titles by characters, so an emoji counts once', () => {
    expect(tooLarge(item('😀'.repeat(MAX_TITLE_CHARS)))).toBeNull()
    expect(tooLarge(item('😀'.repeat(MAX_TITLE_CHARS + 1)))).toMatch(/title/)
  })
})

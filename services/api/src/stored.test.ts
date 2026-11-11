import { describe, expect, it } from 'vitest'
import { fromStored, toStored } from './handler'

// The text a body goes through on its way to DynamoDB and back must come out identical.
const SAMPLES = {
  ascii: 'Plain ASCII: ~!@#$%^&*()_+{}|:"<>?`-=[]\;\',./',
  german: 'Grüße aus Zürich: Straße, Äpfel, Öl, Übermaß, ẞ',
  greek: 'Καλημέρα κόσμε: αβγδεζηθ ΑΒΓΔ ω',
  bangla: 'আমার সোনার বাংলা, আমি তোমায় ভালোবাসি। ক্ষ জ্ঞ ৳১২৩',
  emoji: '😀 👨‍👩‍👧 🇧🇩 🏳️‍🌈 👍🏽',
  cjk: '中文 日本語 한국어',
  rtl: 'مرحبا بالعالم שלום',
  combining: 'é ñ å', // é ñ å built from combining marks
  invisible: 'zero​width  nbsp ﻿bom tab\there',
  newlines: 'line one\nline two\r\nline three',
  escapes: 'quotes " and \' and backslash \\ and </script>',
  lone: 'lone surrogate \uD83D end', // invalid UTF-16 a browser can still produce
}

const docOf = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })

describe('body storage round trip', () => {
  for (const [name, text] of Object.entries(SAMPLES)) {
    it(name, () => {
      const data = { id: 'b1', doc: docOf(text), updatedAt: '2026-11-11T00:00:00.000Z' }
      const stored = toStored({ kind: 'body', data, baseSeq: 0 }) as { doc?: unknown }
      expect(typeof stored.doc).toBe('string')
      expect(fromStored('body', stored)).toEqual(data)
    })
  }

  it('keeps a document nested deeper than DynamoDB allows for maps (40 list levels)', () => {
    let node: object = { type: 'paragraph', content: [{ type: 'text', text: 'deep' }] }
    for (let i = 0; i < 40; i++) node = { type: 'bulletList', content: [{ type: 'listItem', content: [node] }] }
    const data = { id: 'b2', doc: { type: 'doc', content: [node] }, updatedAt: '' }
    expect(fromStored('body', toStored({ kind: 'body', data, baseSeq: 0 }) as { doc?: unknown })).toEqual(data)
  })

  it('leaves items as they are', () => {
    const data = { id: 'i1', type: 'note' as const, parentId: null, rank: 'a0', title: SAMPLES.bangla + SAMPLES.emoji, createdAt: '', updatedAt: '' }
    expect(fromStored('item', toStored({ kind: 'item', data }) as { doc?: unknown })).toEqual(data)
  })
})

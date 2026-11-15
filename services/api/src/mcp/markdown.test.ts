import { beforeAll, describe, expect, it } from 'vitest'
import type { Item } from '@blade-notes/core'
import { applyMarkdown, MarkdownError, parse, toMarkdown, type Context, type N } from './markdown'

beforeAll(() => {
  process.env.TZ = 'Asia/Dhaka'
})

const t = (text: string, ...marks: string[]): N => ({ type: 'text', text, ...(marks.length && { marks: marks.map((type) => ({ type })) }) })
const p = (...content: N[]): N => ({ type: 'paragraph', ...(content.length && { content }) })
const doc = (...content: N[]): N => ({ type: 'doc', content })
const item = (id: string, type: Item['type'], extra: Partial<Item> = {}): Item => ({
  id, type, parentId: 'note-1', rank: 'a0', title: 'x', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', ...extra,
})

const EVENT = '3f9a1c2e-0000-4000-8000-000000000001'
const DESC = '5b2e0c11-0000-4000-8000-000000000002'
const ctx: Context = {
  ownerId: 'note-1',
  files: '/api/files/user-1/',
  items: {
    [EVENT]: item(EVENT, 'event', { at: '2026-11-21T09:00:00+06:00' }),
    [DESC]: item(DESC, 'description', { title: 'milk' }),
  },
}

/** The editor sorts marks itself (ProseMirror Mark.setFrom), so their order is not part of the text. */
const sorted = (n: N): N => ({
  ...n,
  ...(n.marks && { marks: [...n.marks].sort((a, b) => a.type.localeCompare(b.type)) }),
  ...(n.content && { content: n.content.map(sorted) }),
})

/** Markdown and back gives the same document. */
function roundTrip(d: N) {
  const md = toMarkdown(d, ctx)
  const fresh = parse(md, ctx, d)
  expect(sorted(fresh.doc), md).toEqual(sorted(d))
  expect(fresh.effects).toEqual({ dates: [], descriptions: [] })
  return md
}

describe('Markdown round trip', () => {
  it('text that looks like Markdown stays text', () => {
    for (const text of [
      'Plain *stars* and _under_ and snake_case and 5 * 3 and a ~ b',
      '# not a heading',
      '- not a list',
      '1. not a list either',
      '> not a quote',
      '---',
      'a <b>tag</b> and a < b and [brackets] and `ticks` and \\ backslash at end\\',
      'entities &amp; &#169; stay literal & ok',
      'Wow!',
      'আমার সোনার বাংলা ক্ষ জ্ঞ ৳১২৩ 😀 👨‍👩‍👧 中文 مرحبا',
      '    four spaces first',
    ])
      roundTrip(doc(p(t(text))))
  })

  it('marks, nested and side by side', () => {
    roundTrip(doc(p(t('a '), t('bold', 'bold'), t(' '), t('both', 'bold', 'italic'), t(' and '), t('code *x*', 'code'), t(' '), t('strike', 'strike'), t(' '), t('u', 'underline'), t(' '), t('hi', 'highlight'))))
    roundTrip(doc(p(t('one', 'bold'), t('two', 'bold', 'italic'), t(' three', 'bold'))))
    const link = { type: 'link', attrs: { href: 'https://example.com/a(b)', target: '_blank', rel: 'noopener noreferrer nofollow', class: null } }
    roundTrip(doc(p(t('see '), { type: 'text', text: 'the site', marks: [link] }, t('!'))))
  })

  it('headings, lists, tasks, quotes, code, rules, tables, pictures, line breaks', () => {
    const li = (...c: N[]): N => ({ type: 'listItem', content: c })
    const ti = (checked: boolean, ...c: N[]): N => ({ type: 'taskItem', attrs: { checked }, content: c })
    const cell = (type: string, text: string): N => ({ type, content: [p(t(text))] })
    const md = roundTrip(
      doc(
        { type: 'heading', attrs: { level: 2 }, content: [t('Plan')] },
        { type: 'bulletList', content: [li(p(t('one')), { type: 'bulletList', content: [li(p(t('nested')))] }), li(p(t('two')))] },
        { type: 'orderedList', attrs: { start: 3 }, content: [li(p(t('three'))), li(p(t('four')))] },
        { type: 'taskList', content: [ti(true, p(t('done'))), ti(false, p(t('open')), { type: 'taskList', content: [ti(false, p(t('sub')))] })] },
        { type: 'blockquote', content: [p(t('quoted')), p(t('more'))] },
        { type: 'codeBlock', attrs: { language: 'ts' }, content: [t('const a = `x` ** 2\n```inner```')] },
        { type: 'horizontalRule' },
        { type: 'table', content: [{ type: 'tableRow', content: [cell('tableHeader', 'A'), cell('tableHeader', 'B | C')] }, { type: 'tableRow', content: [cell('tableCell', '1'), cell('tableCell', '2')] }] },
        { type: 'image', attrs: { src: '/api/files/user-1/abc.png', alt: 'photo', title: null } },
        p(t('line one'), { type: 'hardBreak' }, t('line two')),
      ),
    )
    expect(md).toContain('![photo](file:abc.png)')
    expect(md).toContain('- [x] done')
  })

  it('date chips, descriptions and secrets come back with their ids', () => {
    const md = roundTrip(
      doc(
        p(t('Call the bank '), { type: 'dateChip', attrs: { id: EVENT, at: '2026-11-21T09:00:00+06:00' } }),
        p(t('Buy '), { type: 'text', text: 'milk', marks: [{ type: 'describe', attrs: { descId: DESC } }] }, t(' and '), { type: 'secret', attrs: { label: 'Wi-Fi', data: 'CIPHERTEXT' } }),
        { type: 'bulletList', content: [{ type: 'listItem', attrs: { descId: DESC }, content: [p(t('described item'))] }] },
      ),
    )
    expect(md).toContain('[@Sat 2026-11-21 09:00](date:3f9a1c2e)')
    expect(md).toContain('[milk](desc:5b2e0c11)')
    expect(md).toContain('[🔒 Wi-Fi](secret:')
    expect(md).toContain('- described item [›](desc:5b2e0c11)')
    expect(md).not.toContain('CIPHERTEXT')
  })
})

describe('editing keeps what was not touched', () => {
  const odd: N = { type: 'paragraph', attrs: { textAlign: 'center' }, content: [t('kept exactly, with attributes Markdown cannot say')] }
  const before = doc(p(t('first')), p(), p(), odd, p(t('last')))

  it('an unchanged text gives the same document', () => {
    expect(applyMarkdown(before, toMarkdown(before, ctx), ctx).doc).toEqual(before)
  })

  it('a changed block is parsed; the rest keep their nodes', () => {
    const md = toMarkdown(before, ctx).replace('last', 'last, edited')
    const after = applyMarkdown(before, md, ctx).doc
    expect(after.content!.slice(0, 4)).toEqual(before.content!.slice(0, 4))
    expect(after.content![4]).toEqual(p(t('last, edited')))
  })

  it('appending adds blocks at the end', () => {
    const after = applyMarkdown(before, `${toMarkdown(before, ctx)}\n\n- new item`, ctx).doc
    expect(after.content!.slice(0, 5)).toEqual(before.content)
    expect(after.content![5]!.type).toBe('bulletList')
  })
})

describe('new dates and descriptions', () => {
  it('date:new makes an event at that wall time in the zone', () => {
    const { doc: d, effects } = parse('Dentist [@2026-12-02 14:30](date:new) and [@2026-12-03](date:new)', ctx)
    expect(effects.dates.map((x) => [x.at, x.isNew])).toEqual([
      ['2026-12-02T14:30:00+06:00', true],
      ['2026-12-03', true],
    ])
    expect(d.content![0]!.content!.filter((n) => n.type === 'dateChip')).toHaveLength(2)
  })

  it('changing the label moves the existing event', () => {
    const { effects } = parse('[@Mon 2026-11-23 10:00](date:3f9a1c2e)', ctx)
    expect(effects.dates).toEqual([{ id: EVENT, at: '2026-11-23T10:00:00+06:00', isNew: false }])
  })

  it('desc:new with a title makes a description; on a list item it takes the item text', () => {
    const { effects } = parse('A [phrase](desc:new "hidden text")\n\n- item text [›](desc:new "more")', ctx)
    expect(effects.descriptions.map((d) => [d.title, d.text])).toEqual([
      ['phrase', 'hidden text'],
      ['item text', 'more'],
    ])
  })

  it('refuses what it cannot keep', () => {
    expect(() => parse('[🔒 x](secret:deadbeef)', ctx)).toThrow(MarkdownError)
    expect(() => parse('[@soon](date:new)', ctx)).toThrow(MarkdownError)
    expect(() => parse('[x](desc:new)', ctx)).toThrow(MarkdownError)
    expect(() => parse('[x](date:ffffffff)', ctx)).toThrow(MarkdownError)
  })
})

describe('escaping holds for any text', () => {
  it('2,000 random strings of Markdown characters come back unchanged', () => {
    const chars = ['*', '_', '`', '~', '[', ']', '(', ')', '<', '>', '!', '#', '-', '+', '=', '|', '\\', '&', ';', '#', '1', '.', ' ', ' ', 'a', 'b', 'ক', '😀', ':', '/', 'h']
    let seed = 7
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n)
    for (let i = 0; i < 20000; i++) {
      const text = Array.from({ length: 1 + rnd(24) }, () => chars[rnd(chars.length)]).join('').trim()
      if (!text) continue
      const d = doc(p(t(text)))
      const md = toMarkdown(d, ctx)
      expect(parse(md, ctx).doc, JSON.stringify({ text, md })).toEqual(d)
    }
  })
})

describe('marks hold in any combination', () => {
  it('5,000 random runs of bold, italic, strike, underline and highlight come back unchanged', () => {
    let seed = 11
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n)
    const words = ['a', 'b c', ' x ', '(y)', 'z.', '!', '*', '_q_', 'ক', '-', '1.']
    const kinds = ['bold', 'italic', 'strike', 'underline', 'highlight']
    for (let i = 0; i < 5000; i++) {
      const nodes: N[] = []
      for (let k = 0; k < 1 + rnd(4); k++) {
        const marks = kinds.filter(() => rnd(3) === 0)
        const text = words[rnd(words.length)]!
        const prev = nodes.at(-1)
        if (prev && JSON.stringify((prev.marks ?? []).map((m) => m.type)) === JSON.stringify(marks)) prev.text += text
        else nodes.push(t(text, ...marks))
      }
      const all = nodes.map((n) => n.text).join('')
      if (!all.trim() || /^\s|\s$/.test(all)) continue // a paragraph's outer spaces are not text in Markdown
      const d = doc(p(...nodes))
      const md = toMarkdown(d, ctx)
      expect(sorted(parse(md, ctx).doc), md).toEqual(sorted(d))
    }
  })
})

describe('edits that once lost text (review 2026-11-15)', () => {
  const li = (...c: N[]): N => ({ type: 'listItem', content: c })
  const ti = (checked: boolean, text: string): N => ({ type: 'taskItem', attrs: { checked }, content: [p(t(text))] })

  it('a checklist next to a bullet list stays as it was when text is appended', () => {
    const before = doc({ type: 'taskList', content: [ti(true, 'buy milk'), ti(false, 'call mom')] }, { type: 'bulletList', content: [li(p(t('shop closes at 9')))] })
    const after = applyMarkdown(before, `${toMarkdown(before, ctx)}\n\nP.S.`, ctx).doc
    expect(after.content!.slice(0, 2)).toEqual(before.content)
    expect(after.content![2]).toEqual(p(t('P.S.')))
  })

  it('a checklist with blank lines between items keeps its boxes', () => {
    const d = parse('- [x] buy milk\n\n- [ ] call mom', ctx).doc
    expect(d.content![0]!.type).toBe('taskList')
    expect(JSON.stringify(d)).not.toContain('[x]')
    expect(d.content![0]!.content!.map((i) => i.attrs?.checked)).toEqual([true, false])
  })

  it('a table holding a list is refused when edited, kept when untouched, and may be deleted', () => {
    const cell = (type: string, ...content: N[]): N => ({ type, content })
    const table: N = { type: 'table', content: [{ type: 'tableRow', content: [cell('tableHeader', p(t('Deploy'))), cell('tableHeader', { type: 'bulletList', content: [li(p(t('step one')))] })] }] }
    const before = doc(p(t('intro')), table, p(t('outro')))
    const md = toMarkdown(before, ctx)
    expect(applyMarkdown(before, md.replace('outro', 'the end'), ctx).doc.content![1]).toBe(table)
    expect(() => applyMarkdown(before, md.replace('Deploy', 'Ship'), ctx)).toThrow(MarkdownError)
    expect(applyMarkdown(before, 'intro\n\noutro', ctx).doc.content).toHaveLength(2)
  })

  it('a new nested item joins the list above it', () => {
    const before = doc({ type: 'bulletList', content: [li(p(t('a'))), li(p(t('b')))] })
    const after = applyMarkdown(before, `${toMarkdown(before, ctx)}\n  - c`, ctx).doc
    expect(after.content).toHaveLength(1)
    expect(after.content![0]!.content![1]!.content![1]!.type).toBe('bulletList')
  })

  it('odd input fails softly', () => {
    expect(() => parse('[@2026-02-30](date:new)', ctx)).toThrow(MarkdownError)
    expect(parse('&#99999999; ok', ctx).doc).toEqual(doc(p(t('&#99999999; ok'))))
  })
})

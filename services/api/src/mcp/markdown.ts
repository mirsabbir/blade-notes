import { createHash, randomUUID } from 'node:crypto'
import { marked, type Token, type Tokens } from 'marked'
import { localDay, localTime, stamp, type Item } from '@blade-notes/core'

/**
 * Note text for agents: Tiptap JSON ⇄ Markdown, so an agent reads and writes the text the
 * way it knows best. The app's own parts become links with their own scheme, so they survive
 * a round trip (docs/architecture/08-agents-mcp.md has the full dialect):
 *
 *   [@Fri 2026-11-21 09:00](date:3f9a1c2e)   a date chip (an event item); date:new makes one
 *   [the phrase](desc:5b2e0c11)               hidden description behind a phrase
 *   - list item [›](desc:5b2e0c11)            hidden description behind a list item
 *   [phrase](desc:new "text")                 a new description with that text
 *   [🔒 Wi-Fi](secret:7c1e2a90)               a Secret block; the agent never sees the secret
 *   ![photo](file:<uuid>.png)                 a picture stored with the note
 *   <u>…</u> <mark>…</mark> <br>              underline, highlight, line break
 *
 * Edits keep everything the agent did not touch exactly as it was: the text is cut into
 * top-level blocks, and only blocks whose Markdown changed are parsed back (`applyMarkdown`).
 */

export type N = { type: string; text?: string; attrs?: { [k: string]: unknown }; marks?: M[]; content?: N[] }
type M = { type: string; attrs?: { [k: string]: unknown } }

export interface Context {
  /** Every item of the account (events and descriptions are looked up by id). */
  items: { readonly [id: string]: Item }
  /** The note, task or description whose text this is. */
  ownerId: string
  /** `/api/files/<sub>/`: pictures under it are written `file:<name>`. */
  files: string
}

/** What parsing asks the caller to store besides the text. */
export interface Effects {
  /** Date chips to create (new id) or move (existing id), with their new `at`. */
  dates: { id: string; at: string; isNew: boolean }[]
  /** New hidden descriptions: title and text (Markdown). */
  descriptions: { id: string; title: string; text: string }[]
}

export class MarkdownError extends Error {}

const ORDER = ['link', 'describe', 'bold', 'italic', 'strike', 'underline', 'highlight', 'code'] as const
const TAGS: { [mark: string]: string } = { bold: 'strong', italic: 'em', strike: 's', underline: 'u', highlight: 'mark' }
const MARK_OF: { [tag: string]: string } = { strong: 'bold', b: 'bold', em: 'italic', i: 'italic', s: 'strike', del: 'strike', u: 'underline', mark: 'highlight' }
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** Each id cut to the shortest prefix, 8 characters or more, that no other id starts with. */
export function shortIds(ids: Iterable<string>): Map<string, string> {
  const all = [...ids].sort()
  const common = (a = '', b = '') => {
    let i = 0
    while (i < a.length && a[i] === b[i]) i++
    return i
  }
  return new Map(all.map((id, i) => [id, id.slice(0, Math.max(8, common(id, all[i - 1]) + 1, common(id, all[i + 1]) + 1))]))
}

/** A date chip's label in the current zone (process.env.TZ): `Fri 2026-11-21 09:00`. */
export function dateLabel(at: string): string {
  const day = localDay(at)
  const weekday = DAYS[new Date(`${day}T12:00:00Z`).getUTCDay()]
  const time = localTime(at)
  return `${weekday} ${day}${time ? ` ${time}` : ''}`
}

/** `2026-11-21` or `2026-11-21 09:00` (a weekday or `T` around it is fine) → [day, time]. */
export function parseWhen(text: string): [string, string | null] | null {
  const m = /(\d{4}-\d{2}-\d{2})(?:[ T]+(\d{1,2}):(\d{2}))?/.exec(text)
  const real = (d: string) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10))).toISOString().slice(0, 10) === d
  if (!m || !real(m[1]!)) return null // 2026-02-30 is not a day
  if (!m[2]) return [m[1]!, null]
  if (Number(m[2]) > 23 || Number(m[3]) > 59) return null
  return [m[1]!, `${m[2]!.padStart(2, '0')}:${m[3]}`]
}

const secretRef = (data: unknown) => createHash('sha256').update(String(data)).digest('hex').slice(0, 8)

// ---------------- Tiptap → Markdown ----------------

/** Escapes text so it parses back to the same characters. */
function esc(text: string): string {
  return text
    // `*` and `~` stay bare only between two spaces ("5 * 3"); a neighbour node may be a delimiter.
    .replace(/\\(?=[!-/:-@[-`{-~]|$)|[`[\]]|<(?=[A-Za-z/!?])|[*~](?! )|(?<! )[*~]/g, '\\$&')
    .replace(/&(?=#?\w+;)/g, '&amp;')
    .replace(/(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu, '\\_')
    .replace(/\n/g, '<br>')
}

/** A paragraph's first characters must not read as a heading, list, quote or thematic break. */
const lineStart = (md: string) =>
  md
    .replace(/^ +/, (s) => '&#32;'.repeat(s.length))
    .replace(/^(?:#{1,6}(?=\s|$)|>|[-+*](?=\s|$)|([-*_])(?: *\1){2,} *$)/, '\\$&')
    .replace(/^(\d+)([.)])(?=\s|$)/, '$1\\$2')

class Renderer {
  private readonly events: (id: string) => string
  private readonly descs: (id: string) => string
  constructor(private readonly ctx: Context) {
    const kids = (type: string) => {
      const map = shortIds(Object.values(ctx.items).filter((i) => i.type === type && i.parentId === ctx.ownerId).map((i) => i.id))
      return (id: string) => map.get(id) ?? id
    }
    this.events = kids('event')
    this.descs = kids('description')
  }

  block(n: N): string {
    const kids = n.content ?? []
    switch (n.type) {
      case 'paragraph':
        return lineStart(this.inline(kids))
      case 'heading':
        return `${'#'.repeat(Math.min(6, Math.max(1, Number(n.attrs?.level ?? 1))))} ${this.inline(kids)}`
      case 'bulletList':
      case 'orderedList':
      case 'taskList': {
        const start = Number(n.attrs?.start ?? 1)
        return kids
          .map((li, i) => this.item(li, n.type === 'orderedList' ? `${start + i}. ` : n.type === 'taskList' ? `- [${li.attrs?.checked ? 'x' : ' '}] ` : '- ', n.type === 'taskList' ? 2 : undefined))
          .join('\n')
      }
      case 'blockquote':
        return this.blocks(kids)
          .split('\n')
          .map((l) => (l ? `> ${l}` : '>'))
          .join('\n')
      case 'codeBlock': {
        const text = kids.map((k) => k.text ?? '').join('')
        const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)))
        return `${fence}${(n.attrs?.language as string | null) ?? ''}\n${text}\n${fence}`
      }
      case 'horizontalRule':
        return '---'
      case 'image':
        return this.atom(n)
      case 'table':
        return kids
          .map((row, r) => {
            // A cell is one line: its blocks are joined by <br> (a list in a cell reads, but is not kept as a list).
            const cells = (row.content ?? []).map((c) => this.blocks(c.content ?? []).replace(/\n+/g, '<br>').replace(/\|/g, '\\|'))
            const line = `| ${cells.join(' | ')} |`
            return r === 0 ? `${line}\n|${cells.map(() => ' --- |').join('')}` : line
          })
          .join('\n')
      default:
        return kids.length ? this.blocks(kids) : this.inline([n])
    }
  }

  blocks(nodes: N[]): string {
    return nodes.map((k) => this.block(k)).join('\n\n')
  }

  private item(li: N, marker: string, width = marker.length): string {
    const [first, ...rest] = li.content ?? []
    const desc = li.attrs?.descId ? ` [›](desc:${this.descs(li.attrs.descId as string)})` : ''
    const head = first?.type === 'paragraph' ? this.inline(first.content ?? []) : first ? this.block(first) : ''
    const pad = ' '.repeat(width)
    // A nested list follows on the next line (a tight list); any other block after a blank line.
    const tail = rest.map((k) => (k.type.endsWith('List') ? '\n' : '\n\n') + this.block(k)).join('')
    return (marker + head + desc + tail).replace(/\n(?=.)/g, `\n${pad}`)
  }

  inline(nodes: N[], level = 0): string {
    if (level === ORDER.length) return nodes.map((n) => this.atom(n)).reduce(joinInline, '')
    const type = ORDER[level]
    let out = ''
    for (let i = 0; i < nodes.length; ) {
      const mark = nodes[i]!.marks?.find((m) => m.type === type)
      let j = i + 1
      while (j < nodes.length && sameMark(nodes[j]!.marks?.find((m) => m.type === type), mark)) j++
      const run = nodes.slice(i, j)
      out = joinInline(out, mark ? this.wrap(mark, run, level) : this.inline(run, level + 1))
      i = j
    }
    return out
  }

  private wrap(mark: M, run: N[], level: number): string {
    if (mark.type === 'code') {
      const text = run.map((n) => n.text ?? '').join('')
      const ticks = '`'.repeat(Math.max(1, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)))
      return /^`|`$/.test(text) ? `${ticks} ${text} ${ticks}` : `${ticks}${text}${ticks}`
    }
    const inner = this.inline(run, level + 1)
    const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner)!
    if (!core) return inner
    const href = String(mark.attrs?.href ?? '')
    if (mark.type === 'link') return `${lead}[${core}](${/[\s()<>]/.test(href) ? `<${href}>` : href})${trail}`
    if (mark.type === 'describe') return `${lead}[${core}](desc:${this.descs(String(mark.attrs?.descId))})${trail}`
    // `**` and friends only open and close next to letters; elsewhere the HTML tag says the same safely.
    const word = /^[\p{L}\p{N}]/u.test(core) && /[\p{L}\p{N}\p{M}]$/u.test(core)
    const delim = word ? { bold: '**', italic: '*', strike: '~~' }[mark.type] : undefined
    const tag = TAGS[mark.type]
    return delim ? `${lead}${delim}${core}${delim}${trail}` : tag ? `${lead}<${tag}>${core}</${tag}>${trail}` : inner
  }

  private atom(n: N): string {
    switch (n.type) {
      case 'text':
        return esc(n.text ?? '')
      case 'hardBreak':
        return '<br>'
      case 'dateChip': {
        const ev = this.ctx.items[n.attrs?.id as string]
        const at = ev?.at ?? (n.attrs?.at as string | undefined)
        return at ? `[@${dateLabel(at)}${ev?.status === 'done' ? ' ✓' : ''}](date:${this.events(String(n.attrs?.id))})` : ''
      }
      case 'secret':
        return `[🔒 ${esc(String(n.attrs?.label ?? 'Secret'))}](secret:${secretRef(n.attrs?.data)})`
      case 'image': {
        const src = String(n.attrs?.src ?? '')
        const href = src.startsWith(this.ctx.files) ? `file:${src.slice(this.ctx.files.length)}` : src
        const title = n.attrs?.title ? ` "${String(n.attrs.title).replace(/"/g, '\\"')}"` : ''
        return `![${esc(String(n.attrs?.alt ?? ''))}](${/[\s()<>]/.test(href) ? `<${href}>` : href}${title})`
      }
      default:
        return esc(n.text ?? (n.content ? n.content.map((k) => k.text ?? '').join('') : ''))
    }
  }
}

const sameMark = (a?: M, b?: M) => (!a && !b) || (!!a && !!b && JSON.stringify(a.attrs ?? {}) === JSON.stringify(b.attrs ?? {}))
/** "Wow!" before a link would read as a picture (`![`). */
const joinInline = (a: string, b: string) => (a.endsWith('!') && b.startsWith('[') && !a.endsWith('\\!') ? `${a.slice(0, -1)}\\!${b}` : a + b)

export interface Block {
  md: string
  /** The Tiptap nodes this Markdown came from: kept as they are while the Markdown is unchanged. */
  nodes: N[]
}

/** The text cut into top-level blocks. Empty paragraphs (spacing) stay with the block before them. */
export function blocksOf(doc: unknown, ctx: Context): Block[] {
  const r = new Renderer(ctx)
  const out: Block[] = []
  let lead: N[] = []
  for (const n of (doc as N | undefined)?.content ?? []) {
    const empty = n.type === 'paragraph' && !(n.content ?? []).length
    if (empty) {
      if (out.length) out.at(-1)!.nodes.push(n)
      else lead.push(n)
      continue
    }
    out.push({ md: r.block(n), nodes: [...lead, n] })
    lead = []
  }
  return out
}

export const toMarkdown = (doc: unknown, ctx: Context): string =>
  blocksOf(doc, ctx)
    .map((b) => b.md)
    .join('\n\n')

// ---------------- Markdown → Tiptap ----------------

const ENTITIES: { [k: string]: string } = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' }
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) =>
    e[0] === '#' ? point(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)), all) : (ENTITIES[e.toLowerCase()] ?? all),
  )
const point = (n: number, all: string) => (n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all)

class Parser {
  readonly effects: Effects = { dates: [], descriptions: [] }
  private readonly secrets = new Map<string, { [k: string]: unknown }>()

  constructor(
    private readonly ctx: Context,
    oldDoc: unknown,
  ) {
    const walk = (n: N) => {
      if (n.type === 'secret') this.secrets.set(secretRef(n.attrs?.data), n.attrs ?? {})
      n.content?.forEach(walk)
    }
    if (oldDoc) walk(oldDoc as N)
  }

  /** An id written in the text, resolved among this owner's events or descriptions. */
  private own(type: 'event' | 'description', ref: string): Item | undefined {
    const found = Object.values(this.ctx.items).filter((i) => i.type === type && i.parentId === this.ctx.ownerId && !i.purgedAt && i.id.startsWith(ref))
    return found.length === 1 ? found[0] : undefined
  }

  blocks(tokens: Token[]): N[] {
    return tokens.flatMap((t) => this.block(t))
  }

  private block(t: Token): N[] {
    switch (t.type) {
      case 'space':
      case 'def':
        return []
      case 'heading':
        return [{ type: 'heading', attrs: { level: (t as Tokens.Heading).depth }, ...this.content(this.inline((t as Tokens.Heading).tokens)) }]
      case 'paragraph':
      case 'text': {
        const nodes = this.inline((t as Tokens.Paragraph).tokens ?? [{ type: 'text', raw: t.raw, text: (t as Tokens.Text).text }])
        // Pictures are blocks in the editor: lift them out of the paragraph.
        const images = nodes.filter((n) => n.type === 'image')
        const rest = images.length ? trimInline(nodes.filter((n) => n.type !== 'image')) : nodes
        return [...(rest.length || !images.length ? [{ type: 'paragraph', ...this.content(rest) }] : []), ...images]
      }
      case 'list':
        return [this.list(t as Tokens.List)]
      case 'blockquote':
        return [{ type: 'blockquote', content: this.blocks((t as Tokens.Blockquote).tokens) }]
      case 'code':
        return [{ type: 'codeBlock', attrs: { language: (t as Tokens.Code).lang || null }, ...this.content((t as Tokens.Code).text ? [{ type: 'text', text: (t as Tokens.Code).text }] : []) }]
      case 'hr':
        return [{ type: 'horizontalRule' }]
      case 'table': {
        const tb = t as Tokens.Table
        const row = (cells: Tokens.TableCell[], type: string): N => ({
          type: 'tableRow',
          content: cells.map((c) => ({ type, content: [{ type: 'paragraph', ...this.content(trimInline(this.inline(c.tokens))) }] })),
        })
        return [{ type: 'table', content: [row(tb.header, 'tableHeader'), ...tb.rows.map((r) => row(r, 'tableCell'))] }]
      }
      case 'html': {
        const raw = t.raw.trim()
        if (/^(<br\s*\/?>)+$/i.test(raw)) return [{ type: 'paragraph' }]
        return [{ type: 'paragraph', ...this.content(raw ? [{ type: 'text', text: raw }] : []) }]
      }
      default:
        return t.raw.trim() ? [{ type: 'paragraph', content: [{ type: 'text', text: t.raw.trim() }] }] : []
    }
  }

  private list(t: Tokens.List): N {
    const task = t.items.some((i) => i.task)
    const content = t.items.map((it): N => {
      const kids = it.tokens.filter((k) => k.type !== 'checkbox')
      const body = this.blocks(kids)
      if (body[0]?.type !== 'paragraph') body.unshift({ type: 'paragraph' })
      // `[›](desc:id)` at the end of the item's first line: the item's own description.
      let descId: string | null = null
      const first = body[0]!
      const last = first.content?.at(-1)
      const mark = last?.type === 'text' && last.text === '›' ? last.marks?.find((m) => m.type === 'describe') : undefined
      if (mark) {
        descId = mark.attrs!.descId as string
        first.content = trimInline(first.content!.slice(0, -1))
        if (!first.content.length) delete first.content
        const made = this.effects.descriptions.find((d) => d.id === descId && !d.title)
        if (made) made.title = plainText(first.content ?? [])
      }
      const attrs = { ...(task && { checked: !!it.checked }), ...(descId && { descId }) }
      return { type: task ? 'taskItem' : 'listItem', ...(Object.keys(attrs).length && { attrs }), content: body }
    })
    const start = Number(t.start)
    return { type: t.ordered ? 'orderedList' : task ? 'taskList' : 'bulletList', ...(t.ordered && start !== 1 && { attrs: { start } }), content }
  }

  private content(nodes: N[]): { content?: N[] } {
    return nodes.length ? { content: nodes } : {}
  }

  inline(tokens: Token[], marks: M[] = []): N[] {
    const out: N[] = []
    const open: M[] = [...marks]
    const text = (s: string) => {
      const t = decode(s).replace(/\s*\n\s*/g, ' ')
      if (t) out.push({ type: 'text', text: t, ...(open.length && { marks: open.map((m) => ({ ...m })) }) })
    }
    for (const t of tokens) {
      switch (t.type) {
        case 'text':
          if ((t as Tokens.Text).tokens?.length) out.push(...this.inline((t as Tokens.Text).tokens!, open))
          else text((t as Tokens.Text).text)
          break
        case 'escape':
          out.push({ type: 'text', text: (t as Tokens.Escape).text, ...(open.length && { marks: open.map((m) => ({ ...m })) }) })
          break
        case 'strong':
        case 'em':
        case 'del':
          out.push(...this.inline((t as Tokens.Strong).tokens, [...open, { type: { strong: 'bold', em: 'italic', del: 'strike' }[t.type]! }]))
          break
        case 'codespan':
          out.push({ type: 'text', text: decode((t as Tokens.Codespan).text), marks: [...open.filter((m) => m.type === 'link'), { type: 'code' }] })
          break
        case 'br':
          out.push({ type: 'hardBreak' })
          break
        case 'html': {
          const tag = /^<(\/?)([a-z]+)\s*\/?>$/i.exec((t as Tokens.HTML).text.trim())
          const name = tag?.[2]?.toLowerCase() ?? ''
          if (name === 'br') out.push({ type: 'hardBreak' })
          else if (MARK_OF[name] && !tag![1]) open.push({ type: MARK_OF[name] })
          else if (MARK_OF[name]) {
            const at = open.map((m) => m.type).lastIndexOf(MARK_OF[name])
            if (at >= 0) open.splice(at, 1)
          } else text((t as Tokens.HTML).text)
          break
        }
        case 'link':
          out.push(...this.link(t as Tokens.Link, open))
          break
        case 'image':
          out.push(this.image(t as Tokens.Image))
          break
        case 'checkbox': // a loose checklist item's box, already on the item
          break
        default:
          text(t.raw)
      }
    }
    // Merge neighbours with the same marks, as the editor keeps them.
    return out.reduce<N[]>((acc, n) => {
      const prev = acc.at(-1)
      if (prev?.type === 'text' && n.type === 'text' && JSON.stringify(prev.marks ?? []) === JSON.stringify(n.marks ?? [])) prev.text += n.text!
      else acc.push(n)
      return acc
    }, [])
  }

  private link(t: Tokens.Link, open: M[]): N[] {
    const [scheme, ref = ''] = t.href.split(/:(.*)/s) as [string, string?]
    if (scheme === 'date') return [this.date(ref, plainText(this.inline(t.tokens)))]
    if (scheme === 'secret') {
      const attrs = this.secrets.get(ref)
      if (!attrs) throw new MarkdownError(`[${t.text}](secret:${ref}) is not a Secret block of this text. Secret blocks are made only in the app; keep their links as they are, move or delete them.`)
      return [{ type: 'secret', attrs: { ...attrs, label: plainText(this.inline(t.tokens)).replace(/^🔒\s*/u, '') || attrs.label } }]
    }
    if (scheme === 'desc') return this.describe(ref, t, open)
    const href = t.href.startsWith('file:') ? this.ctx.files + t.href.slice(5) : t.href
    return this.inline(t.tokens, [...open, { type: 'link', attrs: { href, target: '_blank', rel: 'noopener noreferrer nofollow', class: null } }])
  }

  private date(ref: string, label: string): N {
    const when = parseWhen(label)
    const ev = ref && ref !== 'new' ? this.own('event', ref) : undefined
    if (ref && ref !== 'new' && !ev) throw new MarkdownError(`date:${ref} is not a date in this text. Write [@2026-11-21](date:new) for a new date.`)
    if (!when) {
      if (ev) return { type: 'dateChip', attrs: { id: ev.id, at: ev.at } }
      throw new MarkdownError(`"${label}" has no date. Write [@2026-11-21](date:new), or [@2026-11-21 14:30](date:new) for a time.`)
    }
    const same = ev?.at && localDay(ev.at) === when[0] && localTime(ev.at) === when[1]
    const at = same ? ev.at! : stamp(when[0], when[1])
    const id = ev?.id ?? randomUUID()
    if (!same) this.effects.dates.push({ id, at, isNew: !ev })
    return { type: 'dateChip', attrs: { id, at } }
  }

  private describe(ref: string, t: Tokens.Link, open: M[]): N[] {
    let id: string
    if (ref === 'new') {
      if (!t.title) throw new MarkdownError(`A new description needs its text as the link title: [${t.text}](desc:new "the hidden text").`)
      id = randomUUID()
      const title = plainText(this.inline(t.tokens))
      this.effects.descriptions.push({ id, title: title === '›' ? '' : title, text: t.title })
    } else {
      const d = this.own('description', ref)
      if (!d) throw new MarkdownError(`desc:${ref} is not a description of this text. Write [phrase](desc:new "text") for a new one.`)
      id = d.id
    }
    return this.inline(t.tokens, [...open, { type: 'describe', attrs: { descId: id } }])
  }

  private image(t: Tokens.Image): N {
    const src = t.href.startsWith('file:') ? this.ctx.files + t.href.slice(5) : t.href
    return { type: 'image', attrs: { src, alt: decode(t.text) || null, title: t.title || null } }
  }
}

const plainText = (nodes: N[]) => nodes.map((n) => n.text ?? '').join('').trim()

/** Spaces at the ends of a line are not text in Markdown. */
function trimInline(nodes: N[]): N[] {
  const out = nodes.map((n) => ({ ...n }))
  const first = out[0]
  const last = out.at(-1)
  if (first?.type === 'text') first.text = first.text!.replace(/^\s+/, '')
  if (last?.type === 'text') last.text = last.text!.replace(/\s+$/, '')
  return out.filter((n) => n.type !== 'text' || n.text)
}

const lex = (md: string) => marked.lexer(md.replace(/\r\n?/g, '\n'), { gfm: true }).filter((t) => t.type !== 'space')

/** What a block holds that must not get lost: text, dates, descriptions, secrets, pictures, links. */
function contentOf(nodes: N[]): string {
  const out: string[] = []
  const walk = (n: N) => {
    if (n.text) out.push(n.text)
    for (const m of n.marks ?? []) if (m.type === 'describe' || m.type === 'link') out.push(`${m.type}:${String(m.attrs?.descId ?? m.attrs?.href)}`)
    if (n.attrs?.descId) out.push(`desc:${String(n.attrs.descId)}`)
    if (n.type === 'dateChip' || n.type === 'secret' || n.type === 'image') out.push(`${n.type}:${String(n.attrs?.id ?? n.attrs?.data ?? n.attrs?.src)}`)
    n.content?.forEach(walk)
  }
  nodes.forEach(walk)
  return out.join('\u0000')
}

/**
 * New text for a body: Markdown `md` replaces the old document. Only the changed stretch is
 * parsed: blocks before the first changed character and after the last one keep their nodes,
 * so nothing Markdown cannot say is lost where the agent did not write. A changed block that
 * Markdown cannot hold whole (say a list inside a table cell) is refused rather than damaged.
 */
export function applyMarkdown(oldDoc: unknown, md: string, ctx: Context): { doc: N; effects: Effects } {
  const old = blocksOf(oldDoc, ctx)
  const text = md.replace(/\r\n?/g, '\n')
  const before = old.map((b) => b.md).join('\n\n')
  const starts: number[] = []
  old.reduce((at, b) => (starts.push(at), at + b.md.length + 2), 0)
  const end = (i: number) => starts[i]! + old[i]!.md.length
  let p = 0
  while (p < before.length && p < text.length && before[p] === text[p]) p++
  let q = 0
  while (q < before.length - p && q < text.length - p && before[before.length - 1 - q] === text[text.length - 1 - q]) q++
  // Kept: whole blocks, with the blank line after (before) them, inside the unchanged start (end).
  let k = 0
  while (k < old.length && end(k) + 2 <= p) k++
  let j = old.length
  while (j > k && starts[j - 1]! - 2 >= before.length - q) j--
  let from = k ? end(k - 1) + 2 : 0
  // Indented new text continues the block above it (a nested list item): parse that block too.
  while (k > 0 && /^[ \t]/.test(text.slice(from))) from = --k ? end(k - 1) + 2 : 0
  const to = j < old.length ? text.length - (before.length - (starts[j]! - 2)) : text.length
  const middle = text.slice(from, Math.max(from, to))
  const parser = new Parser(ctx, oldDoc)
  const parsed = parser.blocks(lex(middle))
  // Still there = at least half of its longer words survive; gone or rewritten is the agent's call.
  const words = (x: string) => new Set(x.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [])
  const now = words(middle)
  for (const b of old.slice(k, j)) {
    const whole = contentOf(new Parser(ctx, oldDoc).blocks(lex(b.md))) === contentOf(b.nodes)
    const own = [...words(b.md)]
    if (!whole && own.filter((w) => now.has(w)).length * 2 >= own.length)
      throw new MarkdownError(`This part holds more than Markdown can carry (for example a list inside a table cell), so it can only be changed in the app: ${JSON.stringify(b.md.slice(0, 80))}. Edit around it.`)
  }
  const content = [...old.slice(0, k).flatMap((b) => b.nodes), ...parsed, ...old.slice(j).flatMap((b) => b.nodes)]
  return { doc: { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] }, effects: parser.effects }
}

/** Markdown parsed as a whole; `oldDoc` lends its Secret blocks (a secret link must be one of them). */
export function parse(md: string, ctx: Context, oldDoc?: unknown): { doc: N; effects: Effects } {
  const parser = new Parser(ctx, oldDoc)
  const content = parser.blocks(lex(md))
  return { doc: { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] }, effects: parser.effects }
}

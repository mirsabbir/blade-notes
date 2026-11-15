import { isHidden, localDay, ymd, type Change, type Item, type PushResponse, type Settings } from '@blade-notes/core'
import { pull, push } from '../sync'
import { shortIds, type N } from './markdown'

/**
 * The account as the agent server sees it: a copy of every synced record, kept in the warm
 * Lambda and brought up to date before each request with the sync protocol itself ("what
 * changed after my cursor": one indexed query, usually empty). Reads never scan the table;
 * writes go through the same `push` as every device, so the same rules hold.
 */
export interface Library {
  pk: string
  items: { [id: string]: Item }
  bodies: { [id: string]: { doc: unknown; seq: number; updatedAt: string } }
  settings?: Settings
  cursor: number
  /** When the copy was last read whole (see `open`). */
  loadedAt: number
  /** Plain text of each body, for search, kept while the body's seq is the same. */
  texts: Map<string, { seq: number; text: string }>
}

const cache = new Map<string, Library>()

/**
 * The account, up to date. The `bySeq` index is eventually consistent, so a pull can in rare
 * cases step past a record it has not seen yet; reading everything again every 15 minutes
 * repairs that.
 */
export async function open(sub: string): Promise<Library> {
  let lib = cache.get(sub)
  if (!lib || lib.loadedAt < Date.now() - 15 * 60_000)
    cache.set(sub, (lib = { pk: `USER#${sub}`, items: {}, bodies: {}, cursor: 0, loadedAt: Date.now(), texts: lib?.texts ?? new Map() }))
  await catchUp(lib)
  return lib
}

async function catchUp(lib: Library): Promise<void> {
  for (let more = true; more; ) {
    const page = await pull(lib.pk, lib.cursor)
    for (const r of page.records) {
      if (r.kind === 'item') lib.items[r.data.id] = r.data
      else if (r.kind === 'settings') lib.settings = r.data
      else if (r.seq >= (lib.bodies[r.data.id]?.seq ?? 0)) lib.bodies[r.data.id] = { doc: r.data.doc, seq: r.seq, updatedAt: r.data.updatedAt }
    }
    lib.cursor = page.cursor
    more = page.more
  }
}

/** Stores changes like a device would. What was accepted goes into the copy at once (the index may lag). */
export async function save(lib: Library, changes: Change[]): Promise<PushResponse> {
  const res = await push(lib.pk, { changes })
  for (const a of res.accepted) {
    const c = changes.find((x) => x.kind === a.kind && x.data.id === a.id)!
    if (c.kind === 'item') lib.items[a.id] = c.data
    else if (c.kind === 'body') lib.bodies[a.id] = { doc: c.data.doc, seq: a.seq, updatedAt: c.data.updatedAt }
  }
  await catchUp(lib)
  return res
}

/** A mistake the agent can fix: the message says how. */
export class ToolError extends Error {}

export type Visible = 'space' | 'folder' | 'note' | 'task'
const live = (it: Item) => !it.deletedAt && !it.purgedAt

/** Plain text of a Tiptap document, one line per paragraph, heading or code block. */
export function plain(doc: unknown): string {
  const lines: string[] = []
  const inline = (n: N): string =>
    n.text ?? (n.type === 'secret' ? String(n.attrs?.label ?? '') : n.type === 'hardBreak' ? ' ' : (n.content ?? []).map(inline).join(''))
  const walk = (n: N): void => {
    if (n.type === 'paragraph' || n.type === 'heading' || n.type === 'codeBlock') lines.push(inline(n))
    else n.content?.forEach(walk)
  }
  walk((doc ?? {}) as N)
  return lines.filter(Boolean).join('\n')
}

/** Lower case without accents (so "zurich" finds "Zürich"); scripts like Bangla keep their marks. */
export const fold = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()

/** One request's view of the library: tree, paths, short ids, text. Time zone = process.env.TZ. */
export class View {
  readonly today = ymd(new Date())
  private readonly kidsOf = new Map<string | null, Item[]>()
  private readonly shorts: Map<string, string>

  constructor(readonly lib: Library) {
    for (const it of Object.values(lib.items)) {
      if (it.purgedAt) continue
      const list = this.kidsOf.get(it.parentId)
      if (list) list.push(it)
      else this.kidsOf.set(it.parentId, [it])
    }
    for (const list of this.kidsOf.values()) list.sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0))
    this.shorts = shortIds(Object.keys(lib.items))
  }

  get items() {
    return this.lib.items
  }

  short(id: string): string {
    return this.shorts.get(id) ?? id
  }

  /** Children that show in the blades (no descriptions or dates), in order. */
  kids(parentId: string | null, trash = false): Item[] {
    return (this.kidsOf.get(parentId) ?? []).filter((c) => !isHidden(c) && (trash || !c.deletedAt))
  }

  /** Every visible item under `id`, at any depth. */
  under(id: string | null, trash = false): Item[] {
    const out: Item[] = []
    const seen = new Set<string>()
    const go = (p: string | null) => this.kids(p, trash).forEach((c) => !seen.has(c.id) && (seen.add(c.id), out.push(c), go(c.id)))
    go(id)
    return out
  }

  /** The places above an item, nearest first; stops at a loop (two devices moved A into B and B into A). */
  above(it: Item): Item[] {
    const out: Item[] = []
    const seen = new Set([it.id])
    for (let cur = it.parentId ? this.items[it.parentId] : undefined; cur && !seen.has(cur.id); cur = cur.parentId ? this.items[cur.parentId] : undefined) {
      seen.add(cur.id)
      out.push(cur)
    }
    return out
  }

  /** When the item or its text last changed (ISO). */
  edited(it: Item): string {
    const body = this.lib.bodies[it.id]?.updatedAt
    return body && body > it.updatedAt ? body : it.updatedAt
  }

  /** The note or task a description or date belongs to (descriptions nest). */
  owner(it: Item): Item | undefined {
    return isHidden(it) ? this.above(it).find((p) => !isHidden(p)) : it
  }

  /** Where an item lives: `Work/Projects` (its places, not itself). */
  path(it: Item): string {
    return this.above(it)
      .filter((p) => !isHidden(p))
      .map((p) => p.title || 'Untitled')
      .reverse()
      .join('/')
  }

  space(it: Item): Item | undefined {
    const top = it.parentId ? this.above(it).at(-1) : it
    return top?.type === 'space' ? top : undefined
  }

  /** The text of a body and of the descriptions inside it, for search. */
  text(id: string): string {
    const body = this.lib.bodies[id]
    let own = ''
    if (body) {
      const hit = this.lib.texts.get(id)
      if (hit?.seq === body.seq) own = hit.text
      else this.lib.texts.set(id, { seq: body.seq, text: (own = plain(body.doc)) })
    }
    const descs = (this.kidsOf.get(id) ?? []).filter((d) => d.type === 'description' && live(d))
    return [own, ...descs.map((d) => `${d.title}\n${this.text(d.id)}`)].filter(Boolean).join('\n')
  }

  /**
   * An item from what an agent wrote: a full id, the start of one (4+ characters), a path
   * (`Work/Projects/Q4 plan`) or a title found once. Errors list what would match.
   */
  resolve(ref: string, opts: { trash?: boolean; hidden?: boolean } = {}): Item {
    const r = ref.trim().replace(/^["'`]|["'`]$/g, '')
    if (!r) throw new ToolError('An id or a path is needed.')
    const ok = (it: Item) => !it.purgedAt && (opts.trash || !it.deletedAt) && (opts.hidden || !isHidden(it))
    const exact = this.items[r]
    if (exact && ok(exact)) return exact
    const parts = r.split(/\s*[/›]\s*/).filter(Boolean)
    const named = (list: Item[], title: string) => list.filter((c) => ok(c) && fold(c.title.trim()) === fold(title))
    // A short id, unless it is also exactly a title ("2025"): then say both.
    if (/^[0-9a-f][0-9a-f-]{5,}$/i.test(r)) {
      const found = Object.values(this.items).filter((it) => ok(it) && it.id.startsWith(r.toLowerCase()))
      const titled = named(Object.values(this.items), r)
      if (found.length && titled.length) throw new ToolError(`"${r}" is the start of an id and a title. Use the full id ${found[0]!.id}, or the path of "${titled[0]!.title}".`)
      if (found.length === 1) return found[0]!
      if (found.length > 1) throw new ToolError(`"${r}" is the start of ${found.length} ids: ${found.slice(0, 5).map((f) => `${f.id} (${f.title})`).join(', ')}. Use more of the id.`)
    }
    if (parts.length > 1 || !parts.length) {
      let cur: Item | null = null
      for (const part of parts) {
        const list = this.kids(cur?.id ?? null, opts.trash)
        const found = named(list, part)
        if (found.length !== 1) {
          const where = cur ? `in ${[this.path(cur), cur.title].filter(Boolean).join('/')}` : 'at the top (spaces)'
          if (found.length > 1) throw new ToolError(`${found.length} items are called "${part}" ${where}: ${found.map((f) => this.short(f.id)).join(', ')}. Use an id.`)
          throw new ToolError(`Nothing called "${part}" ${where}. There: ${list.slice(0, 15).map((c) => c.title).join(', ') || 'nothing'}.`)
        }
        cur = found[0]!
      }
      return cur!
    }
    const found = named(Object.values(this.items), r)
    if (found.length === 1) return found[0]!
    if (found.length > 1) throw new ToolError(`${found.length} items are called "${r}": ${found.slice(0, 8).map((f) => `${this.short(f.id)} in ${this.path(f) || 'top'}`).join(', ')}. Use an id or a path.`)
    throw new ToolError(`Nothing matches "${r}". Use an id from search or browse, or a path like Work/Projects/Plan.`)
  }

  /** Day (YYYY-MM-DD, this zone) a task is due or a date falls on. */
  dayOf(it: Item): string | undefined {
    const when = it.type === 'event' ? it.at : it.due
    return when ? localDay(when) : undefined
  }

  isOpen(it: Item): boolean {
    return (it.type === 'task' || it.type === 'event') && it.status !== 'done'
  }
}

export interface Counts {
  space: number
  folder: number
  note: number
  task: number
  open: number
  overdue: number
  today: number
}

/** How many of each kind, and how many open tasks are late or due today. */
export function counts(v: View, list: Item[]): Counts {
  const c: Counts = { space: 0, folder: 0, note: 0, task: 0, open: 0, overdue: 0, today: 0 }
  for (const it of list) {
    c[it.type as Visible]++
    if (it.type !== 'task' || it.status === 'done') continue
    c.open++
    const day = v.dayOf(it)
    if (day && day < v.today) c.overdue++
    else if (day === v.today) c.today++
  }
  return c
}

export interface SearchQuery {
  query?: string
  types?: Visible[]
  in?: string
  status?: Item['status'][]
  priority?: NonNullable<Item['priority']>[]
  due_after?: string
  due_before?: string
  overdue?: boolean
  updated_after?: string
  updated_before?: string
  pinned?: boolean
  has_attachments?: boolean
  trash?: boolean
}

export interface Hit {
  item: Item
  score: number
  snippet?: string
}

/**
 * Filters, then full text over titles, note text and the descriptions inside it. Words must all
 * be there ("quoted phrases" as written); with none of the items having all of them, items with
 * most of them come back and `partial` says so.
 */
export function search(v: View, q: SearchQuery): { hits: Hit[]; partial: boolean } {
  const scope = q.in ? v.resolve(q.in, { trash: q.trash }) : null
  let list = scope ? v.under(scope.id, q.trash) : v.under(null, q.trash)
  if (q.trash) list = list.filter((it) => it.deletedAt)
  list = list.filter(
    (it) =>
      (!q.types?.length || q.types.includes(it.type as Visible)) &&
      (!q.status?.length || (it.type === 'task' && q.status.includes(it.status ?? 'todo'))) &&
      (!q.priority?.length || q.priority.includes(it.priority ?? 'none')) &&
      (!q.due_after || ((v.dayOf(it) ?? '') >= q.due_after && it.type === 'task')) &&
      (!q.due_before || (!!v.dayOf(it) && v.dayOf(it)! <= q.due_before && it.type === 'task')) &&
      (!q.overdue || (v.isOpen(it) && it.type === 'task' && !!v.dayOf(it) && v.dayOf(it)! < v.today)) &&
      (!q.updated_after || localDay(v.edited(it)) >= q.updated_after) &&
      (!q.updated_before || localDay(v.edited(it)) <= q.updated_before) &&
      (q.pinned === undefined || !!it.pinned === q.pinned) &&
      (q.has_attachments === undefined || (it.attachments ?? []).some((a) => !a.deletedAt && !a.purgedAt) === q.has_attachments),
  )
  const terms = [...(q.query ?? '').matchAll(/"([^"]+)"|(\S+)/g)].map((m) => fold(m[1] ?? m[2]!)).filter(Boolean)
  if (!terms.length) return { hits: list.map((item) => ({ item, score: 0 })), partial: false }
  const scored = list.map((item) => {
    const title = fold(item.title)
    const text = v.text(item.id)
    const body = fold(text)
    let found = 0
    let score = 0
    for (const t of terms) {
      const inTitle = title.includes(t)
      const times = body.split(t).length - 1
      if (inTitle || times) found++
      score += (inTitle ? 10 + (title === t ? 10 : title.startsWith(t) ? 3 : 0) : 0) + Math.min(times, 5)
    }
    return { item, score, found, snippet: snippet(text, body, terms) }
  })
  const all = scored.filter((s) => s.found === terms.length)
  const partial = !all.length && terms.length > 1
  const hits = (partial ? scored.filter((s) => s.found > 0).map((s) => ({ ...s, score: s.score * (s.found / terms.length) })) : all).map(({ found: _, ...h }) => h)
  return { hits, partial }
}

/** About 160 characters around the first word found in the text. */
function snippet(text: string, folded: string, terms: string[]): string | undefined {
  const at = Math.min(...terms.map((t) => folded.indexOf(t)).filter((i) => i >= 0))
  if (!Number.isFinite(at)) return undefined
  const from = Math.max(0, text.lastIndexOf(' ', Math.max(0, at - 60)) + 1)
  const cut = text.slice(from, from + 160).replace(/\s+/g, ' ').trim()
  return `${from > 0 ? '…' : ''}${cut}${from + 160 < text.length ? '…' : ''}`
}

export interface Entry {
  day: string
  item: Item
  /** For a date written in a text: the note or task it is in. */
  owner?: Item
}

/** Due tasks and dates written with @, from `from` to `to` (days in this zone), plus what is late. */
export function agenda(v: View, from: string, to: string, opts: { done?: boolean; in?: string }): { late: Entry[]; days: Entry[] } {
  const scope = opts.in ? v.resolve(opts.in) : null
  const inScope = scope ? new Set([scope.id, ...v.under(scope.id).map((i) => i.id)]) : null
  const late: Entry[] = []
  const days: Entry[] = []
  for (const it of Object.values(v.items)) {
    if (!live(it) || (it.type !== 'task' && it.type !== 'event')) continue
    const owner = it.type === 'event' ? v.owner(it) : undefined
    if (it.type === 'event' && (!owner || !live(owner))) continue
    if (inScope && !inScope.has((owner ?? it).id)) continue
    const day = v.dayOf(it)
    if (!day) continue
    const entry = { day, item: it, ...(owner && { owner }) }
    if (day >= from && day <= to && (opts.done || v.isOpen(it))) days.push(entry)
    else if (day < from && day < v.today && v.isOpen(it)) late.push(entry)
  }
  const when = (e: Entry) => (e.item.type === 'event' ? e.item.at : e.item.due) ?? ''
  const order = (a: Entry, b: Entry) => (a.day !== b.day ? (a.day < b.day ? -1 : 1) : when(a).length !== when(b).length ? when(a).length - when(b).length : Date.parse(when(a)) - Date.parse(when(b)))
  return { late: late.sort(order), days: days.sort(order) }
}

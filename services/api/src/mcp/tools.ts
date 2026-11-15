import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod'
import {
  addDays, applyRestore, between, eventChanges, isHidden, liveAttachments, localDay, localTime, restorePlan, stamp, trashIds, TRASH_DAYS, withOffset,
  type Change, type Item, type Priority, type TaskStatus,
} from '@blade-notes/core'
import { agenda, counts, open, save, search, ToolError, View, type Counts, type Library, type Visible } from './library'
import { applyMarkdown, dateLabel, MarkdownError, parse, parseWhen, shortIds, toMarkdown, type Context } from './markdown'

/** Who is calling: from the access token (oauth.ts). */
export interface Caller {
  sub: string
  scopes: string[]
  /** The time zone of the browser that approved the connection. */
  zone?: string
}

export const INSTRUCTIONS = `Blade Notes is the user's own notes and tasks app. These tools read and change their library.

THE LIBRARY
- One tree. Spaces are the top level (e.g. Work, Personal). Under them, at any depth: folders, notes and tasks; a note or task can hold items too.
- A task has a status (todo, doing, done), a priority (none, low, medium, high) and maybe a due date.
- Deleting moves things to the trash for ${TRASH_DAYS} days; restore brings them back. Deleting for good is only done in the app.

REFERRING TO ITEMS
Every answer shows short ids (8+ characters). Pass a short or full id, a path (Work/Projects/Q4 plan) or an exact title that is unique.

HOW TO WORK WELL
- Unsure what is there: overview, then browse. Looking for something: search (filters work without words; count_by answers "how many"). Dates and due tasks: agenda. Full text: read.
- read takes up to 10 items at once; create, update and trash take lists. Prefer one batched call over many single ones.
- Read before you edit, and edit with replace (only the text you name changes) rather than set (the whole text).
- Days and times are in the user's time zone, named in the answers.
- Ask the user before trashing several items or rewriting a long text.

TEXT IS MARKDOWN
Headings, lists, checklists (- [ ] / - [x]), quotes, code, tables, links, **bold**, *italic*, ~~strike~~, <u>underline</u>, <mark>highlight</mark>, <br> for a line break inside a paragraph.
Parts of the app are links. Keep them exactly as they are when you edit around them:
- [@Fri 2026-11-21 09:00](date:3f9a1c2e) a date. It shows in the agenda and the user's calendar. New: [@2026-11-21](date:new) or [@2026-11-21 14:30](date:new). Change the date or time in the label to move it; delete the link to remove it.
- [phrase](desc:5b2e0c11) hidden text behind a phrase; "- item [›](desc:5b2e0c11)" behind a list item. read lists their text under the note; edit one with its id. New: [phrase](desc:new "the hidden text").
- [🔒 label](secret:7c1e2a90) a Secret block, encrypted in the user's browser. You never see its content and cannot make one; you may move or delete it.
- ![name](file:<file>.png) a picture stored with the note.`

const TYPE = z.enum(['space', 'folder', 'note', 'task'])
const STATUS = z.enum(['todo', 'doing', 'done'])
const PRIORITY = z.enum(['none', 'low', 'medium', 'high'])
const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a day like 2026-11-21')
const REF = z.string().min(1).describe('Short id, full id, path (Work/Projects/Plan) or a unique title')
const WHEN = z.string().describe('2026-11-21 (all day), 2026-11-21 14:30 (in the user\'s time zone) or an ISO time with offset')
const PLACE = {
  in: REF.optional().describe('Where it goes: a space, folder, note or task'),
  position: z.enum(['first', 'last']).optional().describe('Among the items there; default last'),
  after: REF.optional().describe('Put it right after this item (same place)'),
}
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }

/** The MCP server for one request; write tools only with the notes:write scope. */
export function server(caller: Caller): McpServer {
  const s = new McpServer(
    { name: 'blade-notes', title: 'Blade Notes', version: '1.0.0' },
    // Stateless: the tool list never changes during a connection, so there is nothing to listen for.
    { instructions: INSTRUCTIONS, capabilities: { tools: { listChanged: false } } },
  )
  const write = caller.scopes.includes('notes:write')

  s.registerTool('overview', { title: 'Library overview', description: 'The whole library at a glance: today and the time zone, totals, each space with its counts, recent edits, what is late. Call it first when you do not know the library.', annotations: READ }, () =>
    run(caller, undefined, (v) => overview(v)),
  )

  s.registerTool(
    'browse',
    {
      title: 'Browse the tree',
      description: 'The items under a place as an indented tree, in the order the app shows them. Without `in`: all spaces.',
      inputSchema: z.object({
        in: REF.optional(),
        depth: z.number().int().min(1).max(6).default(2).describe('Levels to show'),
        trash: z.boolean().default(false).describe('Include items in the trash'),
      }),
      annotations: READ,
    },
    (a) => run(caller, undefined, (v) => browse(v, a)),
  )

  s.registerTool(
    'search',
    {
      title: 'Search and filter',
      description:
        'Finds items by words (titles, note text, hidden descriptions; all words must be there, "quoted phrases" as written) and/or filters. Without words it lists by filter. count_by returns only counts, e.g. "how many open tasks per space".',
      inputSchema: z.object({
        query: z.string().optional(),
        types: z.array(TYPE).optional(),
        in: REF.optional().describe('Only inside this space, folder, note or task (any depth)'),
        status: z.array(STATUS).optional().describe('Tasks with this status'),
        priority: z.array(PRIORITY).optional(),
        due_after: DAY.optional(),
        due_before: DAY.optional(),
        overdue: z.boolean().optional().describe('Open tasks due before today'),
        updated_after: DAY.optional(),
        updated_before: DAY.optional(),
        pinned: z.boolean().optional(),
        has_attachments: z.boolean().optional(),
        trash: z.boolean().optional().describe('Search the trash instead'),
        sort: z.enum(['relevance', 'updated', 'created', 'due', 'title']).optional().describe('Default: relevance with words, else updated'),
        limit: z.number().int().min(1).max(100).default(20),
        offset: z.number().int().min(0).default(0),
        count_by: z.enum(['type', 'space', 'status', 'priority']).optional(),
      }),
      annotations: READ,
    },
    (a) => run(caller, undefined, (v) => find(v, a)),
  )

  s.registerTool(
    'agenda',
    {
      title: 'Agenda',
      description: 'Tasks due and dates written in notes (@), day by day, plus what is late. Default: today and the next 6 days.',
      inputSchema: z.object({
        from: DAY.optional().describe('First day; default today'),
        days: z.number().int().min(1).max(92).default(7),
        include_done: z.boolean().default(false),
        in: REF.optional(),
        timezone: z.string().optional().describe('IANA zone such as Asia/Dhaka, when the user is not where the app thinks'),
      }),
      annotations: READ,
    },
    (a) => run(caller, a.timezone, (v) => schedule(v, a)),
  )

  s.registerTool(
    'read',
    {
      title: 'Read items',
      description: 'Full content of up to 10 items: details, text as Markdown (with its version for edit), hidden descriptions, attachments, what is inside.',
      inputSchema: z.object({
        refs: z.array(REF).min(1).max(10),
        descriptions: z.boolean().default(true).describe('Include the text of hidden descriptions'),
        offset: z.number().int().min(0).default(0).describe('For a very long text: where to start (characters)'),
        max_chars: z.number().int().min(1000).max(100_000).default(40_000),
      }),
      annotations: READ,
    },
    (a) => run(caller, undefined, (v) => a.refs.map((r) => read(v, v.resolve(r, { hidden: true, trash: true }), a)).join('\n\n========\n\n')),
  )

  if (!write) return s

  s.registerTool(
    'create',
    {
      title: 'Create items',
      description: 'Creates spaces, folders, notes and tasks (up to 50). Later items may be placed in earlier ones by path. Text is Markdown.',
      inputSchema: z.object({
        items: z
          .array(
            z.object({
              type: TYPE,
              title: z.string().min(1).max(500),
              ...PLACE,
              text: z.string().optional().describe('Markdown text of a note or task'),
              status: STATUS.optional(),
              priority: PRIORITY.optional(),
              due: WHEN.optional(),
              pinned: z.boolean().optional(),
              color: z.string().optional().describe('Spaces: a CSS colour for the dot'),
            }),
          )
          .min(1)
          .max(50),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (a) => run(caller, undefined, (_, lib) => create(lib, a.items)),
  )

  s.registerTool(
    'update',
    {
      title: 'Update items',
      description:
        'Changes title, status, priority, due date, pin, colour, or moves items (up to 50). Also takes dates (date:… ids from a text): due moves the date, status done ticks it, title renames it. Text changes go through edit.',
      inputSchema: z.object({
        items: z
          .array(
            z.object({
              ref: REF,
              title: z.string().min(1).max(500).optional(),
              status: STATUS.optional(),
              priority: PRIORITY.optional(),
              due: WHEN.nullable().optional().describe('null removes a task\'s due date'),
              pinned: z.boolean().optional(),
              color: z.string().optional(),
              ...PLACE,
            }),
          )
          .min(1)
          .max(50),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    (a) => run(caller, undefined, (_, lib) => update(lib, a.items)),
  )

  s.registerTool(
    'edit',
    {
      title: 'Edit text',
      description:
        'Changes the Markdown text of a note, task or hidden description. replace changes only the text you name (find must match once, or set all). prepend/append add text; set replaces everything. Pass version from read to be sure nobody changed it since.',
      inputSchema: z.object({
        ref: REF,
        version: z.number().int().optional(),
        replace: z.array(z.object({ find: z.string().min(1), with: z.string(), all: z.boolean().default(false) })).optional(),
        prepend: z.string().optional(),
        append: z.string().optional(),
        set: z.string().optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    (a) => run(caller, undefined, (v, lib) => edit(v, lib, a)),
  )

  s.registerTool(
    'trash',
    {
      title: 'Trash or restore',
      description: `Moves items, with everything inside them, to the trash (kept ${TRASH_DAYS} days), or restores them with restore: true. Find what is in the trash with search trash: true.`,
      inputSchema: z.object({ refs: z.array(REF).min(1).max(50), restore: z.boolean().default(false) }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    (a) => run(caller, undefined, (v, lib) => trash(v, lib, a.refs, a.restore)),
  )
  return s
}

type Result = { content: { type: 'text'; text: string }[]; isError?: boolean }

/** Loads the library in the caller's zone, runs one tool, and turns mistakes into answers the agent can act on. */
async function run(caller: Caller, zone: string | undefined, fn: (v: View, lib: Library) => string | Promise<string>): Promise<Result> {
  try {
    const lib = await open(caller.sub)
    process.env.TZ = zoneOf(lib, caller, zone)
    return { content: [{ type: 'text', text: await fn(new View(lib), lib) }] }
  } catch (err) {
    if (err instanceof ToolError || err instanceof MarkdownError) return { content: [{ type: 'text', text: err.message }], isError: true }
    throw err
  }
}

/** The IANA name of a zone (`asia/dhaka` → `Asia/Dhaka`), or null: offsets like -05:00 are not zones for process.env.TZ. */
function zoneName(z?: string): string | null {
  try {
    const name = z ? new Intl.DateTimeFormat('en', { timeZone: z }).resolvedOptions().timeZone : ''
    return name === 'UTC' || /^[A-Za-z_]+\/[A-Za-z0-9_+\-/]+$/.test(name) ? name : null
  } catch {
    return null
  }
}

/** The zone asked for, else the one of the device that last set a date, else the one at connecting. */
function zoneOf(lib: Library, caller: Caller, wanted?: string): string {
  if (wanted) return zoneName(wanted) ?? fail(`"${wanted}" is not a time zone; use an IANA name like Asia/Dhaka.`)
  let latest: Item | undefined
  for (const it of Object.values(lib.items)) if (it.type === 'event' && it.tz && (!latest || it.createdAt > latest.createdAt)) latest = it
  return zoneName(latest?.tz) ?? zoneName(caller.zone) ?? 'UTC'
}

const fail = (message: string): never => {
  throw new ToolError(message)
}

// ---------------- reading ----------------

/** A stored moment as a day in this zone: `Sat 2026-11-15`. */
const day = (iso: string) => dateLabel(localDay(iso))
const edited = (v: View, it: Item) => dateLabel(withOffset(new Date(v.edited(it))))

function kind(v: View, it: Item): string {
  if (it.type !== 'task' && it.type !== 'event') return `[${it.type}]`
  const facts = [it.status ?? 'todo', it.priority && it.priority !== 'none' ? it.priority : '', it.due ? `due ${dateLabel(it.due)}` : '', it.at ? dateLabel(it.at) : '']
  return `[${it.type === 'event' ? 'date' : 'task'}: ${facts.filter(Boolean).join(', ')}${v.isOpen(it) && v.dayOf(it)! < v.today ? ', late' : ''}]`
}

function line(v: View, it: Item, opts: { where?: boolean; inside?: boolean } = {}): string {
  const inside = opts.inside ? v.kids(it.id).length : 0
  return [
    `${kind(v, it)} ${it.title || 'Untitled'}`,
    v.short(it.id),
    opts.where !== false && it.parentId ? `in ${v.path(it)}` : '',
    inside ? `${inside} inside` : '',
    it.pinned ? 'pinned' : '',
    it.deletedAt ? `in the trash since ${day(it.deletedAt)}` : '',
    `edited ${edited(v, it)}`,
  ]
    .filter(Boolean)
    .join(' · ')
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
function summary(c: Counts): string {
  const tasks = c.task ? `${plural(c.task, 'task')} (${[`${c.open} open`, c.overdue && `${c.overdue} late`, c.today && `${c.today} due today`].filter(Boolean).join(', ')})` : ''
  return [c.space && plural(c.space, 'space'), c.folder && plural(c.folder, 'folder'), c.note && plural(c.note, 'note'), tasks].filter(Boolean).join(' · ') || 'empty'
}

function overview(v: View): string {
  const all = v.under(null)
  const trashed = Object.values(v.items).filter((it) => it.deletedAt && !it.purgedAt && !isHidden(it) && !(it.parentId && v.items[it.parentId]?.deletedAt === it.deletedAt))
  const recent = [...all].filter((it) => it.type !== 'space').sort((a, b) => v.edited(b).localeCompare(v.edited(a))).slice(0, 8)
  const week = agenda(v, v.today, addDays(v.today, 6), {})
  return [
    `Blade Notes · today is ${dateLabel(v.today)} · time zone ${process.env.TZ}`,
    `Library: ${summary(counts(v, all))} · ${plural(trashed.length, 'item')} in the trash`,
    '',
    'Spaces:',
    ...v.kids(null).map((sp) => `- ${line(v, sp, { where: false })} · ${summary(counts(v, v.under(sp.id)))}`),
    '',
    'Recently edited:',
    ...recent.map((it) => `- ${line(v, it)}`),
    '',
    `Late: ${week.late.length} · next 7 days: ${week.days.length} dated items (agenda lists them).`,
  ].join('\n')
}

function browse(v: View, a: { in?: string; depth: number; trash: boolean }): string {
  const root = a.in ? v.resolve(a.in, { trash: a.trash }) : null
  const out: string[] = [root ? `${line(v, root)}\n${summary(counts(v, v.under(root.id)))}` : `All spaces · ${summary(counts(v, v.under(null)))}`]
  let shown = 0
  const go = (parent: string | null, level: number) => {
    for (const it of v.kids(parent, a.trash)) {
      if (++shown > 400) return
      out.push(`${'  '.repeat(level)}- ${line(v, it, { where: false, inside: level === a.depth - 1 })}`)
      if (level < a.depth - 1) go(it.id, level + 1)
    }
  }
  go(root?.id ?? null, 0)
  if (shown > 400) out.push(`… more than 400 items: browse a deeper place, or use search.`)
  if (out.length === 1) out.push('(empty)')
  return out.join('\n')
}

type FindArgs = Parameters<typeof search>[1] & { sort?: string; limit: number; offset: number; count_by?: 'type' | 'space' | 'status' | 'priority' }
function find(v: View, a: FindArgs): string {
  const { hits, partial } = search(v, a)
  if (a.count_by) {
    const tally = new Map<string, number>()
    for (const { item } of hits) {
      const key = a.count_by === 'type' ? item.type : a.count_by === 'space' ? (v.space(item)?.title ?? '(none)') : a.count_by === 'status' ? (item.type === 'task' ? (item.status ?? 'todo') : '(not a task)') : (item.priority ?? 'none')
      tally.set(key, (tally.get(key) ?? 0) + 1)
    }
    return `${hits.length} found${partial ? ' (some of the words)' : ''}. By ${a.count_by}: ${[...tally].sort((x, y) => y[1] - x[1]).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`
  }
  const sort = a.sort ?? (a.query ? 'relevance' : 'updated')
  const by: { [k: string]: (x: (typeof hits)[0], y: (typeof hits)[0]) => number } = {
    relevance: (x, y) => y.score - x.score || v.edited(y.item).localeCompare(v.edited(x.item)),
    updated: (x, y) => v.edited(y.item).localeCompare(v.edited(x.item)),
    created: (x, y) => y.item.createdAt.localeCompare(x.item.createdAt),
    due: (x, y) => (v.dayOf(x.item) ?? '9999').localeCompare(v.dayOf(y.item) ?? '9999'),
    title: (x, y) => x.item.title.localeCompare(y.item.title),
  }
  const page = hits.sort(by[sort]).slice(a.offset, a.offset + a.limit)
  const head = hits.length
    ? `${hits.length} found${partial ? ' (no item has all the words; these have some)' : ''}, showing ${a.offset + 1}–${a.offset + page.length} by ${sort}.${a.offset + page.length < hits.length ? ` More: offset ${a.offset + page.length}.` : ''}`
    : 'Nothing found. Try fewer words, other words, or no filters.'
  return [head, ...page.map((h) => `- ${line(v, h.item)}${h.snippet ? `\n  ${h.snippet}` : ''}`)].join('\n')
}

function schedule(v: View, a: { from?: string; days: number; include_done: boolean; in?: string }): string {
  const from = a.from ?? v.today
  const to = addDays(from, a.days - 1)
  const { late, days } = agenda(v, from, to, { done: a.include_done, in: a.in })
  const entry = (e: (typeof days)[0]) => {
    const it = e.item
    const time = localTime(it.type === 'event' ? it.at! : it.due!)
    const at = time ? `${time} ` : ''
    const done = it.status === 'done' ? '✓ ' : ''
    return e.owner
      ? `- ${at}${done}${it.title} · date ${v.short(it.id)} · in ${e.owner.type} "${e.owner.title}" (${v.short(e.owner.id)}, ${v.path(e.owner) || 'top'})`
      : `- ${at}${done}${it.title} · task ${v.short(it.id)}${it.priority && it.priority !== 'none' ? ` · ${it.priority}` : ''} · ${it.status ?? 'todo'} · in ${v.path(it)}`
  }
  const out = [`Agenda ${dateLabel(from)} to ${dateLabel(to)} · time zone ${process.env.TZ}`]
  if (late.length) out.push('', 'Late:', ...late.map((e) => entry(e).replace(/^- /, `- ${dateLabel(e.day)} `)))
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const today = days.filter((e) => e.day === d)
    if (today.length) out.push('', `${dateLabel(d)}${d === v.today ? ' (today)' : ''}:`, ...today.map(entry))
  }
  if (out.length === 1) out.push('Nothing due and no dates in these days.')
  return out.join('\n')
}

const ctxOf = (v: View, ownerId: string): Context => ({ items: v.items, ownerId, files: `/api/files/${v.lib.pk.slice(5)}/` })
const size = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.ceil(n / 1e3)} kB`)

function read(v: View, it: Item, a: { descriptions: boolean; offset: number; max_chars: number }): string {
  const owner = isHidden(it) ? v.owner(it) : undefined
  const hasText = it.type === 'note' || it.type === 'task' || it.type === 'description'
  const head = [
    kind(v, it),
    v.short(it.id),
    owner ? `in ${owner.type} "${owner.title}" (${v.short(owner.id)})` : it.parentId ? `in ${v.path(it)}` : '',
    `created ${day(it.createdAt)}`,
    `edited ${edited(v, it)}`,
    it.deletedAt ? `in the trash since ${day(it.deletedAt)}` : '',
    hasText ? `version ${v.lib.bodies[it.id]?.seq ?? 0}` : '',
  ]
  const parts = [`# ${it.title || 'Untitled'}\n${head.filter(Boolean).join(' · ')}`]
  const files = liveAttachments(it)
  if (files.length) parts.push(`Attachments: ${files.map((f) => `${f.name} (${size(f.size)})`).join(', ')}`)
  const kids = v.kids(it.id)
  if (kids.length)
    parts.push(
      [`Inside: ${summary(counts(v, v.under(it.id)))}`, ...kids.slice(0, 50).map((k) => `- ${line(v, k, { where: false, inside: true })}`), ...(kids.length > 50 ? [`- … ${kids.length - 50} more (browse ${v.short(it.id)})`] : [])].join('\n'),
    )
  if (!hasText) return parts.join('\n\n')
  const md = toMarkdown(v.lib.bodies[it.id]?.doc, ctxOf(v, it.id))
  parts.push(md.slice(a.offset, a.offset + a.max_chars) || '(no text)')
  if (a.offset + a.max_chars < md.length) parts.push(`[… ${md.length - a.offset - a.max_chars} more characters: read with offset ${a.offset + a.max_chars}]`)
  const descs = Object.values(v.items).filter((d) => d.type === 'description' && d.parentId === it.id && !d.deletedAt && !d.purgedAt)
  if (a.descriptions && descs.length) {
    const short = shortIds(descs.map((d) => d.id))
    parts.push('Hidden descriptions in this text:')
    for (const d of descs) parts.push(`## desc:${short.get(d.id)} · ${d.title} · version ${v.lib.bodies[d.id]?.seq ?? 0}\n${toMarkdown(v.lib.bodies[d.id]?.doc, ctxOf(v, d.id)) || '(no text)'}`)
  }
  return parts.join('\n\n')
}

// ---------------- writing ----------------

const now = () => new Date().toISOString()

/** `2026-11-21`, `2026-11-21 14:30` (this zone) or an ISO moment → how the app stores it. */
function when(text: string): string {
  const s = text.trim()
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(s) && !Number.isNaN(Date.parse(s))
  if (iso) return withOffset(new Date(s)) // the same moment, written with this zone's offset
  const w = /^\d{4}-\d{2}-\d{2}([ T]\d{1,2}:\d{2})?$/.test(s) ? parseWhen(s) : null
  if (!w) throw new ToolError(`"${text}" is not a date. Use 2026-11-21, 2026-11-21 14:30 or an ISO time with offset.`)
  return stamp(w[0], w[1])
}

/** Where an item goes: parent and rank. */
function place(v: View, it: Item | undefined, type: Item['type'], a: { in?: string; position?: 'first' | 'last'; after?: string }): { parentId: string | null; rank: string } {
  const after = a.after ? v.resolve(a.after) : undefined
  const parent = after ? (after.parentId ? v.items[after.parentId]! : null) : a.in ? v.resolve(a.in) : it ? (it.parentId ? v.items[it.parentId]! : null) : null
  if (type === 'space' ? parent : !parent) throw new ToolError(type === 'space' ? 'Spaces are at the top: no `in`.' : `A ${type} needs a place: \`in\` a space, folder, note or task.`)
  if (it && (after?.id === it.id || parent?.id === it.id || (parent && v.above(parent).some((p) => p.id === it.id))))
    throw new ToolError(`"${it.title}" cannot go inside or after itself.`)
  const sibs = v.kids(parent?.id ?? null).filter((s) => s.id !== it?.id)
  // Two devices can give siblings the same rank: then the next one is no upper bound.
  const upper = (r: string | undefined, low: string | null) => (r !== undefined && (low === null || r > low) ? r : null)
  const i = after ? sibs.findIndex((s) => s.id === after.id) : -1
  const rank = after
    ? between(after.rank, upper(sibs[i + 1]?.rank, after.rank))
    : a.position === 'first'
      ? sibs[0]?.rank ? between(null, sibs[0].rank) : between(null, null)
      : between(sibs.at(-1)?.rank ?? null, null)
  return { parentId: parent?.id ?? null, rank }
}

/** A working copy: items changed so far in this call, seen by the next steps. */
class Draft {
  readonly items: Change[] = []
  /** Saved before everything else; when it is refused (edited meanwhile), nothing else is saved. */
  first?: Change
  private readonly changed: { [id: string]: Item } = {}
  constructor(private readonly lib: Library) {}
  view(): View {
    return new View({ ...this.lib, items: { ...this.lib.items, ...this.changed } })
  }
  put(...its: Item[]) {
    for (const it of its) {
      this.changed[it.id] = it
      const i = this.items.findIndex((c) => c.kind === 'item' && c.data.id === it.id)
      if (i >= 0) this.items.splice(i, 1)
      this.items.push({ kind: 'item', data: it })
    }
  }
  body(id: string, doc: unknown, baseSeq: number) {
    this.items.push({ kind: 'body', data: { id, doc, updatedAt: now() }, baseSeq })
  }
}

/** Stores a text's dates and new descriptions next to it, and keeps its events in step. */
function textEffects(d: Draft, ownerId: string, doc: unknown, effects: ReturnType<typeof parse>['effects']) {
  const t = now()
  let v = d.view()
  for (const e of effects.dates) {
    const old = v.items[e.id]
    d.put(old ? { ...old, at: e.at, tz: process.env.TZ, updatedAt: t } : { id: e.id, type: 'event', parentId: ownerId, rank: 'a0', title: 'Untitled', at: e.at, tz: process.env.TZ, status: 'todo', createdAt: t, updatedAt: t })
  }
  for (const n of effects.descriptions) {
    d.put({ id: n.id, type: 'description', parentId: ownerId, rank: 'a0', title: n.title.slice(0, 120) || 'Description', createdAt: t, updatedAt: t })
    v = d.view()
    const sub = parse(n.text, ctxOf(v, n.id))
    if (sub.effects.dates.length || sub.effects.descriptions.length) textEffects(d, n.id, sub.doc, sub.effects)
    d.body(n.id, sub.doc, 0)
  }
  d.put(...eventChanges(d.view().items, ownerId, doc, t))
}

async function commit(lib: Library, d: Draft): Promise<void> {
  for (const changes of d.first ? [[d.first], d.items] : [d.items]) {
    if (!changes.length) continue
    const res = await save(lib, changes)
    const why = [...(res.rejected ?? []).map((r) => `${r.kind} ${r.id.slice(0, 8)}: ${r.reason}`), ...res.conflicts.map(() => 'the text changed in the app since you read it; read it again')]
    if (why.length) throw new ToolError(`${changes === d.items && d.first ? 'The text was saved, but not everything with it' : 'Nothing was saved'}: ${why.join('; ')}.`)
  }
}

async function create(lib: Library, list: { type: Visible; title: string; in?: string; position?: 'first' | 'last'; after?: string; text?: string; status?: TaskStatus; priority?: Priority; due?: string; pinned?: boolean; color?: string }[]): Promise<string> {
  const d = new Draft(lib)
  const made: string[] = []
  for (const a of list) {
    const v = d.view()
    const t = now()
    const it: Item = {
      id: randomUUID(),
      type: a.type,
      ...place(v, undefined, a.type, a),
      title: a.title.trim(),
      createdAt: t,
      updatedAt: t,
      ...(a.type === 'task' && { status: a.status ?? 'todo', ...(a.priority && { priority: a.priority }), ...(a.due && { due: when(a.due) }) }),
      ...(a.pinned && { pinned: true }),
      ...(a.type === 'space' && a.color && { color: a.color }),
    }
    if (a.type !== 'task' && (a.status || a.priority || a.due)) throw new ToolError(`"${a.title}": status, priority and due are for tasks.`)
    d.put(it)
    if (a.text) {
      if (a.type !== 'note' && a.type !== 'task') throw new ToolError(`"${a.title}": only notes and tasks have text.`)
      const { doc, effects } = parse(a.text, ctxOf(d.view(), it.id))
      textEffects(d, it.id, doc, effects)
      d.body(it.id, doc, 0)
    }
    made.push(it.id)
  }
  await commit(lib, d)
  const v = new View(lib)
  return [`Created ${made.length}:`, ...made.map((id) => `- ${line(v, v.items[id]!)}`)].join('\n')
}

async function update(lib: Library, list: { ref: string; title?: string; status?: TaskStatus; priority?: Priority; due?: string | null; pinned?: boolean; color?: string; in?: string; position?: 'first' | 'last'; after?: string }[]): Promise<string> {
  const d = new Draft(lib)
  const done: string[] = []
  for (const a of list) {
    const v = d.view()
    const it = v.resolve(a.ref, { hidden: true })
    if (it.type === 'description') throw new ToolError(`${v.short(it.id)} is a hidden description: change its text with edit.`)
    const ev = it.type === 'event'
    if ((a.status || a.priority || a.due !== undefined) && it.type !== 'task' && !ev) throw new ToolError(`"${it.title}" is a ${it.type}: status, priority and due are for tasks.`)
    if (ev && (a.priority || a.in || a.after || a.position || a.due === null)) throw new ToolError(`"${it.title}" is a date in a text: it takes due, status and title only.`)
    if (ev && a.status === 'doing') throw new ToolError('A date is todo or done.')
    const moves = a.in !== undefined || a.after !== undefined || a.position !== undefined
    const next: Item = {
      ...it,
      ...(a.title && { title: a.title.trim(), ...(ev && { customTitle: true }) }),
      ...(a.status && { status: a.status }),
      ...(a.priority && { priority: a.priority }),
      ...(a.due !== undefined && (ev ? { at: when(a.due!), tz: process.env.TZ } : { due: a.due === null ? undefined : when(a.due) })),
      ...(a.pinned !== undefined && { pinned: a.pinned }),
      ...(a.color && it.type === 'space' && { color: a.color }),
      ...(moves && place(v, it, it.type, a)),
      updatedAt: now(),
    }
    d.put(next)
    done.push(it.id)
  }
  await commit(lib, d)
  const v = new View(lib)
  return [`Updated ${done.length}:`, ...done.map((id) => `- ${line(v, v.items[id]!)}`)].join('\n')
}

async function edit(v: View, lib: Library, a: { ref: string; version?: number; replace?: { find: string; with: string; all: boolean }[]; prepend?: string; append?: string; set?: string }): Promise<string> {
  const it = v.resolve(a.ref, { hidden: true })
  if (it.type !== 'note' && it.type !== 'task' && it.type !== 'description') throw new ToolError(`"${it.title}" is a ${it.type === 'event' ? 'date' : it.type}: only notes, tasks and descriptions have text.`)
  const body = lib.bodies[it.id]
  const seq = body?.seq ?? 0
  if (a.version !== undefined && a.version !== seq) throw new ToolError(`"${it.title}" changed since version ${a.version} (now ${seq}). Read it again.`)
  if (a.set !== undefined && (a.replace?.length || a.prepend || a.append)) throw new ToolError('set replaces the whole text: use it alone.')
  if (a.set === undefined && !a.replace?.length && a.prepend === undefined && a.append === undefined) throw new ToolError('Say what to change: replace, prepend, append or set.')
  const ctx = ctxOf(v, it.id)
  const before = toMarkdown(body?.doc, ctx)
  let md = a.set ?? before
  for (const r of a.replace ?? []) {
    const times = md.split(r.find).length - 1
    if (!times) throw new ToolError(`Not found in "${it.title}": ${JSON.stringify(r.find.slice(0, 120))}. The text is as read shows it (dates, descriptions and secrets are links); read it again and copy the exact words.`)
    if (times > 1 && !r.all) throw new ToolError(`Found ${times} times in "${it.title}": ${JSON.stringify(r.find.slice(0, 120))}. Add nearby words to make it unique, or set all: true.`)
    md = r.all ? md.split(r.find).join(r.with) : md.replace(r.find, () => r.with)
  }
  if (a.prepend) md = `${a.prepend.trim()}\n\n${md}`
  if (a.append) md = `${md}\n\n${a.append.trim()}`
  if (md === before) return `No change: "${it.title}" already reads like that.`
  const { doc, effects } = applyMarkdown(body?.doc, md, ctx)
  const d = new Draft(lib)
  textEffects(d, it.id, doc, effects)
  // Descriptions whose link left the text go to the trash with it, as in the app.
  const refs = (x: unknown) => new Set([...JSON.stringify(x ?? {}).matchAll(/"descId":"([\w-]+)"/g)].map((m) => m[1]))
  const was = refs(body?.doc)
  const kept = refs(doc)
  const t = now()
  for (const gone of Object.values(v.items).filter((x) => x.type === 'description' && x.parentId === it.id && !x.deletedAt && was.has(x.id) && !kept.has(x.id)))
    d.put(...trashIds(d.view().items, gone.id).map((id) => ({ ...d.view().items[id]!, deletedAt: t, updatedAt: t })))
  d.first = { kind: 'body', data: { id: it.id, doc, updatedAt: now() }, baseSeq: seq }
  await commit(lib, d)
  return `Saved "${it.title}" (${v.short(it.id)}) · version ${lib.bodies[it.id]?.seq ?? '?'}${effects.dates.length ? ` · ${plural(effects.dates.length, 'date')} set` : ''}${effects.descriptions.length ? ` · ${plural(effects.descriptions.length, 'description')} added` : ''}`
}

async function trash(v: View, lib: Library, refs: string[], restore: boolean): Promise<string> {
  const d = new Draft(lib)
  const t = now()
  const names: string[] = []
  for (const r of refs) {
    const view = d.view()
    const it = view.resolve(r, { trash: restore })
    if (restore) {
      const plan = restorePlan(view.items, { id: it.id })
      if (!it.deletedAt || !plan) throw new ToolError(`"${it.title}" is not in the trash.`)
      d.put(...applyRestore(view.items, plan, t))
    } else d.put(...trashIds(view.items, it.id).map((id) => ({ ...view.items[id]!, deletedAt: t, updatedAt: t })))
    names.push(`${it.title} (${v.short(it.id)})`)
  }
  await commit(lib, d)
  return restore ? `Restored: ${names.join(', ')}.` : `Moved to the trash: ${names.join(', ')}. Restore within ${TRASH_DAYS} days with trash restore: true.`
}

import { mergeAttributes, Node, type Editor } from '@tiptap/core'
import { Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state'
import { localDay, ymd } from '@blade-notes/core'
import { chipLabel, plainLabel } from './dates'
import { createEvent, currentState, subscribe } from './store'

/**
 * Dates typed into the text. `@` at the start of a word (so never inside an email address)
 * opens a date picker; picking puts a chip in the line, linked to an `event` item that the
 * Agenda and calendars read. The item holds the truth; the chip keeps a copy of `at` so a
 * copy of the text still says the date anywhere it is pasted.
 */
export interface ScheduleHooks {
  /** The note, task or description this editor shows: new events belong to it. */
  ownerId: string
  /** Opens the chip's popup. */
  openChip: (id: string, anchor: HTMLElement) => void
}

interface ChipStorage {
  /** The open picker's key handler. */
  onKey: ((e: KeyboardEvent) => boolean) | null
  /** Words selected when Schedule was pressed: the event's title. */
  title: string | null
}
declare module '@tiptap/core' {
  interface Storage {
    dateChip: ChipStorage
  }
}

export interface DateQuery {
  /** Position of the @. */
  from: number
  /** The cursor. */
  to: number
  query: string
}

interface QueryState {
  active: DateQuery | null
  /** The @ that Esc closed: it stays plain text until the cursor leaves it. */
  dismissed: number | null
}
export const dateQueryKey = new PluginKey<QueryState>('dateQuery')

const CAL = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>'

/** The event's own date when this device has it, else the copy on the chip. */
const atOf = (node: PMNode): string => currentState().items[node.attrs.id as string]?.at ?? (node.attrs.at as string | null) ?? ymd(new Date())

export const DateChip = Node.create<{ hooks: ScheduleHooks }, ChipStorage>({
  name: 'dateChip',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addOptions: () => ({ hooks: { ownerId: '', openChip: () => {} } }),
  addStorage: () => ({ onKey: null, title: null }),

  addAttributes: () => ({
    id: { default: null, parseHTML: (el) => el.getAttribute('data-event'), renderHTML: (a) => ({ 'data-event': a.id }) },
    at: { default: null, parseHTML: (el) => el.getAttribute('datetime'), renderHTML: (a) => ({ datetime: a.at }) },
  }),
  // Copies carry <time datetime="…" data-event="…">Sun 15 Nov 2026, 10:00</time>: other apps
  // see the date in words, and Blade Notes turns it back into a chip.
  parseHTML: () => [{ tag: 'time[data-event]' }],
  renderHTML: ({ node, HTMLAttributes }) => ['time', mergeAttributes(HTMLAttributes, { class: 'date-chip' }), plainLabel(atOf(node))],
  renderText: ({ node }) => plainLabel(atOf(node)),

  addNodeView() {
    const hooks = this.options.hooks
    return ({ node }) => {
      let cur = node
      const dom = document.createElement('button')
      dom.type = 'button'
      dom.contentEditable = 'false'
      const paint = () => {
        const id = cur.attrs.id as string
        const it = currentState().items[id]
        const at = atOf(cur)
        const today = ymd(new Date())
        const day = localDay(at)
        const tone = it?.status === 'done' ? ' done' : day < today ? ' late' : day === today ? ' today' : ''
        dom.className = `date-chip${tone}`
        dom.dataset.event = id
        dom.innerHTML = `${CAL}<span>${chipLabel(at, today)}</span>`
        dom.setAttribute('aria-label', `${it?.status === 'done' ? 'Done, ' : ''}${plainLabel(at)}. Change the date`)
      }
      paint()
      const off = subscribe(paint) // follows edits on other devices, midnight and zone changes
      dom.addEventListener('mousedown', (e) => e.preventDefault())
      dom.addEventListener('click', (e) => {
        e.preventDefault()
        hooks.openChip(cur.attrs.id as string, dom)
      })
      return {
        dom,
        update: (n) => {
          if (n.type !== cur.type) return false
          cur = n
          paint()
          return true
        },
        destroy: off,
        ignoreMutation: () => true,
        stopEvent: (e) => e.type === 'mousedown' || e.type === 'click',
      }
    }
  },

  addProseMirrorPlugins() {
    const storage = this.storage
    const hooks = this.options.hooks
    return [
      new Plugin<QueryState>({
        key: dateQueryKey,
        state: {
          init: () => ({ active: null, dismissed: null }),
          apply(tr, prev, _old, next) {
            const meta = tr.getMeta(dateQueryKey) as { dismiss?: number } | undefined
            let dismissed = meta?.dismiss ?? (prev.dismissed === null ? null : tr.mapping.map(prev.dismissed))
            const found = findQuery(next)
            if (!found) dismissed = null
            return { active: found && found.from !== dismissed ? found : null, dismissed }
          },
        },
        props: {
          // Arrow keys, Enter and Esc go to the open picker (it says whether it took them).
          handleKeyDown: (view, event) => (dateQueryKey.getState(view.state)?.active && storage.onKey ? storage.onKey(event) : false),
          transformPasted: (slice, view) => new Slice(mapChips(slice.content, (n) => claim(n, view.state.doc, hooks.ownerId)), slice.openStart, slice.openEnd),
        },
      }),
    ]
  },
})

/** The @query right before the cursor, or null. */
function findQuery(state: EditorState): DateQuery | null {
  const { selection } = state
  const $p = selection.$from
  if (!selection.empty || !$p.parent.isTextblock || $p.parent.type.spec.code) return null
  if ($p.marks().some((m) => m.type.name === 'code')) return null
  const before = $p.parent.textBetween(Math.max(0, $p.parentOffset - 40), $p.parentOffset, undefined, '￼')
  const m = /(?:^|\s)@([^@￼\n]*)$/.exec(before)
  if (!m || m[1]!.length > 30 || /\s\s/.test(m[1]!)) return null
  return { from: $p.pos - m[1]!.length - 1, to: $p.pos, query: m[1]! }
}

function mapChips(content: Fragment, fn: (n: PMNode) => PMNode): Fragment {
  const out: PMNode[] = []
  content.forEach((n) => out.push(n.type.name === 'dateChip' ? fn(n) : n.copy(mapChips(n.content, fn))))
  return Fragment.fromArray(out)
}

/**
 * A pasted chip. Cut and pasted inside the same note it stays the same event; any other paste
 * (a copy, or another note) becomes a new event on the same date, so deleting one copy never
 * deletes the other.
 */
function claim(node: PMNode, doc: PMNode, ownerId: string): PMNode {
  const id = node.attrs.id as string
  const it = currentState().items[id]
  let inDoc = false
  doc.descendants((n) => {
    if (n.type.name === 'dateChip' && n.attrs.id === id) inDoc = true
    return !inDoc
  })
  if (it && !it.deletedAt && !inDoc && it.parentId === ownerId) return node
  const at = it?.at ?? (node.attrs.at as string | null) ?? ymd(new Date())
  const fresh = createEvent(ownerId, it?.title ?? '', at, { ...(it?.tz && { tz: it.tz }), ...(it?.private && { private: true }) })
  return node.type.create({ id: fresh, at })
}

/** Writes a new `at` onto every chip of event `id` in this editor. */
export function setChipAt(editor: Editor, id: string, at: string): void {
  const tr = editor.state.tr
  editor.state.doc.descendants((n, pos) => {
    if (n.type.name === 'dateChip' && n.attrs.id === id) tr.setNodeMarkup(pos, undefined, { ...n.attrs, at })
  })
  if (tr.docChanged) editor.view.dispatch(tr)
}

/** Takes the chips of event `id` out of this editor; the text around them stays. */
export function removeChip(editor: Editor, id: string): void {
  const tr = editor.state.tr
  editor.state.doc.descendants((n, pos) => {
    if (n.type.name === 'dateChip' && n.attrs.id === id) tr.delete(tr.mapping.map(pos), tr.mapping.map(pos + n.nodeSize))
  })
  if (tr.docChanged) editor.view.dispatch(tr)
}

/** The line's text around the @query: what the new event is called. */
export function lineTitle(editor: Editor, q: DateQuery): string {
  const $from = editor.state.doc.resolve(q.from)
  const start = $from.start()
  const end = $from.end()
  const text = (a: number, b: number) => (b > a ? editor.state.doc.textBetween(a, b, ' ', ' ') : '')
  return `${text(start, q.from)} ${text(q.to, end)}`.replace(/\s+/g, ' ').trim()
}

/** Types "@" at the cursor (after a space when needed), which opens the picker. */
export function startSchedule(editor: Editor): void {
  const { state } = editor
  const sel = state.selection
  const words = sel.empty ? '' : state.doc.textBetween(sel.from, sel.to, ' ').trim()
  editor.storage.dateChip.title = words || null // selected words become the event's title
  const at = sel.to
  const before = at > 0 ? state.doc.textBetween(Math.max(0, at - 1), at, ' ', ' ') : ''
  editor.chain().focus().setTextSelection(at).insertContent(before && !/\s/.test(before) ? ' @' : '@').run()
}

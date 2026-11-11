import { Extension, Mark, mergeAttributes, type Editor } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'

/**
 * Hidden descriptions. A list item (bullet, numbered or checklist) carries `descId`; any
 * phrase can carry the `describe` mark. Both point at a `description` item whose body is
 * its own synced document. The editor only shows where they are and asks the app to open them.
 */
export interface DescribeHooks {
  /** Opens description `id`; `anchor` is the clicked icon or phrase. `remove` takes it out of this document. */
  open: (id: string, anchor: HTMLElement, remove: () => void) => void
  /** Makes a new description titled `title` and returns its id. */
  create: (title: string) => string
}

const LIST_ITEMS = ['listItem', 'taskItem']
const LINES = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10"/></svg>'
const PLUS = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>'

export const DescribeMark = Mark.create({
  name: 'describe',
  inclusive: false,
  addAttributes: () => ({
    descId: { default: null, parseHTML: (el) => el.getAttribute('data-desc'), renderHTML: (a) => ({ 'data-desc': a.descId }) },
  }),
  parseHTML: () => [{ tag: 'span[data-desc]' }],
  renderHTML: ({ HTMLAttributes }) => ['span', mergeAttributes(HTMLAttributes, { class: 'desc-mark' }), 0],
})

export const Describe = Extension.create<{ hooks: DescribeHooks }>({
  name: 'describeLists',
  addOptions: () => ({ hooks: { open: () => {}, create: () => '' } }),

  addGlobalAttributes: () => [
    {
      types: LIST_ITEMS,
      attributes: {
        descId: {
          default: null,
          keepOnSplit: false, // Enter on a described line starts a plain one
          parseHTML: (el) => el.getAttribute('data-desc-item'),
          renderHTML: (a) => (a.descId ? { 'data-desc-item': a.descId } : {}),
        },
      },
    },
  ],

  addKeyboardShortcuts() {
    return { 'Mod-Shift-d': () => describe(this.editor, this.options.hooks) }
  },

  addProseMirrorPlugins() {
    const hooks = this.options.hooks
    const editor = this.editor
    return [
      new Plugin({
        key: new PluginKey('describeLists'),
        props: {
          // The icon sits right where the item's first line of text ends.
          decorations: (state) => {
            const decos: Decoration[] = []
            state.doc.descendants((node, pos) => {
              if (!LIST_ITEMS.includes(node.type.name)) return true
              const first = node.firstChild
              if (!first?.isTextblock) return true
              // Item content starts at pos + 1; the first textblock's content one further in.
              const at = pos + 2 + first.content.size
              const id = node.attrs.descId as string | null
              decos.push(Decoration.widget(at, () => widget(editor, hooks, pos, id), { side: 1, key: id ? `d-${id}` : `a-${pos}`, ignoreSelection: true }))
              return true
            })
            return DecorationSet.create(state.doc, decos)
          },
          handleDOMEvents: {
            click: (_view, event) => {
              const el = (event.target as HTMLElement).closest<HTMLElement>('.desc-mark')
              const id = el?.dataset.desc
              if (!el || !id || event.metaKey || event.ctrlKey) return false
              hooks.open(id, el, () => removeDescription(editor, id))
              return true
            },
          },
        },
      }),
    ]
  },
})

function widget(editor: Editor, hooks: DescribeHooks, itemPos: number, id: string | null): HTMLElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.contentEditable = 'false'
  b.className = id ? 'desc-btn' : 'desc-add'
  if (id) b.dataset.desc = id
  b.innerHTML = id ? LINES : `${PLUS}<span>Description</span>`
  b.setAttribute('aria-label', id ? 'Open description' : 'Add a description to this line')
  b.title = id ? 'Open description' : 'Add a description (⌘⇧D)'
  b.addEventListener('mousedown', (e) => e.preventDefault())
  b.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (id) return hooks.open(id, b, () => removeDescription(editor, id))
    const node = editor.state.doc.nodeAt(itemPos)
    if (!node || !LIST_ITEMS.includes(node.type.name)) return
    const newId = hooks.create(node.firstChild?.textContent.trim() ?? '')
    editor.view.dispatch(editor.state.tr.setNodeAttribute(itemPos, 'descId', newId))
    requestAnimationFrame(() => {
      const btn = editor.view.dom.querySelector<HTMLElement>(`.desc-btn[data-desc="${newId}"]`)
      if (btn) hooks.open(newId, btn, () => removeDescription(editor, newId))
    })
  })
  return b
}

/** ⌘⇧D: describe the selected phrase, or else the list item the cursor is in. */
function describe(editor: Editor, hooks: DescribeHooks): boolean {
  const { state } = editor
  const { from, to, empty, $from } = state.selection
  if (!empty) {
    const text = state.doc.textBetween(from, to, ' ').trim()
    if (!text) return false
    const id = hooks.create(text)
    editor.chain().setMark('describe', { descId: id }).setTextSelection(to).run()
    openAfterRender(editor, hooks, id, '.desc-mark')
    return true
  }
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d)
    if (!LIST_ITEMS.includes(node.type.name)) continue
    const pos = $from.before(d)
    const existing = node.attrs.descId as string | null
    if (existing) {
      openAfterRender(editor, hooks, existing, '.desc-btn')
      return true
    }
    const id = hooks.create(node.firstChild?.textContent.trim() ?? '')
    editor.view.dispatch(state.tr.setNodeAttribute(pos, 'descId', id))
    openAfterRender(editor, hooks, id, '.desc-btn')
    return true
  }
  return false
}

export function describeSelection(editor: Editor, hooks: DescribeHooks): boolean {
  return describe(editor, hooks)
}

function openAfterRender(editor: Editor, hooks: DescribeHooks, id: string, selector: string) {
  requestAnimationFrame(() => {
    const el = editor.view.dom.querySelector<HTMLElement>(`${selector}[data-desc="${id}"]`)
    if (el) hooks.open(id, el, () => removeDescription(editor, id))
  })
}

/** Takes description `id` off its phrase or list item; the text itself stays. */
export function removeDescription(editor: Editor, id: string): void {
  if (editor.isDestroyed) return
  const tr = editor.state.tr
  const markType = editor.schema.marks.describe!
  editor.state.doc.descendants((node: PMNode, pos: number) => {
    if (LIST_ITEMS.includes(node.type.name) && node.attrs.descId === id) tr.setNodeAttribute(pos, 'descId', null)
    if (node.isText && node.marks.some((m) => m.type === markType && m.attrs.descId === id)) {
      tr.removeMark(pos, pos + node.nodeSize, markType.create({ descId: id }))
    }
    return true
  })
  if (tr.docChanged) editor.view.dispatch(tr)
}

/** Every description id linked from this document. */
export function describedIds(editor: Editor): Set<string> {
  const ids = new Set<string>()
  editor.state.doc.descendants((node: PMNode) => {
    if (LIST_ITEMS.includes(node.type.name) && node.attrs.descId) ids.add(node.attrs.descId as string)
    for (const m of node.marks) if (m.type.name === 'describe' && m.attrs.descId) ids.add(m.attrs.descId as string)
    return true
  })
  return ids
}

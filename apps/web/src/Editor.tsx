import { useEffect, useMemo, useRef, useState } from 'react'
import { useEditor, useEditorState, EditorContent, type Editor as TiptapEditor } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import StarterKit from '@tiptap/starter-kit'
import { TaskList } from '@tiptap/extension-task-list'
import { TaskItem } from '@tiptap/extension-task-item'
import Highlight from '@tiptap/extension-highlight'
import Placeholder from '@tiptap/extension-placeholder'
import Image from '@tiptap/extension-image'
import { TableKit } from '@tiptap/extension-table'
import {
  Bold, Italic, Underline, Strikethrough, Code, Highlighter, List, ListOrdered, ListTodo,
  TextQuote, SquareCode, Table, Link, ImagePlus, Undo2, Redo2, NotebookText,
} from 'lucide-react'
import { currentState, docText, setBody, settingsOf, stripDescription, uploadImage, useStore } from './store'
import { Describe, DescribeMark, describeSelection, describedIds, removeDescription, type DescribeHooks } from './describe'

interface Props {
  id: string
  doc: unknown
  placeholder: string
  /** Opens and creates hidden descriptions of list items and phrases. */
  describe: DescribeHooks
}

/** Saves 500 ms after the last keystroke. Remounted per note (key = id) by the caller. */
export function Editor({ id, doc, placeholder, describe }: Props) {
  const save = useRef<ReturnType<typeof setTimeout>>(undefined)
  const latest = useRef(describe)
  latest.current = describe
  // One stable object for the extension; it always calls the caller's latest handlers.
  // `remove` is called later, maybe after this editor has closed (a nested description was open
  // on top of it): then the stored document is edited instead.
  const hooks = useMemo<DescribeHooks>(
    () => ({
      open: (descId, anchor, remove) =>
        latest.current.open(descId, anchor, () => (editorRef.current && !editorRef.current.isDestroyed ? remove() : stripDescription(id, descId))),
      create: (t) => latest.current.create(t),
    }),
    [id],
  )
  const [peek, setPeek] = useState<{ id: string; rect: DOMRect } | null>(null)
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false, autolink: true } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Highlight,
      Image,
      TableKit.configure({ table: { resizable: false } }),
      Placeholder.configure({ placeholder }),
      DescribeMark,
      Describe.configure({ hooks }),
    ],
    content: (doc as object) ?? '',
    editorProps: {
      attributes: { class: 'doc', 'aria-label': 'Note text' },
      handlePaste: (_view, event) => {
        const file = [...(event.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'))
        if (!file) return false
        void insertImage(editorRef.current, file)
        return true
      },
    },
    onUpdate: ({ editor }) => {
      clearTimeout(save.current)
      save.current = setTimeout(() => setBody(id, editor.getJSON()), 500)
    },
    immediatelyRender: true,
  })
  const editorRef = useRef<TiptapEditor | null>(null)
  editorRef.current = editor

  // Links to descriptions deleted elsewhere turn back into plain text.
  useEffect(() => {
    const { items } = currentState()
    for (const d of describedIds(editor)) if (items[d]?.deletedAt) removeDescription(editor, d)
  }, [editor])

  // Flush a pending save when leaving the note.
  useEffect(
    () => () => {
      if (save.current && editorRef.current) {
        clearTimeout(save.current)
        setBody(id, editorRef.current.getJSON())
      }
    },
    [id],
  )

  return (
    <>
      <Toolbar editor={editor} hooks={hooks} />
      <BubbleMenu editor={editor} className="bubble" options={{ placement: 'top' }}>
        <BubbleButtons editor={editor} hooks={hooks} />
      </BubbleMenu>
      <div
        onMouseOver={(e) => {
          const el = (e.target as HTMLElement).closest<HTMLElement>('.desc-mark')
          if (el?.dataset.desc) setPeek({ id: el.dataset.desc, rect: el.getBoundingClientRect() })
        }}
        onMouseOut={(e) => (e.target as HTMLElement).closest('.desc-mark') && setPeek(null)}
        onClick={() => setPeek(null)}
      >
        <EditorContent editor={editor} />
      </div>
      {peek && <Peek id={peek.id} rect={peek.rect} />}
    </>
  )
}

/** The start of a description, shown while hovering its phrase (Settings › Descriptions can turn it off). */
function Peek({ id, rect }: { id: string; rect: DOMRect }) {
  const { state } = useStore()
  const item = state.items[id]
  if (!settingsOf(state).descriptionPreview || !item || item.deletedAt) return null
  const text = docText(state.bodies[id]?.doc)
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - 300))
  return (
    <div className="peek" role="tooltip" style={{ left, top: rect.bottom + 6 }}>
      <strong>{item.title}</strong>
      <span>{text ? (text.length > 180 ? `${text.slice(0, 180)}…` : text) : 'No text yet.'}</span>
      <small>Click to open</small>
    </div>
  )
}

function BubbleButtons({ editor, hooks }: { editor: TiptapEditor; hooks: DescribeHooks }) {
  const s = useEditorState({ editor, selector: ({ editor: e }) => ({ bold: e.isActive('bold'), italic: e.isActive('italic'), described: e.isActive('describe') }) })
  return (
    <>
      <button type="button" className={s.bold ? 'tool on' : 'tool'} aria-label="Bold" onClick={() => editor.chain().focus().toggleBold().run()}><Bold size={15} aria-hidden /></button>
      <button type="button" className={s.italic ? 'tool on' : 'tool'} aria-label="Italic" onClick={() => editor.chain().focus().toggleItalic().run()}><Italic size={15} aria-hidden /></button>
      <span className="sep" />
      {!s.described && (
        <button type="button" className="bubble-describe" onClick={() => describeSelection(editor, hooks)} title="Add a description (⌘⇧D)">
          <NotebookText size={15} aria-hidden /> Describe
        </button>
      )}
    </>
  )
}

async function insertImage(editor: TiptapEditor | null, file: File) {
  if (!editor) return
  try {
    const src = await uploadImage(file)
    editor.chain().focus().setImage({ src, alt: file.name }).run()
  } catch (err) {
    alert(`Could not upload the image: ${(err as Error).message}`)
  }
}

function Toolbar({ editor, hooks }: { editor: TiptapEditor; hooks: DescribeHooks }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      block: e.isActive('heading', { level: 1 }) ? 'h1' : e.isActive('heading', { level: 2 }) ? 'h2' : e.isActive('heading', { level: 3 }) ? 'h3' : 'p',
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      strike: e.isActive('strike'),
      code: e.isActive('code'),
      mark: e.isActive('highlight'),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      task: e.isActive('taskList'),
      quote: e.isActive('blockquote'),
      codeBlock: e.isActive('codeBlock'),
      link: e.isActive('link'),
    }),
  })
  const file = useRef<HTMLInputElement>(null)
  const c = () => editor.chain().focus()
  const btn = (label: string, on: boolean, run: () => void, Icon: typeof Bold) => (
    <button type="button" className={on ? 'tool on' : 'tool'} aria-label={label} title={label} aria-pressed={on} onClick={run}>
      <Icon size={15} aria-hidden />
    </button>
  )
  const setLink = () => {
    const prev = editor.getAttributes('link').href as string | undefined
    const url = prompt('Link address', prev ?? 'https://')
    if (url === null) return
    if (url === '') c().unsetLink().run()
    else c().extendMarkRange('link').setLink({ href: url }).run()
  }

  return (
    <div role="toolbar" aria-label="Formatting" className="toolbar">
      <select
        className="select"
        aria-label="Text style"
        value={s.block}
        onChange={(e) => {
          const v = e.target.value
          if (v === 'p') c().setParagraph().run()
          else c().setHeading({ level: Number(v.slice(1)) as 1 | 2 | 3 }).run()
        }}
      >
        <option value="p">Paragraph</option>
        <option value="h1">Heading 1</option>
        <option value="h2">Heading 2</option>
        <option value="h3">Heading 3</option>
      </select>
      <span className="sep" />
      {btn('Bold', s.bold, () => c().toggleBold().run(), Bold)}
      {btn('Italic', s.italic, () => c().toggleItalic().run(), Italic)}
      {btn('Underline', s.underline, () => c().toggleUnderline().run(), Underline)}
      {btn('Strikethrough', s.strike, () => c().toggleStrike().run(), Strikethrough)}
      {btn('Inline code', s.code, () => c().toggleCode().run(), Code)}
      {btn('Highlight', s.mark, () => c().toggleHighlight().run(), Highlighter)}
      <span className="sep" />
      {btn('Bulleted list', s.bullet, () => c().toggleBulletList().run(), List)}
      {btn('Numbered list', s.ordered, () => c().toggleOrderedList().run(), ListOrdered)}
      {btn('Checklist', s.task, () => c().toggleTaskList().run(), ListTodo)}
      <span className="sep" />
      {btn('Quote', s.quote, () => c().toggleBlockquote().run(), TextQuote)}
      {btn('Code block', s.codeBlock, () => c().toggleCodeBlock().run(), SquareCode)}
      {btn('Table', false, () => c().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(), Table)}
      <span className="sep" />
      {btn('Link', s.link, setLink, Link)}
      {btn('Image', false, () => file.current?.click(), ImagePlus)}
      {btn('Description for the selection or list item (⌘⇧D)', false, () => describeSelection(editor, hooks), NotebookText)}
      <input
        ref={file}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (f) void insertImage(editor, f)
        }}
      />
      <span className="grow" />
      {btn('Undo', false, () => c().undo().run(), Undo2)}
      {btn('Redo', false, () => c().redo().run(), Redo2)}
    </div>
  )
}

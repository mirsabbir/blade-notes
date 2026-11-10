import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Item, TaskStatus } from '@blade-notes/core'
import {
  ChevronRight, Circle, CircleCheck, FileText, Folder, Maximize2, Moon, PanelLeftClose, PanelLeftOpen,
  Plus, Search, Sun, Trash2, LogOut, CloudOff, RefreshCw, Check, AlertTriangle, Settings, Paperclip,
} from 'lucide-react'
import { useOpenUpdatesFromMenu } from './Updates'
import { SettingsDialog, type SettingsSection } from './Settings'
import { Attachments, DropZone } from './Attachments'
import { childrenOf, clearFresh, create, freshId, settingsOf, sync, trash, update, useStore, type SyncStatus } from './store'

const DEFAULT_TITLE = { space: 'New space', folder: 'New folder', note: 'Untitled', task: 'New task' } as const
import { signOut } from './auth'
import { Editor } from './Editor'

const SPACE_COLORS = ['#6C4DFF', '#FF5E62', '#FFBE2E', '#22D3C5', '#2857e5']
const isBox = (i: Item) => i.type === 'space' || i.type === 'folder'

function usePersisted<T>(key: string, initial: T) {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw === null ? initial : (JSON.parse(raw) as T)
    } catch {
      return initial
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(v))
    } catch {
      /* storage full or blocked: the setting just isn't remembered */
    }
  }, [key, v])
  return [v, setV] as const
}

export function App() {
  const { state, status } = useStore()
  const items = state.items
  const [path, setPath] = usePersisted<string[]>('bn:path', [])
  const [manual, setManual] = useState<{ [blade: number]: boolean }>({})
  const [focus, setFocus] = useState(false)
  const [dark, setDark] = usePersisted('bn:dark', matchMedia('(prefers-color-scheme: dark)').matches)

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
  }, [dark])

  // Drop path entries that no longer exist (deleted on another device).
  const live = path.filter((id, i) => {
    const it = items[id]
    return it && !it.deletedAt && (i === 0 ? it.parentId === null : it.parentId === path[i - 1])
  })
  const chain: (Item | null)[] = [null] // null = the library root
  for (const id of live) {
    const it = items[id]!
    if (isBox(it)) chain.push(it)
    else break
  }
  const leafId = live.at(-1)
  const selected = leafId && !isBox(items[leafId]!) ? items[leafId]! : null

  const go = (level: number, id: string | null) => {
    setPath([...live.slice(0, level), ...(id ? [id] : [])])
    setManual((m) => Object.fromEntries(Object.entries(m).filter(([k, v]) => Number(k) < level && v)))
    setFocus(false)
  }
  const maxOpen = settingsOf(state).bladesOpen
  const folded = (i: number) => focus || (manual[i] ?? i < chain.length - maxOpen)

  return (
    <div className="shell">
      {chain.map((node, i) =>
        folded(i) ? (
          <Strip
            key={node?.id ?? 'root'}
            title={node?.title ?? 'Library'}
            color={spaceColor(items, node)}
            onOpen={() => {
              setManual((m) => ({ ...(focus ? Object.fromEntries(chain.map((_, j) => [j, true])) : m), [i]: false }))
              setFocus(false)
            }}
          />
        ) : node === null ? (
          <LibraryBlade
            key="root"
            items={items}
            selectedId={live[0]}
            onOpen={(id) => {
              const it = items[id]!
              // A search hit can be anywhere: open the whole path to it.
              const trail: string[] = []
              for (let cur: Item | undefined = it; cur; cur = cur.parentId ? items[cur.parentId] : undefined) trail.unshift(cur.id)
              setPath(trail)
              setManual({})
              setFocus(false)
            }}
            onFold={() => setManual((m) => ({ ...m, [0]: true }))}
            dark={dark}
            onToggleDark={() => setDark(!dark)}
          />
        ) : (
          <FolderBlade
            key={node.id}
            node={node}
            items={items}
            color={spaceColor(items, node)}
            selectedId={live[i]}
            isLast={i === chain.length - 1}
            onOpen={(id) => go(i, id)}
            onFold={() => setManual((m) => ({ ...m, [i]: true }))}
          />
        ),
      )}
      <EditorPane
        chain={chain}
        selected={selected}
        bodies={state.bodies}
        items={items}
        status={status}
        pendingCount={state.pending.length}
        focus={focus}
        onFocus={() => {
          setFocus(!focus)
          setManual({})
        }}
        onCrumb={(level) => go(level, null)}
        onOpen={(id) => {
          const parent = chain.at(-1)
          if (parent) go(chain.length - 1, id)
        }}
      />
    </div>
  )
}

function spaceColor(items: { [id: string]: Item }, node: Item | null): string {
  let cur = node
  while (cur && cur.type !== 'space') cur = cur.parentId ? (items[cur.parentId] ?? null) : null
  return cur?.color ?? 'var(--primary)'
}

function Strip({ title, color, onOpen }: { title: string; color: string; onOpen: () => void }) {
  return (
    <button type="button" className="strip" onClick={onOpen} aria-label={`Open ${title}`} title={`Open ${title}`}>
      <PanelLeftOpen size={16} aria-hidden />
      <span className="dot" style={{ background: color }} />
      <span className="strip-title">{title}</span>
    </button>
  )
}

function plural(n: number, one: string) {
  return `${n} ${one}${n === 1 ? '' : 's'}`
}
function summary(kids: Item[]) {
  const f = kids.filter(isBox).length
  const n = kids.filter((k) => k.type === 'note').length
  const t = kids.filter((k) => k.type === 'task').length
  return [f && plural(f, 'folder'), n && plural(n, 'note'), t && plural(t, 'task')].filter(Boolean).join(' · ') || 'Empty'
}

/** Plain text of a Tiptap document, for search. */
function docText(doc: unknown): string {
  if (!doc || typeof doc !== 'object') return ''
  const d = doc as { text?: string; content?: unknown[] }
  return (d.text ?? '') + ' ' + (d.content ?? []).map(docText).join(' ')
}

function LibraryBlade(props: {
  items: { [id: string]: Item }
  selectedId: string | undefined
  onOpen: (id: string) => void
  onFold: () => void
  dark: boolean
  onToggleDark: () => void
}) {
  const { items } = props
  const { state } = useStore()
  const [q, setQ] = useState('')
  const [settings, setSettings] = useState<SettingsSection | null>(null)
  useOpenUpdatesFromMenu(useCallback(() => setSettings('about'), []))
  const spaces = childrenOf(items, null)
  const search = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        search.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const hits = useMemo(() => {
    const term = q.trim().toLowerCase()
    if (!term) return []
    return Object.values(items)
      .filter((i) => !i.deletedAt && (i.title.toLowerCase().includes(term) || docText(state.bodies[i.id]?.doc).toLowerCase().includes(term)))
      .slice(0, 50)
  }, [q, items, state.bodies])

  const today = new Date().toISOString().slice(0, 10)
  const dueToday = Object.values(items).filter((i) => i.type === 'task' && !i.deletedAt && i.status !== 'done' && i.due && i.due.slice(0, 10) <= today)

  return (
    <section className="blade" aria-label="Library">
      <div className="lib-head">
        <img src="/favicon.svg" alt="" width={22} height={22} />
        <span className="brand">Blade Notes</span>
        <button type="button" className="ghost" onClick={props.onFold} aria-label="Fold Library" title="Fold Library">
          <PanelLeftClose size={16} aria-hidden />
        </button>
      </div>
      <div className="lib-search">
        <Search size={15} aria-hidden />
        <input ref={search} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search notes and tasks" />
        <kbd>⌘K</kbd>
      </div>
      <nav className="blade-body" aria-label="Spaces">
        {q.trim() ? (
          <>
            <div className="section"><span>Results</span><span>{hits.length}</span></div>
            {hits.length === 0 && <p className="empty">Nothing matches “{q.trim()}”.</p>}
            {hits.map((h) => (
              <Row key={h.id} item={h} items={items} active={false} onOpen={() => props.onOpen(h.id)} subtitle={trail(items, h)} />
            ))}
          </>
        ) : (
          <>
            {dueToday.length > 0 && (
              <>
                <div className="section"><span>Due today or late</span><span>{dueToday.length}</span></div>
                {dueToday.map((t) => (
                  <Row key={t.id} item={t} items={items} active={false} onOpen={() => props.onOpen(t.id)} subtitle={trail(items, t)} />
                ))}
              </>
            )}
            <div className="section"><span>Spaces</span><span>{spaces.length}</span></div>
            {spaces.length === 0 && <p className="empty">Start with a space, for example a project or “Personal”.</p>}
            {spaces.map((s) => (
              <Row key={s.id} item={s} items={items} active={props.selectedId === s.id} onOpen={() => props.onOpen(s.id)} />
            ))}
            <button
              type="button"
              className="add"
              onClick={() => props.onOpen(create('space', null, DEFAULT_TITLE.space, { color: SPACE_COLORS[spaces.length % SPACE_COLORS.length] }).id)}
            >
              <Plus size={15} aria-hidden /> New space
            </button>
          </>
        )}
      </nav>
      <div className="lib-foot">
        <button type="button" className="ghost wide" onClick={props.onToggleDark} aria-pressed={props.dark}>
          {props.dark ? <Sun size={16} aria-hidden /> : <Moon size={16} aria-hidden />}
          {props.dark ? 'Light mode' : 'Dark mode'}
        </button>
        <button type="button" className="ghost" onClick={() => setSettings('general')} aria-label="Settings" title="Settings">
          <Settings size={16} aria-hidden />
        </button>
        <button type="button" className="ghost" onClick={signOut} aria-label="Sign out" title="Sign out">
          <LogOut size={16} aria-hidden />
        </button>
      </div>
      {settings && <SettingsDialog initial={settings} onClose={() => setSettings(null)} dark={props.dark} onToggleDark={props.onToggleDark} />}
    </section>
  )
}

function trail(items: { [id: string]: Item }, it: Item): string {
  const names: string[] = []
  for (let cur = it.parentId ? items[it.parentId] : undefined; cur; cur = cur.parentId ? items[cur.parentId] : undefined) names.unshift(cur.title)
  return names.join(' / ')
}

function FolderBlade(props: {
  node: Item
  items: { [id: string]: Item }
  color: string
  selectedId: string | undefined
  isLast: boolean
  onOpen: (id: string) => void
  onFold: () => void
}) {
  const { node, items } = props
  const kids = childrenOf(items, node.id)
  const [menu, setMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menu) return
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !menuRef.current?.contains(e.target as Node)) setMenu(false)
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', close)
    }
  }, [menu])
  const groups: [string, Item[]][] = [
    ['Pinned', kids.filter((k) => k.pinned)],
    ['Folders', kids.filter((k) => !k.pinned && isBox(k))],
    ['Notes', kids.filter((k) => !k.pinned && k.type === 'note')],
    ['Tasks', kids.filter((k) => !k.pinned && k.type === 'task')],
  ]
  const add = (type: 'folder' | 'note' | 'task') => {
    setMenu(false)
    props.onOpen(create(type, node.id, DEFAULT_TITLE[type]).id)
  }
  return (
    <section className="blade" aria-label={node.title}>
      <div className="blade-head">
        <span className="dot" style={{ background: props.color }} />
        <div className="blade-titles">
          <h2>
            <Rename item={node} />
          </h2>
          <p>{summary(kids)}</p>
        </div>
        <div className="menu-wrap" ref={menuRef}>
          <button type="button" className="ghost" aria-label={`New in ${node.title}`} title={`New in ${node.title}`} aria-expanded={menu} onClick={() => setMenu(!menu)}>
            <Plus size={16} aria-hidden />
          </button>
          {menu && (
            <div className="menu" role="menu">
              <button role="menuitem" onClick={() => add('note')}><FileText size={15} aria-hidden /> Note</button>
              <button role="menuitem" onClick={() => add('task')}><Circle size={15} aria-hidden /> Task</button>
              <button role="menuitem" onClick={() => add('folder')}><Folder size={15} aria-hidden /> Folder</button>
            </div>
          )}
        </div>
        <button type="button" className="ghost" onClick={props.onFold} aria-label={`Fold ${node.title}`} title={`Fold ${node.title}`}>
          <PanelLeftClose size={16} aria-hidden />
        </button>
      </div>
      <div className="blade-body">
        {kids.length === 0 && <p className="empty">Empty. Use + to add a note, task or folder.</p>}
        {groups.map(([label, list]) =>
          list.length === 0 ? null : (
            <div key={label}>
              <div className="section">
                <span>{label}</span>
                <span>{label === 'Tasks' ? `${list.filter((t) => t.status === 'done').length} of ${list.length} done` : list.length}</span>
              </div>
              {list.map((k) => (
                <Row key={k.id} item={k} items={items} active={props.selectedId === k.id} onOpen={() => props.onOpen(k.id)} />
              ))}
            </div>
          ),
        )}
      </div>
    </section>
  )
}

function Rename({ item }: { item: Item }) {
  const [editing, setEditing] = useState(false)
  if (!editing)
    return (
      <span onDoubleClick={() => setEditing(true)} title="Double-click to rename">
        {item.title}
      </span>
    )
  return (
    <input
      className="rename"
      autoFocus
      defaultValue={item.title}
      aria-label="Name"
      onBlur={(e) => {
        const v = e.target.value.trim()
        if (v && v !== item.title) update(item.id, { title: v })
        setEditing(false)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') setEditing(false)
      }}
    />
  )
}

function dueLabel(due: string): string {
  const d = new Date(due.length === 10 ? `${due}T00:00:00` : due)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const days = Math.round((d.getTime() - today.getTime()) / 86_400_000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Tomorrow'
  if (days < 0) return days === -1 ? 'Yesterday' : `${-days} days late`
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'short' })
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

function Row({ item, items, active, onOpen, subtitle }: { item: Item; items: { [id: string]: Item }; active: boolean; onOpen: () => void; subtitle?: string }) {
  const done = item.type === 'task' && item.status === 'done'
  const count = isBox(item) ? childrenOf(items, item.id).length : null
  const late = item.due && !done && item.due.slice(0, 10) <= new Date().toISOString().slice(0, 10)
  return (
    <div className={`row${active ? ' active' : ''}${done ? ' done' : ''}`}>
      {item.type === 'task' && (
        <button
          type="button"
          className="check"
          aria-pressed={done}
          aria-label={`${done ? 'Mark as not done' : 'Mark as done'}: ${item.title}`}
          onClick={() => update(item.id, { status: done ? 'todo' : 'done' })}
        >
          {done ? <CircleCheck size={18} className="done-ico" aria-hidden /> : <Circle size={18} aria-hidden />}
        </button>
      )}
      <button type="button" className={`row-main${item.type === 'task' ? ' task' : ''}`} onClick={onOpen} aria-current={active ? 'page' : undefined}>
        {item.type === 'space' && <span className="dot" style={{ background: item.color ?? 'var(--primary)' }} />}
        {item.type === 'folder' && <Folder size={16} className="ico" aria-hidden />}
        {item.type === 'note' && <FileText size={16} className="ico" aria-hidden />}
        <span className="name">
          {item.title}
          {subtitle && <small>{subtitle}</small>}
        </span>
        {item.attachments?.length ? (
          <span className="meta clip" title={`${item.attachments.length} attached`}>
            <Paperclip size={12} aria-hidden />
            {item.attachments.length}
          </span>
        ) : null}
        {item.due && !done && <span className={late ? 'due today' : 'due'}>{dueLabel(item.due)}</span>}
        {count !== null && <span className="meta">{count}</span>}
        {isBox(item) && <ChevronRight size={14} className="ico" aria-hidden />}
      </button>
      <button
        type="button"
        className="row-trash"
        aria-label={`Move to trash: ${item.title}`}
        title="Move to trash"
        onClick={() => {
          const what = isBox(item) ? `“${item.title}” and everything inside it` : `“${item.title}”`
          if (confirm(`Move ${what} to the trash?`)) trash(item.id)
        }}
      >
        <Trash2 size={14} aria-hidden />
      </button>
    </div>
  )
}

const STATUS_LABEL: { [s in TaskStatus]: string } = { todo: 'To do', doing: 'In progress', done: 'Done' }
const NEXT: { [s in TaskStatus]: TaskStatus } = { todo: 'doing', doing: 'done', done: 'todo' }

function SyncBadge({ status, pending }: { status: SyncStatus; pending: number }) {
  if (status === 'signed-out') return <span className="sync warn"><AlertTriangle size={14} aria-hidden /> Signed out — changes stay on this device</span>
  if (status === 'offline') return <span className="sync"><CloudOff size={14} aria-hidden /> Offline{pending ? ` · ${pending} to sync` : ''}</span>
  if (status === 'error') return <button className="sync warn" onClick={() => void sync()}><AlertTriangle size={14} aria-hidden /> Sync failed — retry</button>
  if (status === 'syncing' || pending) return <span className="sync"><RefreshCw size={14} aria-hidden /> Saving…</span>
  return <span className="sync"><Check size={14} aria-hidden /> Saved</span>
}

function EditorPane(props: {
  chain: (Item | null)[]
  selected: Item | null
  bodies: { [id: string]: { doc: unknown; seq: number } }
  items: { [id: string]: Item }
  status: SyncStatus
  pendingCount: number
  focus: boolean
  onFocus: () => void
  onCrumb: (level: number) => void
  onOpen: (id: string) => void
}) {
  const { chain, selected } = props
  const folder = chain.at(-1) ?? null
  const crumbs = chain.slice(1) as Item[]
  const [uploading, setUploading] = useState<string[]>([])
  return (
    <main className="editor">
      <header className="editor-head">
        <nav aria-label="Breadcrumb" className="crumbs">
          {crumbs.map((c, i) => (
            <span key={c.id} className="crumb-wrap">
              {i > 0 && <ChevronRight size={14} aria-hidden />}
              {i === crumbs.length - 1 && !selected ? (
                <span aria-current="page" className="crumb-now">{c.title}</span>
              ) : (
                <button className="crumb" onClick={() => props.onCrumb(i + 1)}>{c.title}</button>
              )}
            </span>
          ))}
          {selected && (
            <span className="crumb-wrap">
              {crumbs.length > 0 && <ChevronRight size={14} aria-hidden />}
              <span aria-current="page" className="crumb-now">{selected.title}</span>
            </span>
          )}
          {crumbs.length === 0 && !selected && <span className="crumb-now">Library</span>}
        </nav>
        <SyncBadge status={props.status} pending={props.pendingCount} />
        <button type="button" className={props.focus ? 'btn on' : 'btn'} aria-pressed={props.focus} onClick={props.onFocus} title="Fold every blade">
          <Maximize2 size={14} aria-hidden /> Focus
        </button>
      </header>

      {selected ? (
        <DropZone item={selected} onUploading={setUploading}>
          <div className="editor-scroll">
            <div className="editor-body">
              <TitleRow item={selected} />
              {selected.type === 'task' && <TaskFields item={selected} />}
              <Attachments item={selected} uploading={uploading} onUploading={setUploading} />
              {selected.type === 'task' && <div className="label">Description</div>}
              <Editor
                key={selected.id}
                id={selected.id}
                doc={props.bodies[selected.id]?.doc}
                placeholder={selected.type === 'task' ? 'Add a description: steps, links, code, a checklist.' : 'Start writing. Markdown shortcuts work: #, -, [ ], >, ```'}
              />
            </div>
          </div>
        </DropZone>
      ) : (
        <div className="overview">
          <Folder size={28} aria-hidden />
          {folder ? <TitleInput item={folder} className="overview-title" /> : <h1>Library</h1>}
          <p>{folder ? summary(childrenOf(props.items, folder.id)) : 'Pick a space on the left, or create one.'}</p>
          {folder && (
            <div className="overview-actions">
              {(['note', 'task', 'folder'] as const).map((t) => (
                <button key={t} className="btn" onClick={() => props.onOpen(create(t, folder.id, DEFAULT_TITLE[t]).id)}>
                  New {t}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </main>
  )
}

function TitleRow({ item }: { item: Item }) {
  const done = item.type === 'task' && item.status === 'done'
  return (
    <div className="title-row">
      {item.type === 'task' && (
        <button type="button" className="bigcheck" aria-pressed={done} aria-label={done ? 'Mark as not done' : 'Mark as done'} onClick={() => update(item.id, { status: done ? 'todo' : 'done' })}>
          {done ? <CircleCheck size={26} className="done-ico" aria-hidden /> : <Circle size={26} aria-hidden />}
        </button>
      )}
      <TitleInput item={item} className={done ? 'title done' : 'title'} />
    </div>
  )
}

/** Title field; a just-created item gets focus with its default name selected, ready to type over. */
function TitleInput({ item, className }: { item: Item; className: string }) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (freshId === item.id && ref.current) {
      ref.current.focus()
      ref.current.select()
      clearFresh()
    }
  }, [item.id])
  return (
    <input
      ref={ref}
      key={item.id}
      className={className}
      defaultValue={item.title}
      aria-label="Title"
      onBlur={(e) => {
        const v = e.target.value.trim()
        if (v && v !== item.title) update(item.id, { title: v })
        else e.target.value = item.title
      }}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  )
}

/** YYYY-MM-DD in the local time zone, `days` from today. */
function localDate(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function TaskFields({ item }: { item: Item }) {
  const status = item.status ?? 'todo'
  return (
    <dl className="fields">
      <dt>Status</dt>
      <dd>
        <button type="button" className={`pill ${status}`} onClick={() => update(item.id, { status: NEXT[status] })} title="Click to change">
          <span className="pill-dot" /> {STATUS_LABEL[status]}
        </button>
      </dd>
      <dt><label htmlFor={`due-${item.id}`}>Due</label></dt>
      <dd>
        <div className="due-row">
          <input id={`due-${item.id}`} type="date" className="field" value={item.due?.slice(0, 10) ?? ''} onChange={(e) => update(item.id, { due: e.target.value || undefined })} />
          {([['Today', 0], ['Tomorrow', 1], ['Next week', 7]] as const).map(([label, days]) => {
            const d = localDate(days)
            return (
              <button key={label} type="button" className={item.due?.slice(0, 10) === d ? 'chip on' : 'chip'} onClick={() => update(item.id, { due: d })}>
                {label}
              </button>
            )
          })}
          {item.due && (
            <button type="button" className="chip" onClick={() => update(item.id, { due: undefined })} aria-label="Clear the due date">
              Clear
            </button>
          )}
        </div>
      </dd>
      <dt><label htmlFor={`prio-${item.id}`}>Priority</label></dt>
      <dd>
        <select id={`prio-${item.id}`} className="field" value={item.priority ?? 'none'} onChange={(e) => update(item.id, { priority: e.target.value as Item['priority'] })}>
          <option value="none">None</option>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
      </dd>
    </dl>
  )
}

import { useSyncExternalStore } from 'react'
import { get, set } from 'idb-keyval'
import { between, DEFAULT_SETTINGS, type Item, type PullResponse, type PushResponse, type Change, type Settings } from '@blade-notes/core'
import { accessToken } from './auth'

/**
 * Offline-first: the whole library lives in IndexedDB on this device. Edits change
 * local state at once and mark the record "pending"; sync() pushes pending records,
 * then pulls everything the server has seen since `cursor`.
 */
interface State {
  items: { [id: string]: Item }
  bodies: { [id: string]: { doc: unknown; seq: number } }
  /** Missing in state saved before settings existed. */
  settings?: Settings
  cursor: number
  /** "item:<id>", "body:<id>" or "settings:settings" — records changed here and not yet accepted by the server. */
  pending: string[]
}
export type SyncStatus = 'idle' | 'syncing' | 'offline' | 'signed-out' | 'error'

const DB_KEY = 'bn:state:v1'
let state: State = { items: {}, bodies: {}, cursor: 0, pending: [] }
let status = 'idle' as SyncStatus
let loaded = false
const listeners = new Set<() => void>()
let snapshot: { state: State; status: SyncStatus; loaded: boolean } = { state, status, loaded }

function emit() {
  snapshot = { state, status, loaded }
  listeners.forEach((l) => l())
}
function commit(next: State) {
  state = next
  emit()
  void set(DB_KEY, state)
}
export function useStore() {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => snapshot,
  )
}

export async function load(): Promise<void> {
  const saved = await get<State>(DB_KEY)
  if (saved) state = saved
  loaded = true
  emit()
}

const now = () => new Date().toISOString()
const newId = () => crypto.randomUUID()
const mark = (p: string[], key: string) => (p.includes(key) ? p : [...p, key])

export function childrenOf(items: State['items'], parentId: string | null): Item[] {
  return Object.values(items)
    .filter((i) => i.parentId === parentId && !i.deletedAt)
    .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0))
}

/** The item created last on this device, so its title field can take focus once. */
export let freshId: string | null = null
export const clearFresh = () => {
  freshId = null
}

export function create(type: Item['type'], parentId: string | null, title: string, extra: Partial<Item> = {}): Item {
  const siblings = childrenOf(state.items, parentId)
  const t = now()
  const item: Item = {
    id: newId(),
    type,
    parentId,
    rank: between(siblings.at(-1)?.rank ?? null, null),
    title,
    createdAt: t,
    updatedAt: t,
    ...(type === 'task' && { status: 'todo' as const }),
    ...extra,
  }
  freshId = item.id
  commit({ ...state, items: { ...state.items, [item.id]: item }, pending: mark(state.pending, `item:${item.id}`) })
  scheduleSync()
  return item
}

export function update(id: string, patch: Partial<Item>): void {
  const cur = state.items[id]
  if (!cur) return
  const item = { ...cur, ...patch, updatedAt: now() }
  commit({ ...state, items: { ...state.items, [id]: item }, pending: mark(state.pending, `item:${id}`) })
  scheduleSync()
}

/** Moves the item and everything under it to the trash. */
export function trash(id: string): void {
  const t = now()
  const items = { ...state.items }
  let pending = state.pending
  const walk = (x: string) => {
    const it = items[x]
    if (!it) return
    items[x] = { ...it, deletedAt: t, updatedAt: t }
    pending = mark(pending, `item:${x}`)
    Object.values(state.items).filter((c) => c.parentId === x && !c.deletedAt).forEach((c) => walk(c.id))
  }
  walk(id)
  commit({ ...state, items, pending })
  scheduleSync()
}

export const settingsOf = (s: State): Settings => ({ ...DEFAULT_SETTINGS, ...s.settings })

export function updateSettings(patch: Partial<Omit<Settings, 'id'>>): void {
  const settings = { ...settingsOf(state), ...patch, updatedAt: now() }
  commit({ ...state, settings, pending: mark(state.pending, 'settings:settings') })
  scheduleSync()
}

export function setBody(id: string, doc: unknown): void {
  const seq = state.bodies[id]?.seq ?? 0
  commit({ ...state, bodies: { ...state.bodies, [id]: { doc, seq } }, pending: mark(state.pending, `body:${id}`) })
  scheduleSync()
}

// ---------------- sync ----------------

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = await accessToken()
  if (!token) throw new SignedOut()
  const res = await fetch(path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined && { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (res.status === 401) throw new SignedOut()
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status}`)
  return (await res.json()) as T
}
class SignedOut extends Error {}

function setStatus(s: SyncStatus) {
  status = s
  emit()
}

let timer: ReturnType<typeof setTimeout> | undefined
let running: Promise<void> | null = null
let again = false

export function scheduleSync(delay = 800): void {
  clearTimeout(timer)
  timer = setTimeout(() => void sync(), delay)
}

export async function sync(): Promise<void> {
  if (running) {
    again = true
    return running
  }
  running = (async () => {
    setStatus('syncing')
    try {
      await pushPending()
      await pullAll()
      setStatus('idle')
    } catch (err) {
      if (err instanceof SignedOut) setStatus('signed-out')
      else setStatus(navigator.onLine ? 'error' : 'offline')
      if (!(err instanceof SignedOut)) console.error(err)
    } finally {
      running = null
      if (again) {
        again = false
        scheduleSync(0)
      }
    }
  })()
  return running
}

async function pushPending(): Promise<void> {
  while (state.pending.length) {
    const batch = state.pending.slice(0, 100)
    const changes: Change[] = batch.flatMap((key): Change[] => {
      const [kind, id] = key.split(':') as ['item' | 'body' | 'settings', string]
      if (kind === 'settings') return [{ kind, data: settingsOf(state) }]
      if (kind === 'item') {
        const data = state.items[id]
        return data ? [{ kind, data }] : []
      }
      const b = state.bodies[id]
      return b ? [{ kind, data: { id, doc: b.doc, updatedAt: now() }, baseSeq: b.seq }] : []
    })
    const res = await call<PushResponse>('POST', '/api/sync', { changes })
    // Records edited again while the request was in flight stay pending.
    const sent = new Set(batch)
    let next = { ...state, pending: state.pending.filter((k) => !sent.has(k)) }
    for (const a of res.accepted) {
      if (a.kind === 'body' && next.bodies[a.id]) next.bodies = { ...next.bodies, [a.id]: { ...next.bodies[a.id]!, seq: a.seq } }
    }
    for (const c of res.conflicts) next = keepConflictCopy(next, c.id, c.server.doc, c.seq)
    commit(next)
  }
}

/** Another device changed this body first: take theirs, and keep ours as a sibling note. */
function keepConflictCopy(s: State, id: string, serverDoc: unknown, seq: number): State {
  const mine = s.bodies[id]
  const original = s.items[id]
  const out = { ...s, bodies: { ...s.bodies, [id]: { doc: serverDoc, seq } } }
  if (!mine || !original) return out
  const copyId = newId()
  const siblings = childrenOf(s.items, original.parentId)
  const after = siblings[siblings.findIndex((x) => x.id === id) + 1]
  const t = now()
  out.items = {
    ...s.items,
    [copyId]: {
      ...original,
      id: copyId,
      title: `${original.title} (conflict copy)`,
      rank: between(original.rank, after?.rank ?? null),
      createdAt: t,
      updatedAt: t,
    },
  }
  out.bodies[copyId] = { doc: mine.doc, seq: 0 }
  out.pending = mark(mark(s.pending, `item:${copyId}`), `body:${copyId}`)
  return out
}

async function pullAll(): Promise<void> {
  for (;;) {
    const res = await call<PullResponse>('GET', `/api/sync?since=${state.cursor}`)
    const items = { ...state.items }
    const bodies = { ...state.bodies }
    let settings = state.settings
    const pending = new Set(state.pending)
    for (const r of res.records) {
      if (pending.has(`${r.kind}:${r.data.id}`)) continue // our newer local edit wins until it is pushed
      if (r.kind === 'item') items[r.data.id] = r.data
      else if (r.kind === 'body') bodies[r.data.id] = { doc: r.data.doc, seq: r.seq }
      else settings = r.data
    }
    commit({ ...state, items, bodies, settings, cursor: res.cursor })
    if (!res.more) return
  }
}

export const MAX_FILE_MB = 50

/** Uploads one file straight to S3 (presigned POST) and returns its `/api/files/...` address. */
export async function uploadFile(file: File): Promise<string> {
  if (file.size > MAX_FILE_MB * 1024 * 1024) throw new Error(`${file.name} is over ${MAX_FILE_MB} MB`)
  const type = file.type || 'application/octet-stream'
  const { upload, src } = await call<{ upload: { url: string; fields: { [k: string]: string } }; src: string }>(
    'POST', '/api/uploads', { contentType: type, name: file.name, size: file.size },
  )
  const form = new FormData()
  for (const [k, v] of Object.entries(upload.fields)) form.append(k, v)
  form.append('file', file) // must come last
  const res = await fetch(upload.url, { method: 'POST', body: form })
  if (!res.ok) throw new Error(`upload of ${file.name} failed (${res.status})`)
  return src
}
export const uploadImage = uploadFile

export async function attach(itemId: string, files: File[]): Promise<void> {
  for (const file of files) {
    const src = await uploadFile(file)
    const cur = state.items[itemId]
    if (!cur) return
    const a = { id: newId(), name: file.name, size: file.size, type: file.type || 'application/octet-stream', src, addedAt: now() }
    update(itemId, { attachments: [...(cur.attachments ?? []), a] })
  }
}

export function detach(itemId: string, attachmentId: string): void {
  const cur = state.items[itemId]
  if (cur) update(itemId, { attachments: (cur.attachments ?? []).filter((a) => a.id !== attachmentId) })
}

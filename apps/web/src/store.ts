import { useSyncExternalStore } from 'react'
import { get, set } from 'idb-keyval'
import { between, currentZone, DEFAULT_SETTINGS, tooLarge, utf8Bytes, ymd, type Item, type PullResponse, type PushResponse, type Change, type Settings } from '@blade-notes/core'
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
  /** Pending records the server will not take (too large), with the reason; retried after the next edit. */
  rejected?: { [key: string]: string }
}
export type SyncStatus = 'idle' | 'syncing' | 'offline' | 'signed-out' | 'error'

const DB_KEY = 'bn:state:v1'
let state: State = { items: {}, bodies: {}, cursor: 0, pending: [] }
let status = 'idle' as SyncStatus
let loaded = false
const listeners = new Set<() => void>()
/** Files on their way to S3 right now; an upload cannot resume, so closing the app loses it. */
let uploading = 0
/** Writes of the library to IndexedDB that have not finished yet (a few milliseconds each). */
let writing = 0
let snapshot: { state: State; status: SyncStatus; loaded: boolean; uploading: number } = { state, status, loaded, uploading }

function emit() {
  snapshot = { state, status, loaded, uploading }
  listeners.forEach((l) => l())
}
function commit(next: State) {
  state = next
  emit()
  writing++
  void set(DB_KEY, state).finally(() => writing--)
}
/** The current state, for code outside React (the editor's start-up clean-up). */
export const currentState = () => state

/** For plain-DOM views (date chips): called after every change to the library or the clock. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * "Today" and local times depend on the date and the zone the device is in, which change
 * under a running app (midnight, or landing in another country). Called on every sync tick
 * and on focus: when either changed, everything re-renders in the new zone.
 */
let clock = ''
export function checkClock(): void {
  const d = new Date()
  const c = `${ymd(d)}|${currentZone()}|${d.getTimezoneOffset()}`
  if (c === clock) return
  const first = clock === ''
  clock = c
  if (!first) emit()
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
/**
 * Edits per record since the page loaded. A push only clears records that were not edited
 * again while it was in flight; otherwise the pull that follows would bring back the
 * server's older copy over the newer local edit.
 */
const edits = new Map<string, number>()
const mark = (p: string[], key: string) => {
  edits.set(key, (edits.get(key) ?? 0) + 1)
  return p.includes(key) ? p : [...p, key]
}
/** An edit gives a rejected record another try. */
function unreject(key: string): State['rejected'] {
  if (!state.rejected?.[key]) return state.rejected
  const { [key]: _, ...rest } = state.rejected
  return rest
}

export function childrenOf(items: State['items'], parentId: string | null): Item[] {
  return Object.values(items)
    .filter((i) => i.parentId === parentId && !i.deletedAt && i.type !== 'description' && i.type !== 'event')
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

/** A hidden description for a list item or a phrase inside `ownerId` (a note or task). */
export function createDescription(ownerId: string, title: string): string {
  const t = now()
  const item: Item = { id: newId(), type: 'description', parentId: ownerId, rank: 'a0', title: title.slice(0, 120) || 'Description', createdAt: t, updatedAt: t }
  commit({ ...state, items: { ...state.items, [item.id]: item }, pending: mark(state.pending, `item:${item.id}`) })
  scheduleSync()
  return item.id
}

/**
 * A date typed with @ in note, task or description `ownerId`. `at` is from core `stamp()`;
 * the zone it was set in is kept for calendars and the "set as 09:00 in …" hint.
 */
export function createEvent(ownerId: string, title: string, at: string, extra: Partial<Item> = {}): string {
  const t = now()
  const item: Item = {
    id: newId(), type: 'event', parentId: ownerId, rank: 'a0', title: title.slice(0, 200) || 'Untitled',
    at, tz: currentZone(), status: 'todo', createdAt: t, updatedAt: t, ...extra,
  }
  commit({ ...state, items: { ...state.items, [item.id]: item }, pending: mark(state.pending, `item:${item.id}`) })
  scheduleSync()
  return item.id
}

/** Every date chip in a document, with the text of the line it sits in (the event's title). */
export function chipsIn(doc: unknown): Map<string, string> {
  type N = { type?: string; text?: string; attrs?: { id?: string }; content?: N[] }
  const found = new Map<string, string>()
  const walk = (n: N) => {
    const kids = n.content ?? []
    const chips = kids.filter((k) => k.type === 'dateChip' && k.attrs?.id)
    if (chips.length) {
      const line = kids.map((k) => k.text ?? '').join('').replace(/\s+/g, ' ').trim()
      chips.forEach((c) => found.set(c.attrs!.id!, line))
    }
    kids.forEach(walk)
  }
  walk(doc as N)
  return found
}

/**
 * Keeps events in step with the chips in body `bodyId` after an edit: a deleted chip trashes
 * its event, an undo brings it back, and an event follows its line's text unless its title
 * was typed by hand.
 */
export function reconcileEvents(bodyId: string, doc: unknown): void {
  const found = chipsIn(doc)
  const t = now()
  let items = state.items
  let pending = state.pending
  for (const it of Object.values(state.items)) {
    if (it.type !== 'event' || it.parentId !== bodyId) continue
    const line = found.get(it.id)
    let next: Item | null = null
    if (line === undefined) next = it.deletedAt ? null : { ...it, deletedAt: t }
    else {
      const title = line.slice(0, 200) || 'Untitled'
      if (it.deletedAt || (!it.customTitle && it.title !== title)) next = { ...it, deletedAt: undefined, ...(!it.customTitle && { title }) }
    }
    if (!next) continue
    items = { ...items, [it.id]: { ...next, updatedAt: t } }
    pending = mark(pending, `item:${it.id}`)
  }
  if (items === state.items) return
  commit({ ...state, items, pending })
  scheduleSync()
}

/** The note or task a description or event belongs to (descriptions can nest). */
export function ownerOf(items: State['items'], id: string): Item | undefined {
  let cur = items[id]
  while (cur && (cur.type === 'description' || cur.type === 'event')) cur = cur.parentId ? items[cur.parentId] : undefined
  return cur
}

/** The space an item sits in. */
export function spaceOf(items: State['items'], id: string): Item | undefined {
  let cur = items[id]
  while (cur && cur.type !== 'space') cur = cur.parentId ? items[cur.parentId] : undefined
  return cur
}

/** Takes description `descId` off the phrases and list items of body `bodyId`, when its editor is not open. */
export function stripDescription(bodyId: string, descId: string): void {
  const doc = state.bodies[bodyId]?.doc
  if (!doc) return
  type N = { type?: string; attrs?: { descId?: string | null }; marks?: { type: string; attrs?: { descId?: string } }[]; content?: N[] }
  const walk = (n: N): N => ({
    ...n,
    ...(n.attrs?.descId === descId && { attrs: { ...n.attrs, descId: null } }),
    ...(n.marks && { marks: n.marks.filter((m) => !(m.type === 'describe' && m.attrs?.descId === descId)) }),
    ...(n.content && { content: n.content.map(walk) }),
  })
  setBody(bodyId, walk(doc as N))
}

/** Moves a description to the trash, with every description linked from inside it. */
export function trashDescription(id: string): void {
  const seen = new Set<string>()
  const walk = (d: string) => {
    if (seen.has(d) || !state.items[d]) return
    seen.add(d)
    for (const m of JSON.stringify(state.bodies[d]?.doc ?? {}).matchAll(/"descId":"([\w-]+)"/g)) walk(m[1]!)
  }
  walk(id)
  seen.forEach((d) => trash(d))
}

/** Plain text of a Tiptap document, for search and previews. */
export function docText(doc: unknown): string {
  if (!doc || typeof doc !== 'object') return ''
  const d = doc as { text?: string; content?: unknown[] }
  return ((d.text ?? '') + ' ' + (d.content ?? []).map(docText).join(' ')).replace(/\s+/g, ' ').trim()
}

export function update(id: string, patch: Partial<Item>): void {
  const cur = state.items[id]
  if (!cur) return
  const item = { ...cur, ...patch, updatedAt: now() }
  commit({ ...state, items: { ...state.items, [id]: item }, pending: mark(state.pending, `item:${id}`), rejected: unreject(`item:${id}`) })
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
  commit({ ...state, settings, pending: mark(state.pending, 'settings:settings'), rejected: unreject('settings:settings') })
  scheduleSync()
}

export function setBody(id: string, doc: unknown): void {
  const seq = state.bodies[id]?.seq ?? 0
  commit({ ...state, bodies: { ...state.bodies, [id]: { doc, seq } }, pending: mark(state.pending, `body:${id}`), rejected: unreject(`body:${id}`) })
  scheduleSync()
}

// ---------------- sync ----------------

/** A signed-in call to this site's API; the error carries the server's words when it sent some. */
export const api = <T>(method: string, path: string, body?: unknown): Promise<T> => call<T>(method, path, body)

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = await accessToken()
  if (!token) throw new SignedOut()
  const res = await fetch(path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined && { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (res.status === 401) throw new SignedOut()
  if (!res.ok) {
    const said = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(said?.error ?? `${method} ${path}: ${res.status}`)
  }
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

/** Requests stay well under Lambda's 6 MB payload limit. */
const BATCH_BYTES = 4_000_000

function changeFor(key: string): Change | null {
  const [kind, id] = key.split(':') as ['item' | 'body' | 'settings', string]
  if (kind === 'settings') return { kind, data: settingsOf(state) }
  if (kind === 'item') return state.items[id] ? { kind, data: state.items[id]! } : null
  const b = state.bodies[id]
  return b ? { kind, data: { id, doc: b.doc, updatedAt: now() }, baseSeq: b.seq } : null
}

async function pushPending(): Promise<void> {
  for (;;) {
    const queue = state.pending.filter((k) => !state.rejected?.[k])
    if (queue.length === 0) return
    // Fill one request: at most 100 changes and BATCH_BYTES. Too-large records are set aside
    // with their reason (shown to the user) instead of failing the whole sync again and again.
    const batch: string[] = []
    const changes: Change[] = []
    const setAside: { [key: string]: string } = {}
    let bytes = 0
    for (const key of queue) {
      const c = changeFor(key)
      if (!c) {
        batch.push(key) // deleted locally before it was ever sent: nothing to push
        continue
      }
      const why = tooLarge(c)
      if (why) {
        setAside[key] = why
        continue
      }
      const n = utf8Bytes(JSON.stringify(c))
      if (changes.length && (changes.length >= 100 || bytes + n > BATCH_BYTES)) break
      batch.push(key)
      changes.push(c)
      bytes += n
    }
    if (Object.keys(setAside).length) commit({ ...state, rejected: { ...state.rejected, ...setAside } })
    if (batch.length === 0) continue

    const version = new Map(batch.map((k) => [k, edits.get(k) ?? 0]))
    const res: PushResponse = changes.length ? await call<PushResponse>('POST', '/api/sync', { changes }) : { accepted: [], conflicts: [] }
    const turnedAway = Object.fromEntries((res.rejected ?? []).map((r) => [`${r.kind}:${r.id}`, r.reason]))
    // Records edited again while the request was in flight stay pending; turned-away ones wait for an edit.
    const sent = new Set(batch.filter((k) => !turnedAway[k] && (edits.get(k) ?? 0) === version.get(k)))
    let next: State = { ...state, pending: state.pending.filter((k) => !sent.has(k)), rejected: { ...state.rejected, ...turnedAway } }
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
  uploading++
  emit()
  try {
    return await upload(file)
  } finally {
    uploading--
    emit()
  }
}

// ---- closing the app ----

const flushers = new Set<() => void>()
/** Editors register here, so closing or hiding the app saves their last keystrokes at once. */
export function onFlush(save: () => void): () => void {
  flushers.add(save)
  return () => flushers.delete(save)
}

/** The warning an upload in flight deserves, or null. */
export const uploadWarning = (): string | null =>
  uploading === 0 ? null : uploading === 1 ? 'A file is still uploading. Closing now cancels it.' : `${uploading} files are still uploading. Closing now cancels them.`

/**
 * Called when the app is about to close or hide. Saves every editor's pending text, then says
 * what would still be lost: an upload, or a write to this device still under way. Changes only
 * waiting for the cloud are safe (they are on this device and sync next time), so they get none.
 */
export function closeWarning(): string | null {
  flushers.forEach((f) => f())
  return uploadWarning() ?? (writing ? 'Your last change is still being saved on this device.' : null)
}

async function upload(file: File): Promise<string> {
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

/**
 * Files need sign-in: `/api/files/...` answers with a 60-second signed link, which is fetched
 * at once and kept in memory as a blob URL for this page's life. Nothing reaches the browser cache.
 */
const blobs = new Map<string, Promise<string>>()
export function fileBlobUrl(src: string): Promise<string> {
  if (!src.startsWith('/api/files/')) return Promise.resolve(src)
  let p = blobs.get(src)
  if (!p) {
    p = (async () => {
      const { url } = await call<{ url: string }>('GET', src)
      const res = await fetch(url, { cache: 'no-store' })
      if (!res.ok) throw new Error(`file: ${res.status}`)
      return URL.createObjectURL(await res.blob())
    })()
    p.catch(() => blobs.delete(src)) // a failure is retried next time
    blobs.set(src, p)
  }
  return p
}

/** Starts a download of an attachment under its original name. */
export async function downloadFile(src: string, name: string): Promise<void> {
  const { url } = await call<{ url: string }>('GET', `${src}?name=${encodeURIComponent(name)}`)
  const a = document.createElement('a')
  a.href = url
  a.rel = 'noopener'
  a.click()
}

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

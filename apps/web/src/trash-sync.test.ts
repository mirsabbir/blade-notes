import { beforeEach, describe, expect, it, vi } from 'vitest'

// The store's outside world: a signed-in token, IndexedDB, and a server that keeps tombstones
// the way services/api does: an item write over a tombstone is refused.
vi.mock('./auth', () => ({ accessToken: async () => 'token' }))
vi.mock('idb-keyval', () => ({ get: async () => undefined, set: async () => {} }))

type Json = { id: string; purgedAt?: string; [k: string]: unknown }
type Stored = { kind: 'item' | 'body'; seq: number; data: Json }
let server: { records: Map<string, Stored>; seq: number }
/** When set, the next pull answers only once the test calls the function it leaves here. */
let hold: { release?: () => void } | null = null

function fakeFetch(path: string, init?: { method?: string; body?: string }) {
  const json = (v: unknown) => Promise.resolve(new Response(JSON.stringify(v), { status: 200 }))
  if (init?.method === 'POST') {
    const { changes } = JSON.parse(init.body!) as { changes: { kind: 'item' | 'body'; data: Json }[] }
    const accepted = []
    for (const c of changes) {
      const key = `${c.kind}:${c.data.id}`
      if (c.kind === 'item' && server.records.get(key)?.data.purgedAt && !c.data.purgedAt) continue
      server.records.set(key, { kind: c.kind, seq: ++server.seq, data: c.data })
      accepted.push({ kind: c.kind, id: c.data.id, seq: server.seq })
    }
    return json({ accepted, conflicts: [] })
  }
  const since = Number(new URL(path, 'http://x').searchParams.get('since'))
  const records = [...server.records.values()].filter((r) => r.seq > since).sort((a, b) => a.seq - b.seq)
  const body = JSON.stringify({ records, cursor: server.seq, more: false })
  if (!hold) return json(JSON.parse(body))
  const h = hold
  hold = null
  return new Promise<Response>((resolve) => {
    h.release = () => resolve(new Response(body, { status: 200 }))
  })
}

/** Another device deletes `id` for good: the server now holds its tombstone. */
function deletedElsewhere(id: string) {
  const it = server.records.get(`item:${id}`)!.data
  server.records.set(`item:${id}`, { kind: 'item', seq: ++server.seq, data: { ...it, title: '', deletedAt: 'x', purgedAt: '2026-11-15T00:00:00.000Z' } })
}

describe('deleted for good beats every edit', () => {
  beforeEach(() => {
    vi.resetModules()
    server = { records: new Map(), seq: 0 }
    hold = null
    vi.stubGlobal('fetch', vi.fn(fakeFetch))
    vi.stubGlobal('navigator', { onLine: true })
  })

  it('an edit made on a device that had not heard of the delete is dropped, text and all', async () => {
    const store = await import('./store')
    const note = store.create('note', null, 'Groceries')
    store.setBody(note.id, { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'milk' }] }] })
    await store.sync()

    deletedElsewhere(note.id)
    store.update(note.id, { title: 'Groceries (edited offline)' })
    store.setBody(note.id, { type: 'doc', content: [] })
    await store.sync()

    const now = store.currentState()
    expect(now.items[note.id]!.purgedAt).toBeTruthy()
    expect(now.items[note.id]!.title).toBe('')
    expect(now.bodies[note.id]).toBeUndefined()
    expect(now.pending).toEqual([])
    expect(server.records.get(`item:${note.id}`)!.data.purgedAt).toBeTruthy() // the server kept the tombstone
  })

  it('an edit typed while the pull is on its way still loses to the tombstone it brings', async () => {
    const store = await import('./store')
    const note = store.create('note', null, 'Groceries')
    await store.sync()

    deletedElsewhere(note.id)
    const h: { release?: () => void } = (hold = {})
    const syncing = store.sync()
    await vi.waitFor(() => expect(h.release).toBeDefined())
    store.update(note.id, { title: 'typed during the pull' }) // pending when the tombstone lands
    h.release!()
    await syncing
    await store.sync()

    const now = store.currentState()
    expect(now.items[note.id]!.purgedAt).toBeTruthy()
    expect(now.pending).toEqual([])
  })

  it('a restore from a device that had not heard of the delete does not bring it back', async () => {
    const store = await import('./store')
    const note = store.create('note', null, 'Old')
    store.trash(note.id)
    await store.sync()

    deletedElsewhere(note.id)
    store.restore({ id: note.id })
    expect(store.currentState().items[note.id]!.deletedAt).toBeUndefined()
    await store.sync()

    expect(store.currentState().items[note.id]!.purgedAt).toBeTruthy()
  })

  it('delete for good here drops the text at once and never pushes it again', async () => {
    const store = await import('./store')
    const space = store.create('space', null, 'Work')
    const folder = store.create('folder', space.id, 'Plans')
    const note = store.create('note', folder.id, 'Draft')
    const sibling = store.create('note', space.id, 'Keep me')
    store.setBody(note.id, { type: 'doc', content: [] })
    store.trash(folder.id)
    store.deleteForever({ id: folder.id })

    const now = store.currentState()
    expect([folder.id, note.id].map((id) => !!now.items[id]!.purgedAt)).toEqual([true, true])
    expect([space.id, sibling.id].map((id) => !!now.items[id]!.purgedAt || !!now.items[id]!.deletedAt)).toEqual([false, false])
    expect(now.bodies[note.id]).toBeUndefined()
    expect(now.pending).not.toContain(`body:${note.id}`)
    await store.sync()
    expect(server.records.has(`body:${note.id}`)).toBe(false)
  })

  it('a removed attachment goes to the trash, not away, and comes back with restore', async () => {
    const store = await import('./store')
    const note = store.create('note', null, 'With file')
    store.update(note.id, { attachments: [{ id: 'f1', name: 'a.pdf', size: 1, type: 'application/pdf', src: '/api/files/u/f1.pdf', addedAt: 'x' }] })
    store.detach(note.id, 'f1')
    expect(store.currentState().items[note.id]!.attachments![0]!.deletedAt).toBeTruthy()
    store.restore({ id: note.id, attachmentId: 'f1' })
    expect(store.currentState().items[note.id]!.attachments![0]!.deletedAt).toBeUndefined()
  })
})

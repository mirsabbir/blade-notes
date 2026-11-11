import { beforeEach, describe, expect, it, vi } from 'vitest'

// The store's outside world: a signed-in token, IndexedDB, and a server we control.
vi.mock('./auth', () => ({ accessToken: async () => 'token' }))
vi.mock('idb-keyval', () => ({ get: async () => undefined, set: async () => {} }))

type Json = { [k: string]: unknown }
let server: { items: { [id: string]: Json }; seq: number }
let holdPush: (() => void) | null = null

function fakeFetch(path: string, init?: { method?: string; body?: string }) {
  const json = (v: unknown) => Promise.resolve(new Response(JSON.stringify(v), { status: 200 }))
  if (init?.method === 'POST') {
    const { changes } = JSON.parse(init.body!) as { changes: { kind: string; data: Json }[] }
    const apply = () => {
      const accepted = changes.map((c) => {
        server.items[c.data.id as string] = c.data
        return { kind: c.kind, id: c.data.id, seq: ++server.seq }
      })
      return { accepted, conflicts: [] }
    }
    // The test decides when the first push's answer arrives; later ones answer at once.
    const body = apply()
    if (holdPush) return json(body)
    return new Promise<Response>((resolve) => {
      holdPush = () => resolve(new Response(JSON.stringify(body), { status: 200 }))
    })
  }
  const since = Number(new URL(path, 'http://x').searchParams.get('since'))
  const records = Object.values(server.items).map((data, i) => ({ kind: 'item', seq: i + 1, data })).filter((r) => r.seq > since)
  return json({ records, cursor: server.seq, more: false })
}

describe('sync keeps edits made while a push is in flight', () => {
  beforeEach(() => {
    vi.resetModules()
    server = { items: {}, seq: 0 }
    holdPush = null
    vi.stubGlobal('fetch', vi.fn(fakeFetch))
    vi.stubGlobal('navigator', { onLine: true })
  })

  it('a rename typed during the first upload survives the pull that follows', async () => {
    const store = await import('./store')
    const item = store.create('note', null, 'Untitled')
    const syncing = store.sync() // pushes "Untitled"
    await vi.waitFor(() => expect(holdPush).not.toBeNull())
    store.update(item.id, { title: 'Grüße αβγ বাংলা 😀' }) // typed while the push is in flight
    holdPush!()
    await syncing

    const now = store.currentState()
    expect(now.items[item.id]!.title).toBe('Grüße αβγ বাংলা 😀') // the pull did not bring back "Untitled"
    expect(server.items[item.id]!.title).toBe('Grüße αβγ বাংলা 😀') // the rename was pushed in a second round
    expect(now.pending).toEqual([])
  })
})

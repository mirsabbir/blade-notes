import { beforeAll, describe, expect, it, vi } from 'vitest'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createMcpHandler } from '@modelcontextprotocol/server'
import type { Change, PullResponse, PushResponse, Record as SyncRecord } from '@blade-notes/core'

// The sync API's storage, in memory: every write takes the next seq, like DynamoDB's counter.
const store = vi.hoisted(() => ({ records: new Map<string, { kind: string; seq: number; data: { id: string } }>(), seq: 0, beforePush: undefined as undefined | (() => void) }))
vi.mock('../sync', () => ({
  pull: async (_pk: string, since: number): Promise<PullResponse> => {
    const records = [...store.records.values()].filter((r) => r.seq > since).sort((a, b) => a.seq - b.seq) as unknown as SyncRecord[]
    return { records: structuredClone(records), cursor: records.at(-1)?.seq ?? since, more: false }
  },
  push: async (_pk: string, req: { changes: Change[] }): Promise<PushResponse> => {
    store.beforePush?.()
    store.beforePush = undefined
    const out: PushResponse = { accepted: [], conflicts: [] }
    for (const c of req.changes) {
      const key = `${c.kind}:${c.data.id}`
      const cur = store.records.get(key)
      if (c.kind === 'body' && cur && cur.seq > c.baseSeq) {
        out.conflicts.push({ id: c.data.id, server: cur.data as never, seq: cur.seq })
        continue
      }
      store.records.set(key, { kind: c.kind, seq: ++store.seq, data: structuredClone(c.data) })
      out.accepted.push({ kind: c.kind, id: c.data.id, seq: store.seq })
    }
    return out
  },
}))

const { server } = await import('./tools')

const SUB = 'user-1'
/** 'modern' = protocol 2026-07-28 (stateless, no initialize); 'legacy' = the 2025 initialize handshake, the client's default. */
async function connect(scopes: string[], era: 'modern' | 'legacy' = 'modern') {
  const handler = createMcpHandler(() => server({ sub: SUB, scopes, zone: 'Asia/Dhaka' }))
  const client = new Client({ name: 'test', version: '1' }, era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {})
  const transport = new StreamableHTTPClientTransport(new URL('https://notes.test/mcp'), { fetch: (url, init) => handler.fetch(new Request(url, init)) })
  await client.connect(transport)
  expect(client.getNegotiatedProtocolVersion()).toBe(era === 'modern' ? '2026-07-28' : '2025-11-25')
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args })
    const text = (res.content as { type: string; text: string }[]).map((c) => c.text).join('\n')
    return { text, error: !!res.isError }
  }
  return { client, call }
}

const ok = async (p: Promise<{ text: string; error: boolean }>) => {
  const r = await p
  expect(r.error, r.text).toBe(false)
  return r.text
}
const idIn = (text: string, title: string) => new RegExp(`${title} · ([0-9a-f-]{8,})`).exec(text)![1]!

beforeAll(() => {
  store.records.clear()
})

describe('MCP server', () => {
  it('a read-only connection sees only the reading tools', async () => {
    const { client } = await connect(['notes:read'])
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['agenda', 'browse', 'overview', 'read', 'search'])
  })

  it('creates a library, reads it back, finds it, and edits it', async () => {
    const { client, call } = await connect(['notes:read', 'notes:write'])
    expect((await client.listTools()).tools).toHaveLength(9)
    expect(client.getInstructions()).toContain('TEXT IS MARKDOWN')

    const made = await ok(
      call('create', {
        items: [
          { type: 'space', title: 'Work' },
          { type: 'folder', title: 'Projects', in: 'Work' },
          { type: 'note', title: 'Q4 plan', in: 'Work/Projects', text: '## Goals\n\n- Ship the **MCP** server\n- Call the bank [@2026-11-20 10:00](date:new)\n\nBudget for the [offsite](desc:new "Cox\'s Bazar, 3 days")' },
          { type: 'task', title: 'Pay rent', in: 'Work', due: '2026-11-10', priority: 'high' },
        ],
      }),
    )
    expect(made).toContain('Created 4')
    const plan = idIn(made, 'Q4 plan')

    const overview = await ok(call('overview'))
    expect(overview).toContain('time zone Asia/Dhaka')
    expect(overview).toMatch(/Work · [0-9a-f]{8} .*1 folder · 1 note · 1 task \(1 open, 1 late\)/)

    const read = await ok(call('read', { refs: [plan] }))
    expect(read).toContain('# Q4 plan')
    expect(read).toMatch(/- Call the bank \[@Fri 2026-11-20 10:00\]\(date:[0-9a-f]{8}\)/)
    expect(read).toMatch(/\[offsite\]\(desc:[0-9a-f]{8}\)/)
    expect(read).toContain("Cox's Bazar, 3 days")
    const version = Number(/version (\d+)/.exec(read)![1])

    expect(await ok(call('search', { query: 'offsite bazar' }))).toContain('Q4 plan')
    expect(await ok(call('search', { query: 'nothing-like-this' }))).toContain('Nothing found')
    expect(await ok(call('search', { count_by: 'type' }))).toMatch(/^\d+ found\. By type: .*note 1/)
    expect(await ok(call('search', { overdue: true }))).toContain('Pay rent')

    const agenda = await ok(call('agenda', { from: '2026-11-16', days: 7 }))
    expect(agenda).toContain('Late:')
    expect(agenda).toContain('Pay rent')
    expect(agenda).toMatch(/Fri 2026-11-20:\n- 10:00 Call the bank · date [0-9a-f]{8} · in note "Q4 plan"/)

    const edited = await ok(call('edit', { ref: plan, version, replace: [{ find: 'Ship the **MCP** server', with: 'Ship the ~~MCP~~ server' }] }))
    expect(edited).toContain('Saved "Q4 plan"')
    const stale = await call('edit', { ref: plan, version, append: 'late edit' })
    expect(stale.error).toBe(true)
    expect(stale.text).toContain('changed since version')

    // Moving the date in the text moves its event; removing it trashes the event.
    const after = await ok(call('read', { refs: ['Q4 plan'] }))
    const dateLink = /\[@[^\]]+\]\(date:([0-9a-f]+)\)/.exec(after)!
    await ok(call('edit', { ref: plan, replace: [{ find: dateLink[0], with: `[@2026-11-21](date:${dateLink[1]})` }] }))
    expect(await ok(call('agenda', { from: '2026-11-16', days: 7 }))).toMatch(/Sat 2026-11-21:\n- Call the bank/)
    await ok(call('edit', { ref: plan, replace: [{ find: ` [@Sat 2026-11-21](date:${dateLink[1]})`, with: '' }] }))
    expect(await ok(call('agenda', { from: '2026-11-16', days: 7 }))).not.toContain('Call the bank')
  })

  it('updates, moves, trashes and restores; mistakes come back as advice', async () => {
    const { call } = await connect(['notes:read', 'notes:write'], 'legacy')
    await ok(call('create', { items: [{ type: 'folder', title: 'Archive', in: 'Work' }] }))
    expect(await ok(call('update', { items: [{ ref: 'Work/Pay rent', status: 'done', in: 'Work/Archive' }] }))).toMatch(/\[task: done, high, due Tue 2026-11-10\] Pay rent · [0-9a-f]{8} · in Work\/Archive/)
    expect(await ok(call('trash', { refs: ['Work/Archive'] }))).toContain('Moved to the trash: Archive')
    expect(await ok(call('search', { query: 'rent' }))).toContain('Nothing found')
    expect(await ok(call('search', { trash: true }))).toContain('Pay rent')
    expect(await ok(call('trash', { refs: ['Archive'], restore: true }))).toContain('Restored: Archive')
    expect(await ok(call('browse', { in: 'Work', depth: 3 }))).toMatch(/- \[folder\] Archive[^\n]*\n {2}- \[task: done/)

    const missing = await call('read', { refs: ['Work/Nope'] })
    expect(missing.error).toBe(true)
    expect(missing.text).toContain('Nothing called "Nope" in Work. There: Projects, Archive')
    const secret = await call('edit', { ref: 'Q4 plan', append: '[🔒 pin](secret:12345678)' })
    expect(secret.text).toContain('Secret blocks are made only in the app')
    const space = await call('create', { items: [{ type: 'space', title: 'X', in: 'Work' }] })
    expect(space.text).toContain('Spaces are at the top')
    expect((await call('agenda', { timezone: '-05:00' })).text).toContain('not a time zone')
    expect(await ok(call('agenda', { timezone: 'america/new_york' }))).toContain('time zone America/New_York')
    expect((await call('update', { items: [{ ref: 'Work/Projects', after: 'Work/Projects' }] })).text).toContain('cannot go inside or after itself')
  })

  it('an edit that meets a newer text in the app saves nothing at all', async () => {
    const { call } = await connect(['notes:read', 'notes:write'])
    const read = await ok(call('read', { refs: ['Q4 plan'] }))
    const desc = /\[offsite\]\(desc:([0-9a-f]+)\)/.exec(read)!
    const note = /\] Q4 plan · ([0-9a-f]+)|^\[note\] · ([0-9a-f]+)/m.exec(read.split('\n')[1]!)!
    const body = [...store.records.values()].find((r) => r.kind === 'body' && r.data.id.startsWith((note[1] ?? note[2])!))!
    store.beforePush = () => void (body.seq = ++store.seq) // the owner types in the app between our read and our save
    const res = await call('edit', { ref: 'Q4 plan', replace: [{ find: desc[0], with: 'offsite' }] })
    expect(res.error).toBe(true)
    expect(res.text).toContain('Nothing was saved')
    const d = [...store.records.values()].find((r) => r.kind === 'item' && r.data.id.startsWith(desc[1]!))!
    expect((d.data as { deletedAt?: string }).deletedAt).toBeUndefined()
  })
})

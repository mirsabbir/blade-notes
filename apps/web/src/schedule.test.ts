import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./auth', () => ({ accessToken: async () => null }))
vi.mock('idb-keyval', () => ({ get: async () => undefined, set: async () => {} }))
vi.stubGlobal('fetch', async () => new Response('{}', { status: 401 }))

const { chipsIn, create, createEvent, currentState, reconcileEvents } = await import('./store')
const { contentToText, toMarkdown } = await import('./copy')

const p = (...content: object[]) => ({ type: 'paragraph', content })
const t = (text: string) => ({ type: 'text', text })
const chip = (id: string, at: string) => ({ type: 'dateChip', attrs: { id, at } })
const original = process.env.TZ
afterEach(() => {
  process.env.TZ = original
})

describe('date chips and their events', () => {
  it('names each event after its line and follows the line, a removed chip and an undo', () => {
    const task = create('task', null, 'Passport')
    const id = createEvent(task.id, '', '2026-11-15')
    const doc = { type: 'doc', content: [p(t('Book the  appointment '), chip(id, '2026-11-15'))] }
    expect(chipsIn(doc).get(id)).toBe('Book the appointment')

    reconcileEvents(task.id, doc)
    expect(currentState().items[id]!.title).toBe('Book the appointment')

    reconcileEvents(task.id, { type: 'doc', content: [p(t('Book the appointment'))] })
    expect(currentState().items[id]!.deletedAt).toBeTruthy()

    reconcileEvents(task.id, doc) // undo brings the chip back
    expect(currentState().items[id]!.deletedAt).toBeUndefined()
  })

  it('keeps a title typed by hand', () => {
    const task = create('task', null, 'Bank')
    const id = createEvent(task.id, 'Call the bank', '2026-11-16', { customTitle: true })
    reconcileEvents(task.id, { type: 'doc', content: [p(t('Something else '), chip(id, '2026-11-16'))] })
    expect(currentState().items[id]!.title).toBe('Call the bank')
  })
})

describe('the Copy button', () => {
  it('writes dates out, keeps secrets as dots and brings descriptions along', () => {
    process.env.TZ = 'Asia/Dhaka'
    const task = create('task', null, 'Passport & visa')
    const id = createEvent(task.id, 'Book', '2026-11-15T10:00:00+06:00')
    const doc = {
      type: 'doc',
      content: [
        p(t('Intro with a '), { type: 'text', text: 'link', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }] }),
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [p(t('Book the appointment '), chip(id, '2026-11-15T10:00:00+06:00'))] },
            { type: 'listItem', content: [p(t('PIN '), { type: 'secret', attrs: { label: 'PIN', data: 'v1:abc' } })] },
          ],
        },
      ],
    }
    const md = toMarkdown(currentState().items[task.id]!, doc)
    expect(md).toContain('# Passport & visa')
    expect(md).toContain('Status: To do')
    expect(md).toContain('Intro with a [link](https://example.com)')
    expect(md).toContain('- Book the appointment Sun 15 Nov 2026, 10:00')
    expect(md).toContain('- PIN ••••••')
    expect(md).not.toContain('v1:abc')
  })
})

describe('plain-text copy of a selection', () => {
  it('is Markdown without stacks of blank lines', () => {
    process.env.TZ = 'Asia/Dhaka'
    const content = [
      p(t('Intro')),
      { type: 'image', attrs: { src: '/api/files/a/b.png', alt: 'scan.png' } },
      { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('One '), chip('x', '2026-11-15'))] }, { type: 'listItem', content: [p(t('Two'))] }] },
    ]
    expect(contentToText(content as never)).toBe('Intro\n\n[image: scan.png]\n\n- One Sun 15 Nov 2026\n- Two')
  })
})

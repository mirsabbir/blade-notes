import { describe, expect, it } from 'vitest'
import type { Attachment, Item } from './types'
import {
  applyPurge, applyRestore, batchRoot, cleanup, expiredPlan, filesInText, isHidden, liveAttachments, purgePlan, restorePlan,
  tombstone, trashIds, trashRows, TRASH_DAYS, type Items, type Target,
} from './trash'

// ---------- a library to work on ----------
//
// S (space)
//   F1 (folder)
//     F2 (folder)
//       N1 (note)  attachments a1, a2   text: D1 (description) → D1a (description), E1 (date)
//       N2 (note)
//       T1 (task)  attachment t1
//     N3 (note)
//   F3 (folder)
//     N4 (note)
// S2 (space)
//   N5 (note)  attachment a5

const T0 = '2026-11-01T00:00:00.000Z'
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString()
const file = (id: string): Attachment => ({ id, name: `${id}.pdf`, size: 10, type: 'application/pdf', src: `/api/files/u1/${id}.pdf`, addedAt: T0 })
const item = (id: string, type: Item['type'], parentId: string | null, extra: Partial<Item> = {}): Item => ({
  id, type, parentId, rank: 'a0', title: id, createdAt: T0, updatedAt: T0, ...extra,
})

const LIBRARY: Items = Object.fromEntries(
  [
    item('S', 'space', null),
    item('F1', 'folder', 'S'),
    item('F2', 'folder', 'F1'),
    item('N1', 'note', 'F2', { attachments: [file('a1'), file('a2')] }),
    item('D1', 'description', 'N1'),
    item('D1a', 'description', 'D1'),
    item('E1', 'event', 'N1', { at: '2026-11-20' }),
    item('N2', 'note', 'F2'),
    item('T1', 'task', 'F2', { status: 'todo', attachments: [file('t1')] }),
    item('N3', 'note', 'F1'),
    item('F3', 'folder', 'S'),
    item('N4', 'note', 'F3'),
    item('S2', 'space', null),
    item('N5', 'note', 'S2', { attachments: [file('a5')] }),
  ].map((i) => [i.id, i]),
)
const ALL = Object.keys(LIBRARY)
const VISIBLE = ALL.filter((id) => !isHidden(LIBRARY[id]!))

// ---------- the app's actions, written with the core functions ----------

const apply = (items: Items, changed: Item[]): Items => ({ ...items, ...Object.fromEntries(changed.map((i) => [i.id, i])) })
const trash = (items: Items, id: string, t: string): Items =>
  apply(items, trashIds(items, id).map((x) => ({ ...items[x]!, deletedAt: t, updatedAt: t })))
const trashFile = (items: Items, id: string, attachmentId: string, t: string): Items => {
  const it = items[id]!
  return apply(items, [{ ...it, attachments: it.attachments!.map((a) => (a.id === attachmentId ? { ...a, deletedAt: t } : a)), updatedAt: t }])
}
const restore = (items: Items, target: Target, t: string): Items => {
  const plan = restorePlan(items, target)
  if (!plan) throw new Error(`cannot restore ${JSON.stringify(target)}`)
  return apply(items, applyRestore(items, plan, t))
}
const purge = (items: Items, target: Target, t: string): Items => apply(items, applyPurge(items, purgePlan(items, target), t))

const trashed = (items: Items) => ALL.filter((id) => items[id]!.deletedAt).sort()
const live = (items: Items) => ALL.filter((id) => !items[id]!.deletedAt).sort()
const fileState = (items: Items, id: string, a: string) => {
  const f = items[id]!.attachments!.find((x) => x.id === a)!
  return f.purgedAt ? 'purged' : f.deletedAt ? 'trashed' : 'live'
}
/** Everything but updatedAt, which restoring stamps. */
const shape = (items: Items) => Object.fromEntries(Object.values(items).map(({ updatedAt: _, ...rest }) => [rest.id, rest]))
const ancestorsOf = (items: Items, id: string): string[] => {
  const out: string[] = []
  for (let p = items[id]!.parentId; p; p = items[p]!.parentId) out.push(p)
  return out
}
const subtree = (items: Items, id: string): string[] => [id, ...ALL.filter((x) => ancestorsOf(items, x).includes(id))]
const rows = (items: Items) => trashRows(items).map((r) => r.key)

// ---------- moving to the trash ----------

describe('trashIds: what one delete takes', () => {
  it('a note takes its own text (descriptions, nested descriptions, dates) and nothing beside or above it', () => {
    expect(trashIds(LIBRARY, 'N1').sort()).toEqual(['D1', 'D1a', 'E1', 'N1'])
  })

  it('a folder takes every level under it, and nothing outside it', () => {
    expect(trashIds(LIBRARY, 'F1').sort()).toEqual(['D1', 'D1a', 'E1', 'F1', 'F2', 'N1', 'N2', 'N3', 'T1'])
  })

  it('a space takes only that space', () => {
    expect(trashIds(LIBRARY, 'S2').sort()).toEqual(['N5', 'S2'])
  })

  it('never touches siblings, the parent, or other branches', () => {
    for (const id of VISIBLE) {
      const taken = new Set(trashIds(LIBRARY, id))
      expect([...taken].sort()).toEqual(subtree(LIBRARY, id).sort())
      for (const a of ancestorsOf(LIBRARY, id)) expect(taken.has(a)).toBe(false)
    }
  })

  it('leaves what is already in the trash, and everything under it, with its own moment', () => {
    const s1 = trash(LIBRARY, 'N1', at(1))
    expect(trashIds(s1, 'F2').sort()).toEqual(['F2', 'N2', 'T1'])
    const s2 = trash(s1, 'F2', at(2))
    expect(['N1', 'D1', 'D1a', 'E1'].map((id) => s2[id]!.deletedAt)).toEqual([at(1), at(1), at(1), at(1)])
    expect(['F2', 'N2', 'T1'].map((id) => s2[id]!.deletedAt)).toEqual([at(2), at(2), at(2)])
  })

  it('takes nothing for an unknown id or something already in the trash', () => {
    expect(trashIds(LIBRARY, 'nope')).toEqual([])
    expect(trashIds(trash(LIBRARY, 'N2', at(1)), 'N2')).toEqual([])
  })

  it('leaves attachments alone: they go and come back with their item', () => {
    const s1 = trash(LIBRARY, 'N1', at(1))
    expect(s1.N1!.attachments).toEqual(LIBRARY.N1!.attachments)
  })

  it('survives a parent loop in bad data', () => {
    const looped = apply(LIBRARY, [item('X', 'folder', 'Y'), item('Y', 'folder', 'X')])
    expect(trashIds(looped, 'X').sort()).toEqual(['X', 'Y'])
  })
})

// ---------- what the trash shows ----------

describe('trashRows: one line per delete', () => {
  it('shows one line for a folder deleted with everything inside, counting the notes and tasks in it', () => {
    const s = trash(LIBRARY, 'F2', at(1))
    const r = trashRows(s)
    expect(r.map((x) => x.key)).toEqual(['F2'])
    expect(r[0]!.inside).toBe(3) // N1, N2, T1; descriptions and dates are not counted
    expect(r[0]!.place.map((p) => p.id)).toEqual(['S', 'F1'])
    expect(r[0]!.placeInTrash).toBe(false)
  })

  it('keeps an earlier separate delete as its own line, saying its place is in the trash too', () => {
    const s = trash(trash(LIBRARY, 'N1', at(1)), 'F1', at(2))
    const r = trashRows(s)
    expect(r.map((x) => x.key)).toEqual(['F1', 'N1'])
    expect(r[1]!.placeInTrash).toBe(true)
    expect(r[0]!.inside).toBe(4) // F2, N2, T1, N3 (N1 went earlier)
  })

  it('shows a deleted attachment on its own; the other attachment of the same note is untouched', () => {
    const s = trashFile(LIBRARY, 'N1', 'a1', at(1))
    const r = trashRows(s)
    expect(r.map((x) => x.key)).toEqual(['N1/a1'])
    expect(r[0]!.place.map((p) => p.id)).toEqual(['S', 'F1', 'F2', 'N1'])
    expect(r[0]!.placeInTrash).toBe(false)
    expect(fileState(s, 'N1', 'a2')).toBe('live')
  })

  it('your case: attachment deleted, then its note: two lines, the attachment says its note is in the trash', () => {
    const s = trash(trashFile(LIBRARY, 'N1', 'a1', at(0)), 'N1', at(60))
    const r = trashRows(s)
    expect(r.map((x) => x.key)).toEqual(['N1', 'N1/a1'])
    expect(r[1]!.placeInTrash).toBe(true)
  })

  it('never shows descriptions or dates on their own', () => {
    const s = trash(trash(LIBRARY, 'E1', at(1)), 'D1', at(2))
    expect(rows(s)).toEqual([])
  })

  it('hides an attachment of a description that left the text: it goes with the description', () => {
    const withFile = apply(LIBRARY, [{ ...LIBRARY.D1!, attachments: [file('d')] }])
    const s = trash(trashFile(withFile, 'D1', 'd', at(1)), 'D1', at(2))
    expect(rows(s)).toEqual([])
  })

  it('shows an attachment of a description that went with its note, placed at the note', () => {
    const withFile = apply(LIBRARY, [{ ...LIBRARY.D1!, attachments: [file('d')] }])
    const s = trash(trashFile(withFile, 'D1', 'd', at(1)), 'N1', at(2))
    const r = trashRows(s).find((x) => x.key === 'D1/d')!
    expect(r.place.map((p) => p.id)).toEqual(['S', 'F1', 'F2', 'N1'])
    expect(r.placeInTrash).toBe(true)
  })

  it('never shows tombstones, or anything under one', () => {
    const s = purge(trash(LIBRARY, 'F2', at(1)), { id: 'F2' }, at(2))
    expect(rows(s)).toEqual([])
    const orphan = apply(s, [item('late', 'note', 'F2', { deletedAt: at(3) })])
    expect(rows(orphan)).toEqual([])
  })

  it('lists newest first and gives the 30-day end', () => {
    const s = trash(trash(LIBRARY, 'N4', at(1)), 'N5', at(2))
    const r = trashRows(s)
    expect(r.map((x) => x.key)).toEqual(['N5', 'N4'])
    expect(r[0]!.expiresAt).toBe(new Date(Date.parse(at(2)) + TRASH_DAYS * 86_400_000).toISOString())
  })
})

describe('batchRoot', () => {
  it('finds the item a delete started from, and stops at an earlier separate delete', () => {
    const s = trash(trash(LIBRARY, 'N1', at(1)), 'F1', at(2))
    expect(batchRoot(s, 'T1')!.id).toBe('F1')
    expect(batchRoot(s, 'D1a')!.id).toBe('N1')
    expect(batchRoot(s, 'N1')!.id).toBe('N1')
  })
})

// ---------- restoring ----------

describe('restore: brings back what that delete took, never a sibling', () => {
  it('round trip: deleting anything and restoring it gives back the library exactly', () => {
    for (const id of VISIBLE) {
      const back = restore(trash(LIBRARY, id, at(1)), { id }, at(2))
      expect(shape(back)).toEqual(shape(LIBRARY))
    }
  })

  it('a folder comes back with what went with it; a note deleted earlier inside it stays in the trash', () => {
    const s = trash(trash(LIBRARY, 'N2', at(1)), 'F2', at(2))
    const back = restore(s, { id: 'F2' }, at(3))
    expect(trashed(back)).toEqual(['N2'])
    expect(rows(back)).toEqual(['N2'])
  })

  it('a note comes back with its descriptions and dates, but not a date already removed from its text', () => {
    const s = trash(trash(LIBRARY, 'E1', at(1)), 'N1', at(2))
    const back = restore(s, { id: 'N1' }, at(3))
    expect(trashed(back)).toEqual(['E1'])
  })

  it('your case: restoring only the attachment brings its note back too, and nothing else', () => {
    const s = trash(trashFile(trashFile(LIBRARY, 'N1', 'a1', at(0)), 'N1', 'a2', at(1)), 'N1', at(60))
    const plan = restorePlan(s, { id: 'N1', attachmentId: 'a1' })!
    expect(plan.places.map((p) => p.id)).toEqual(['N1'])
    const back = restore(s, { id: 'N1', attachmentId: 'a1' }, at(61))
    expect(trashed(back)).toEqual([])
    expect(fileState(back, 'N1', 'a1')).toBe('live')
    expect(fileState(back, 'N1', 'a2')).toBe('trashed') // its sibling attachment stays where it was
    expect(rows(back)).toEqual(['N1/a2'])
  })

  it('your case, the other way: restoring only the note leaves the earlier deleted attachment in the trash', () => {
    const s = trash(trashFile(LIBRARY, 'N1', 'a1', at(0)), 'N1', at(60))
    const back = restore(s, { id: 'N1' }, at(61))
    expect(trashed(back)).toEqual([])
    expect(fileState(back, 'N1', 'a1')).toBe('trashed')
    const r = trashRows(back)
    expect(r.map((x) => x.key)).toEqual(['N1/a1'])
    expect(r[0]!.placeInTrash).toBe(false)
  })

  it('a note deleted before its folders comes back with the folders, but not their other notes', () => {
    const s = trash(trash(LIBRARY, 'N1', at(1)), 'F1', at(2))
    const plan = restorePlan(s, { id: 'N1' })!
    expect(plan.places.map((p) => p.id)).toEqual(['F1', 'F2'])
    const back = restore(s, { id: 'N1' }, at(3))
    expect(live(back)).toEqual(['D1', 'D1a', 'E1', 'F1', 'F2', 'F3', 'N1', 'N4', 'N5', 'S', 'S2'])
    expect(trashed(back)).toEqual(['N2', 'N3', 'T1'])
    // Each sibling is now its own line, to restore or not.
    expect(rows(back).sort()).toEqual(['N2', 'N3', 'T1'])
  })

  it('a place brought back keeps its own text: a note restored as a place gets its descriptions back', () => {
    const s = trash(trashFile(LIBRARY, 'N1', 'a1', at(1)), 'F2', at(2))
    const back = restore(s, { id: 'N1', attachmentId: 'a1' }, at(3))
    expect(live(back)).toContain('D1')
    expect(live(back)).toContain('D1a')
    expect(live(back)).toContain('E1')
    expect(trashed(back)).toEqual(['N2', 'T1'])
  })

  it('an attachment of a live note comes straight back, no places needed', () => {
    const s = trashFile(LIBRARY, 'N5', 'a5', at(1))
    const plan = restorePlan(s, { id: 'N5', attachmentId: 'a5' })!
    expect(plan).toEqual({ items: [], attachments: [['N5', 'a5']], places: [] })
  })

  it('a whole space comes back whole', () => {
    const back = restore(trash(LIBRARY, 'S', at(1)), { id: 'S' }, at(2))
    expect(trashed(back)).toEqual([])
  })

  it('every pair of deletes: restoring the second brings back only it, its contents and the places above it', () => {
    for (const y of VISIBLE) {
      for (const x of VISIBLE) {
        if (x === y) continue
        const s1 = trash(LIBRARY, y, at(1))
        const byY = new Set(trashIds(LIBRARY, y))
        const byX = new Set(trashIds(s1, x))
        const s2 = trash(s1, x, at(2))
        const back = restore(s2, { id: x }, at(3))
        const ups = new Set(ancestorsOf(LIBRARY, x))
        // What x's own line covers: what its delete took, or, if y took x already, x's part of that.
        const mine = byX.size ? byX : new Set(subtree(LIBRARY, x).filter((id) => byY.has(id)))
        for (const id of ALL) {
          const owner = ancestorsOf(LIBRARY, id).find((a) => !isHidden(LIBRARY[a]!))
          const expected =
            (!byY.has(id) && !byX.has(id)) ||
            mine.has(id) ||
            (isHidden(LIBRARY[id]!) ? byY.has(id) && !!owner && ups.has(owner) : ups.has(id))
          expect({ y, x, id, live: !back[id]!.deletedAt }).toEqual({ y, x, id, live: expected })
        }
      }
    }
  })

  it('stamps only what comes back, and changes nothing else about it', () => {
    const s = trash(trash(LIBRARY, 'N2', at(1)), 'F2', at(2))
    const changed = applyRestore(s, restorePlan(s, { id: 'F2' })!, at(3))
    expect(changed.map((i) => i.id).sort()).toEqual(['D1', 'D1a', 'E1', 'F2', 'N1', 'T1'])
    for (const c of changed) {
      expect(c.deletedAt).toBeUndefined()
      expect(c.updatedAt).toBe(at(3))
      expect({ ...c, updatedAt: T0 }).toEqual(LIBRARY[c.id])
    }
  })

  it('a note and its attachment restored together are one change to that note', () => {
    const s = trash(trashFile(LIBRARY, 'N1', 'a1', at(0)), 'N1', at(1))
    const changed = applyRestore(s, restorePlan(s, { id: 'N1', attachmentId: 'a1' })!, at(2))
    expect(changed.filter((i) => i.id === 'N1')).toHaveLength(1)
    expect(changed.find((i) => i.id === 'N1')!.attachments!.every((a) => !a.deletedAt)).toBe(true)
  })

  it('cannot restore what is not in the trash, or what lost its place for good', () => {
    expect(restorePlan(LIBRARY, { id: 'N1' })).toBeNull()
    expect(restorePlan(LIBRARY, { id: 'N1', attachmentId: 'a1' })).toBeNull()
    expect(restorePlan(LIBRARY, { id: 'nope' })).toBeNull()
    const s = purge(trash(trash(LIBRARY, 'N1', at(1)), 'F2', at(2)), { id: 'F2' }, at(3))
    expect(restorePlan(s, { id: 'N1' })).toBeNull()
    const gone = trash(apply(LIBRARY, [item('orphan', 'note', 'missing')]), 'orphan', at(1))
    expect(restorePlan(gone, { id: 'orphan' })).toBeNull()
  })
})

// ---------- deleting for good ----------

describe('delete for good', () => {
  it('by hand takes the item and everything under it, earlier separate deletes inside included', () => {
    const s = trash(trash(LIBRARY, 'N1', at(1)), 'F2', at(2))
    expect(purgePlan(s, { id: 'F2' }).items.sort()).toEqual(['D1', 'D1a', 'E1', 'F2', 'N1', 'N2', 'T1'])
  })

  it('by hand never takes a parent, a sibling, or anything live', () => {
    const s = trash(trash(LIBRARY, 'N2', at(1)), 'N3', at(2))
    const after = purge(s, { id: 'N2' }, at(3))
    expect(ALL.filter((id) => after[id]!.purgedAt)).toEqual(['N2'])
    expect(purgePlan(LIBRARY, { id: 'F1' })).toEqual({ items: [], attachments: [] })
    expect(purgePlan(LIBRARY, { id: 'N1', attachmentId: 'a1' })).toEqual({ items: [], attachments: [] })
  })

  it('an attachment by hand: only that one', () => {
    const s = trashFile(trashFile(LIBRARY, 'N1', 'a1', at(1)), 'N1', 'a2', at(2))
    const after = purge(s, { id: 'N1', attachmentId: 'a1' }, at(3))
    expect([fileState(after, 'N1', 'a1'), fileState(after, 'N1', 'a2')]).toEqual(['purged', 'trashed'])
    expect(after.N1!.purgedAt).toBeUndefined()
  })

  it(`goes by itself ${TRASH_DAYS} days after the delete, not a moment before`, () => {
    const s = trash(LIBRARY, 'F2', at(0))
    const due = Date.parse(at(0)) + TRASH_DAYS * 86_400_000
    expect(expiredPlan(s, due - 1)).toEqual({ items: [], attachments: [] })
    expect(expiredPlan(s, due).items.sort()).toEqual(['D1', 'D1a', 'E1', 'F2', 'N1', 'N2', 'T1'])
  })

  it('each delete keeps its own clock: an earlier one inside goes first, alone', () => {
    const s = trash(trashFile(trash(LIBRARY, 'N1', at(0)), 'T1', 't1', at(10)), 'F2', at(60))
    const day = (n: number) => Date.parse(at(0)) + n * 86_400_000
    expect(expiredPlan(s, day(TRASH_DAYS)).items.sort()).toEqual(['D1', 'D1a', 'E1', 'N1'])
    const tenMinutesLater = expiredPlan(s, day(TRASH_DAYS) + 10 * 60_000)
    expect(tenMinutesLater.items.sort()).toEqual(['D1', 'D1a', 'E1', 'N1'])
    expect(tenMinutesLater.attachments).toEqual([['T1', 't1']])
    expect(expiredPlan(s, day(TRASH_DAYS) + 60 * 60_000).items.sort()).toEqual(['D1', 'D1a', 'E1', 'F2', 'N1', 'N2', 'T1'])
  })

  it('anything still under a tombstone goes too, even if it was live (made on another device meanwhile)', () => {
    const s = purge(trash(LIBRARY, 'F3', at(0)), { id: 'F3' }, at(1))
    const late = apply(s, [item('late', 'note', 'F3'), item('later', 'note', 'late')])
    expect(expiredPlan(late, Date.parse(at(2))).items.sort()).toEqual(['late', 'later'])
  })

  it('emptying the trash takes everything in it and nothing live', () => {
    const s = trash(trashFile(trash(LIBRARY, 'E1', at(0)), 'N5', 'a5', at(1)), 'F3', at(2))
    const plan = expiredPlan(s, Infinity)
    expect(plan.items.sort()).toEqual(['E1', 'F3', 'N4'])
    expect(plan.attachments).toEqual([['N5', 'a5']])
  })

  it('a tombstone keeps its place in the tree and its file addresses, and no text', () => {
    const t = tombstone({ ...LIBRARY.N1!, deletedAt: at(1), pinned: true }, at(2))
    expect(t).toEqual({
      id: 'N1', type: 'note', parentId: 'F2', rank: 'a0', title: '', createdAt: T0, updatedAt: at(2), deletedAt: at(1), purgedAt: at(2),
      attachments: ['a1', 'a2'].map((a) => ({ id: a, name: '', size: 0, type: '', src: `/api/files/u1/${a}.pdf`, addedAt: T0, purgedAt: at(2) })),
    })
    expect(tombstone(LIBRARY.N2!, at(2)).attachments).toBeUndefined()
  })

  it('a tombstone is never restored, trashed again, or deleted again', () => {
    const s = purge(trash(LIBRARY, 'N2', at(1)), { id: 'N2' }, at(2))
    expect(restorePlan(s, { id: 'N2' })).toBeNull()
    expect(trashIds(s, 'N2')).toEqual([])
    expect(applyPurge(s, { items: ['N2'], attachments: [] }, at(3))).toEqual([])
  })
})

// ---------- freeing storage on the server ----------

describe('cleanup: what the server frees', () => {
  const noteText = (...srcs: string[]) => JSON.stringify({ type: 'doc', content: srcs.map((src) => ({ type: 'image', attrs: { src } })) })

  it('frees the files of tombstones and of attachments deleted for good, and the tombstones’ text', () => {
    const s = purge(purge(trash(trashFile(LIBRARY, 'N5', 'a5', at(0)), 'N1', at(1)), { id: 'N1' }, at(2)), { id: 'N5', attachmentId: 'a5' }, at(3))
    const c = cleanup(s, { N1: noteText('/api/files/u1/img1.png'), N2: noteText() })
    expect(c.files.sort()).toEqual(['/api/files/u1/a1.pdf', '/api/files/u1/a2.pdf', '/api/files/u1/a5.pdf', '/api/files/u1/img1.png'])
    expect(c.bodies).toEqual(['N1'])
    expect(c.items.map((i) => i.id).sort()).toEqual(['N1', 'N5'])
    expect(c.items.find((i) => i.id === 'N1')!.attachments).toBeUndefined()
    expect(c.items.find((i) => i.id === 'N5')!.attachments).toEqual([])
  })

  it('keeps a file that something still around points at: an attachment, an image in a live or trashed note', () => {
    const shared = '/api/files/u1/shared.png'
    const s = purge(trash(LIBRARY, 'N1', at(1)), { id: 'N1' }, at(2))
    const s2 = apply(s, [{ ...s.N2!, attachments: [{ ...file('x'), src: '/api/files/u1/a1.pdf' }] }])
    const s3 = trash(s2, 'N4', at(3))
    const c = cleanup(s3, { N1: noteText(shared, '/api/files/u1/only.png'), N4: noteText(shared) })
    expect(c.files.sort()).toEqual(['/api/files/u1/a2.pdf', '/api/files/u1/only.png'])
  })

  it('keeps the files of things that are only in the trash', () => {
    const s = trash(trashFile(LIBRARY, 'N5', 'a5', at(0)), 'N1', at(1))
    expect(cleanup(s, { N1: noteText('/api/files/u1/img.png') })).toEqual({ files: [], bodies: [], items: [] })
  })

  it('keeps files named in a body whose item it cannot find', () => {
    const s = purge(trash(LIBRARY, 'N2', at(1)), { id: 'N2' }, at(2))
    const c = cleanup(s, { N2: noteText('/api/files/u1/z.png'), ghost: noteText('/api/files/u1/z.png') })
    expect(c.files).toEqual([])
  })

  it('finds file addresses in stored text, once each', () => {
    const text = JSON.stringify({ a: '/api/files/u-1/9f1c.png', b: ['/api/files/u-1/9f1c.png', 'see /api/files/u-1/x_y.pdf?name=a'] })
    expect(filesInText(text)).toEqual(['/api/files/u-1/9f1c.png', '/api/files/u-1/x_y.pdf'])
  })
})

describe('liveAttachments', () => {
  it('shows only attachments that are neither in the trash nor deleted for good', () => {
    const s = purge(trashFile(trashFile(LIBRARY, 'N1', 'a1', at(1)), 'N1', 'a2', at(2)), { id: 'N1', attachmentId: 'a2' }, at(3))
    expect(liveAttachments(s.N1!)).toEqual([])
    expect(liveAttachments(LIBRARY.N1!).map((a) => a.id)).toEqual(['a1', 'a2'])
  })
})

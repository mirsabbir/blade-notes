import type { Attachment, Item } from './types'

/**
 * The trash, as pure functions over the item tree, shared by the app and the server.
 *
 * One rule holds it together: everything moved to the trash in one action gets the same
 * `deletedAt`, so "deleted together" means "same moment" and needs no extra field.
 *
 * - Trashing takes the item and everything under it that is not in the trash yet. What was
 *   trashed earlier keeps its own moment, so it stays a separate entry.
 * - Restoring brings back what that one action took, and never a sibling. When a place above
 *   it is in the trash too, that place comes back as well, with its own text (descriptions,
 *   dates), but none of its other contents.
 * - Deleting for good (TRASH_DAYS after trashing, or by hand) takes the item and everything
 *   under it, whatever their state: with the place gone they have nowhere to return to. A
 *   tombstone (`purgedAt`) is left so every device drops its copy; the server then frees the
 *   text and the files nothing else uses.
 *
 * Attachments live inside their item. Trashing an item leaves its attachments alone (they go
 * and come back with it); an attachment trashed on its own carries its own `deletedAt`.
 */

export const TRASH_DAYS = 30
const DAY_MS = 86_400_000

export type Items = { readonly [id: string]: Item }
/** An item, or one attachment of it. */
export interface Target {
  id: string
  attachmentId?: string
}

/** Descriptions and dates are part of their note's text: never a trash entry of their own. */
export const isHidden = (it: Item): boolean => it.type === 'description' || it.type === 'event'
/** The attachments that show: not in the trash, not deleted for good. */
export const liveAttachments = (it: Item): Attachment[] => (it.attachments ?? []).filter((a) => !a.deletedAt && !a.purgedAt)
export const expiresAt = (deletedAt: string): string => new Date(Date.parse(deletedAt) + TRASH_DAYS * DAY_MS).toISOString()

type Kids = Map<string, Item[]>
function kidsOf(items: Items): Kids {
  const kids: Kids = new Map()
  for (const it of Object.values(items)) {
    if (!it.parentId) continue
    const list = kids.get(it.parentId)
    if (list) list.push(it)
    else kids.set(it.parentId, [it])
  }
  return kids
}

/** The places above `it`, nearest first. `broken`: a parent is missing, or the chain loops. */
function ancestors(items: Items, it: Item): { chain: Item[]; broken: boolean } {
  const chain: Item[] = []
  const seen = new Set([it.id])
  let cur = it
  while (cur.parentId) {
    const p = items[cur.parentId]
    if (!p || seen.has(p.id)) return { chain, broken: true }
    seen.add(p.id)
    chain.push(p)
    cur = p
  }
  return { chain, broken: false }
}

/** `start` and everything under it that `keep` lets through, walking only through kept items. */
function walk(kids: Kids, start: Item, keep: (child: Item) => boolean): Item[] {
  const out: Item[] = []
  const seen = new Set<string>()
  const go = (x: Item) => {
    if (seen.has(x.id)) return
    seen.add(x.id)
    out.push(x)
    for (const c of kids.get(x.id) ?? []) if (keep(c)) go(c)
  }
  go(start)
  return out
}

/** What one trash action takes: the item and everything under it not in the trash yet. */
export function trashIds(items: Items, id: string): string[] {
  const it = items[id]
  if (!it || it.deletedAt) return []
  return walk(kidsOf(items), it, (c) => !c.deletedAt).map((x) => x.id)
}

/** The items trashed in the same action as `start`, under it (`hiddenOnly`: only its own text). */
function together(kids: Kids, start: Item, hiddenOnly: boolean): Item[] {
  return walk(kids, start, (c) => c.deletedAt === start.deletedAt && !c.purgedAt && (!hiddenOnly || isHidden(c)))
}

/** The item a trash action started from, for any item that action took. */
export function batchRoot(items: Items, id: string): Item | undefined {
  let cur = items[id]
  const seen = new Set<string>()
  while (cur?.deletedAt && cur.parentId && !seen.has(cur.id)) {
    seen.add(cur.id)
    const p = items[cur.parentId]
    if (!p || p.deletedAt !== cur.deletedAt) break
    cur = p
  }
  return cur
}

/** One line in the trash. */
export interface TrashRow {
  key: string
  target: Target
  /** The trashed item, or the item the trashed attachment belongs to. */
  item: Item
  attachment?: Attachment
  deletedAt: string
  expiresAt: string
  /** Notes, tasks and folders trashed with it, under it. */
  inside: number
  /** Where it was, top first: a space, folders, and for an attachment the note or task it was on. */
  place: Item[]
  /** That place is in the trash too: restoring brings it back as well. */
  placeInTrash: boolean
}

/** Everything the trash shows, newest first. */
export function trashRows(items: Items): TrashRow[] {
  const kids = kidsOf(items)
  const rows: TrashRow[] = []
  for (const it of Object.values(items)) {
    if (it.purgedAt) continue
    const { chain, broken } = ancestors(items, it)
    if (broken || chain.some((a) => a.purgedAt)) continue
    const placeInTrash = chain.some((a) => a.deletedAt)
    const place = chain.filter((a) => !isHidden(a)).reverse()
    if (it.deletedAt && !isHidden(it) && batchRoot(items, it.id) === it) {
      const inside = together(kids, it, false).filter((x) => x !== it && !isHidden(x)).length
      rows.push({ key: it.id, target: { id: it.id }, item: it, deletedAt: it.deletedAt, expiresAt: expiresAt(it.deletedAt), inside, place, placeInTrash })
    }
    // An attachment of a description or date that left the text goes with it, unseen.
    const root = it.deletedAt ? batchRoot(items, it.id) : undefined
    if (root && isHidden(root)) continue
    for (const a of it.attachments ?? []) {
      if (!a.deletedAt || a.purgedAt) continue
      rows.push({
        key: `${it.id}/${a.id}`,
        target: { id: it.id, attachmentId: a.id },
        item: it,
        attachment: a,
        deletedAt: a.deletedAt,
        expiresAt: expiresAt(a.deletedAt),
        inside: 0,
        place: isHidden(it) ? place : [...place, it],
        placeInTrash: placeInTrash || !!it.deletedAt,
      })
    }
  }
  return rows.sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : a.deletedAt > b.deletedAt ? -1 : a.key < b.key ? -1 : 1))
}

export interface RestorePlan {
  /** Items to take out of the trash. */
  items: string[]
  /** Attachments to take out of the trash: [item id, attachment id]. */
  attachments: [string, string][]
  /** Places in the trash that come back too, top first: say so before restoring. */
  places: Item[]
}

/**
 * What restoring `target` brings back, or null when it cannot come back (it is not in the
 * trash, or the place it was in is gone for good).
 */
export function restorePlan(items: Items, target: Target): RestorePlan | null {
  const it = items[target.id]
  if (!it || it.purgedAt) return null
  const kids = kidsOf(items)
  const ids = new Set<string>()
  const attachments: [string, string][] = []
  // The places to check start at the item itself for an attachment, at its parent otherwise.
  let first: Item | undefined
  if (target.attachmentId) {
    const a = it.attachments?.find((x) => x.id === target.attachmentId)
    if (!a?.deletedAt || a.purgedAt) return null
    attachments.push([it.id, a.id])
    first = it
  } else {
    if (!it.deletedAt) return null
    together(kids, it, false).forEach((x) => ids.add(x.id))
    first = it.parentId ? items[it.parentId] : undefined
    if (it.parentId && !first) return null
  }
  const places: Item[] = []
  if (first) {
    const { chain, broken } = ancestors(items, first)
    if (broken) return null
    for (const p of [first, ...chain]) {
      if (p.purgedAt) return null
      if (!p.deletedAt) continue
      together(kids, p, true).forEach((x) => ids.add(x.id))
      if (!isHidden(p)) places.push(p)
    }
  }
  return { items: [...ids], attachments, places: places.reverse() }
}

export interface PurgePlan {
  /** Items to delete for good, each becoming a tombstone. */
  items: string[]
  /** Attachments to delete for good: [item id, attachment id]. */
  attachments: [string, string][]
}

/** Deleting `target` for good, by hand. Only something in the trash can go. */
export function purgePlan(items: Items, target: Target): PurgePlan {
  const it = items[target.id]
  if (!it || it.purgedAt) return { items: [], attachments: [] }
  if (target.attachmentId) {
    const a = it.attachments?.find((x) => x.id === target.attachmentId)
    return a?.deletedAt && !a.purgedAt ? { items: [], attachments: [[it.id, a.id]] } : { items: [], attachments: [] }
  }
  if (!it.deletedAt) return { items: [], attachments: [] }
  return { items: walk(kidsOf(items), it, (c) => !c.purgedAt).map((x) => x.id), attachments: [] }
}

/**
 * What is due to go for good at `now`: everything trashed TRASH_DAYS ago or more, with
 * everything under it, and whatever still sits under a tombstone. `now = Infinity` empties the trash.
 */
export function expiredPlan(items: Items, now: number): PurgePlan {
  const kids = kidsOf(items)
  const due = (deletedAt: string) => Date.parse(deletedAt) + TRASH_DAYS * DAY_MS <= now
  const ids = new Set<string>()
  for (const it of Object.values(items)) {
    if (it.purgedAt || ids.has(it.id)) continue
    const { chain } = ancestors(items, it)
    if ((it.deletedAt && due(it.deletedAt)) || chain.some((a) => a.purgedAt)) walk(kids, it, (c) => !c.purgedAt).forEach((x) => ids.add(x.id))
  }
  const attachments: [string, string][] = []
  for (const it of Object.values(items)) {
    if (it.purgedAt || ids.has(it.id)) continue
    for (const a of it.attachments ?? []) if (a.deletedAt && !a.purgedAt && due(a.deletedAt)) attachments.push([it.id, a.id])
  }
  return { items: [...ids], attachments }
}

/** The items changed by taking `plan` out of the trash at `at`. */
export function applyRestore(items: Items, plan: RestorePlan, at: string): Item[] {
  const out = new Map<string, Item>()
  for (const id of plan.items) {
    const it = items[id]
    if (!it) continue
    const { deletedAt: _, ...rest } = it
    out.set(id, { ...rest, updatedAt: at })
  }
  for (const [id, attachmentId] of plan.attachments) {
    const it = out.get(id) ?? items[id]
    if (!it) continue
    const attachments = (it.attachments ?? []).map((a) => {
      if (a.id !== attachmentId) return a
      const { deletedAt: _, ...rest } = a
      return rest
    })
    out.set(id, { ...it, attachments, updatedAt: at })
  }
  return [...out.values()]
}

/** What is left of an item deleted for good: its place in the tree and its file addresses, no text. */
export function tombstone(it: Item, at: string): Item {
  return {
    id: it.id,
    type: it.type,
    parentId: it.parentId,
    rank: it.rank,
    title: '',
    createdAt: it.createdAt,
    updatedAt: at,
    deletedAt: it.deletedAt ?? at,
    purgedAt: at,
    // Kept until the server has freed the files (cleanup), then dropped.
    ...(it.attachments?.length
      ? { attachments: it.attachments.map((a) => ({ id: a.id, name: '', size: 0, type: '', src: a.src, addedAt: a.addedAt, purgedAt: a.purgedAt ?? at })) }
      : {}),
  }
}

/** The items changed by deleting `plan` for good at `at`. */
export function applyPurge(items: Items, plan: PurgePlan, at: string): Item[] {
  const out = new Map<string, Item>()
  for (const id of plan.items) {
    const it = items[id]
    if (it && !it.purgedAt) out.set(id, tombstone(it, at))
  }
  for (const [id, attachmentId] of plan.attachments) {
    const it = out.get(id) ?? items[id]
    if (!it || it.purgedAt) continue
    const attachments = (it.attachments ?? []).map((a) => (a.id === attachmentId ? { ...a, purgedAt: at } : a))
    out.set(id, { ...it, attachments, updatedAt: at })
  }
  return [...out.values()]
}

/** File addresses (`/api/files/<owner>/<name>`) in a body's stored text: images in notes are files too. */
export function filesInText(text: string): string[] {
  return [...new Set(text.match(/\/api\/files\/[\w-]+\/[\w.-]+/g) ?? [])]
}

export interface Cleanup {
  /** Files nothing points at any more. */
  files: string[]
  /** Bodies of tombstones. */
  bodies: string[]
  /** Items to store again without what was kept only for this step. */
  items: Item[]
}

/**
 * What the server can free once things are deleted for good. `bodies` holds each body's
 * stored text. A file goes only when no item still around (live or in the trash) points at
 * it, in an attachment or inside any text.
 */
export function cleanup(items: Items, bodies: { readonly [id: string]: string }): Cleanup {
  const gone = new Set<string>()
  const used = new Set<string>()
  for (const it of Object.values(items)) for (const a of it.attachments ?? []) (it.purgedAt || a.purgedAt ? gone : used).add(a.src)
  // A body whose item is missing still counts as in use: never free a file on a guess.
  for (const [id, text] of Object.entries(bodies)) for (const src of filesInText(text)) (items[id]?.purgedAt ? gone : used).add(src)
  const compacted: Item[] = []
  for (const it of Object.values(items)) {
    if (it.purgedAt && it.attachments) {
      const { attachments: _, ...rest } = it
      compacted.push(rest)
    } else if (it.attachments?.some((a) => a.purgedAt)) {
      compacted.push({ ...it, attachments: it.attachments.filter((a) => !a.purgedAt) })
    }
  }
  return {
    files: [...gone].filter((src) => !used.has(src)),
    bodies: Object.keys(bodies).filter((id) => items[id]?.purgedAt),
    items: compacted,
  }
}

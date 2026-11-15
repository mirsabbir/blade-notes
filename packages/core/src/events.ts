import type { Item } from './types'

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
 * The events of `ownerId` that change now that its text is `doc`: a deleted chip trashes its
 * event, an undo brings it back, and an event follows its line's text unless its title was
 * typed by hand. Shared by the app's editor and the agent server.
 */
export function eventChanges(items: { readonly [id: string]: Item }, ownerId: string, doc: unknown, now: string): Item[] {
  const found = chipsIn(doc)
  const out: Item[] = []
  for (const it of Object.values(items)) {
    if (it.type !== 'event' || it.parentId !== ownerId || it.purgedAt) continue
    const line = found.get(it.id)
    let next: Item | null = null
    if (line === undefined) next = it.deletedAt ? null : { ...it, deletedAt: now }
    else {
      const title = line.slice(0, 200) || 'Untitled'
      if (it.deletedAt || (!it.customTitle && it.title !== title)) next = { ...it, deletedAt: undefined, ...(!it.customTitle && { title }) }
    }
    if (next) out.push({ ...next, updatedAt: now })
  }
  return out
}

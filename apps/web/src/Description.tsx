import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Trash2, X } from 'lucide-react'
import { Editor } from './Editor'
import { Attachments, DropZone } from './Attachments'
import { createDescription, settingsOf, trash, update, useStore } from './store'
import type { DescribeHooks } from './describe'

/** One open description; `remove` takes its mark or list-item link out of the document it came from. */
export interface OpenDescription {
  id: string
  rect: DOMRect
  remove: () => void
}

/**
 * The description of a list item or phrase, opened the way Settings › Descriptions says:
 * a blade on the right (default), a window over the note, or a popup at the text.
 * A described phrase inside a description opens on top; the back arrow returns.
 */
export function Description({ stack, onChange }: { stack: OpenDescription[]; onChange: (next: OpenDescription[]) => void }) {
  const { state } = useStore()
  const view = settingsOf(state).descriptionView
  const top = stack.at(-1)!
  const item = state.items[top.id]
  const owner = item?.parentId ? state.items[item.parentId] : undefined
  const box = useRef<HTMLDivElement>(null)
  const [uploading, setUploading] = useState<string[]>([])
  const close = () => onChange([])
  const back = () => onChange(stack.slice(0, -1))

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    // A popup closes on a click anywhere else (but not on another description, which replaces it).
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement
      if (view === 'popover' && !box.current?.contains(t) && !t.closest('.desc-btn, .desc-mark, .bubble, .peek')) close()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onDown)
    }
  })

  if (!item || item.deletedAt) return null

  const hooks: DescribeHooks = {
    open: (id, anchor, remove) => onChange([...stack, { id, rect: anchor.getBoundingClientRect(), remove }]),
    create: (title) => createDescription(owner?.id ?? item.id, title),
  }
  const remove = () => {
    if (!confirm(`Remove the description “${item.title}”? The text it belongs to stays.`)) return
    top.remove()
    trash(item.id)
    back()
  }

  const body = (
    <div ref={box} className={`desc desc-${view}`} role={view === 'panel' ? 'complementary' : 'dialog'} aria-label={`Description: ${item.title}`}>
      {/* Marks the open description's icon or phrase in the note. */}
      <style>{`.desc-btn[data-desc="${top.id}"]{background:var(--primary);color:var(--primary-fg)}.desc-mark[data-desc="${top.id}"]{background:var(--accent)}`}</style>
      <header className="desc-head">
        {stack.length > 1 && (
          <button type="button" className="ghost" aria-label="Back to the previous description" onClick={back}>
            <ArrowLeft size={15} aria-hidden />
          </button>
        )}
        <span className="desc-crumb">{owner ? `${owner.title} › Description` : 'Description'}</span>
        <button type="button" className="ghost" aria-label="Remove this description" title="Remove description" onClick={remove}>
          <Trash2 size={15} aria-hidden />
        </button>
        <button type="button" className="ghost" aria-label="Close description" onClick={close}>
          <X size={16} aria-hidden />
        </button>
      </header>
      <DropZone item={item} onUploading={setUploading}>
        <div className="desc-scroll">
          <input
            key={item.id}
            className="desc-title"
            defaultValue={item.title}
            aria-label="Description title"
            onBlur={(e) => {
              const v = e.target.value.trim()
              if (v && v !== item.title) update(item.id, { title: v })
              else e.target.value = item.title
            }}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
          <Editor key={item.id} id={item.id} doc={state.bodies[item.id]?.doc} placeholder="Write the details: steps, links, a checklist." describe={hooks} />
          <Attachments item={item} uploading={uploading} onUploading={setUploading} />
        </div>
      </DropZone>
    </div>
  )

  if (view === 'modal')
    return (
      <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
        {body}
      </div>
    )
  if (view === 'popover') {
    const r = stack[0]!.rect
    const width = Math.min(460, window.innerWidth - 16)
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8))
    const below = r.bottom + 8 + 420 < window.innerHeight
    return (
      <div className="desc-pop-anchor" style={{ left, width, ...(below ? { top: r.bottom + 8 } : { bottom: window.innerHeight - r.top + 8 }) }}>
        {body}
      </div>
    )
  }
  return body
}

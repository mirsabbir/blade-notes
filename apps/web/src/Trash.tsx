import { CircleCheck, FileText, Folder, PanelLeftClose, Paperclip, RotateCcw, Trash2, X } from 'lucide-react'
import { dayDiff, isHidden, localDay, purgePlan, restorePlan, TRASH_DAYS, trashRows, ymd, type TrashRow } from '@blade-notes/core'
import { deleteForever, restore, useStore } from './store'

/** The trash, opened from the Library: one line per delete, newest first (rules: core trash.ts). */
export function TrashBlade({ onFold }: { onFold: () => void }) {
  const { state } = useStore()
  const rows = trashRows(state.items)
  return (
    <section className="blade agenda" aria-label="Trash">
      <div className="blade-head">
        <Trash2 size={16} aria-hidden className="ico" />
        <div className="blade-titles">
          <h2>Trash</h2>
          <p>{rows.length ? `${rows.length} in the trash` : 'Empty'} · kept {TRASH_DAYS} days</p>
        </div>
        <button type="button" className="ghost" onClick={onFold} aria-label="Close the Trash" title="Close the Trash">
          <PanelLeftClose size={16} aria-hidden />
        </button>
      </div>
      <div className="blade-body">
        {rows.length === 0 && <p className="empty">Deleted notes, tasks, folders and attachments wait here for {TRASH_DAYS} days, then they are deleted for good.</p>}
        {rows.map((r) => (
          <TrashLine key={r.key} row={r} />
        ))}
      </div>
      {rows.length > 0 && (
        <div className="ag-foot trash-foot">
          <span>Deleted for good {TRASH_DAYS} days after deleting.</span>
          <button
            type="button"
            className="btn small-btn warn-text"
            onClick={() => confirm(`Delete everything in the trash for good (${rows.length})? This cannot be undone.`) && deleteForever()}
          >
            Empty trash
          </button>
        </div>
      )}
    </section>
  )
}

function TrashLine({ row }: { row: TrashRow }) {
  const { state } = useStore()
  const { item, attachment } = row
  const name = attachment?.name ?? (item.title || 'Untitled')
  const left = Math.max(0, dayDiff(localDay(row.expiresAt), ymd(new Date())))
  const where = row.place.map((p) => p.title || 'Untitled').join(' › ')
  const trashedPlace = [...row.place].reverse().find((p) => p.deletedAt)

  const onRestore = () => {
    const plan = restorePlan(state.items, row.target)
    if (!plan) return alert(`“${name}” cannot come back: the place it was in is deleted for good.`)
    const places = plan.places.map((p) => `“${p.title || 'Untitled'}”`).join(' › ')
    const also = plan.places.length === 1 ? 'it is in the trash too. Restore it' : 'they are in the trash too. Restore them'
    if (plan.places.length && !confirm(`“${name}” was in ${places}, and ${also} as well? Nothing else that was in there comes back.`)) return
    restore(row.target)
  }
  const onDelete = () => {
    const more = purgePlan(state.items, row.target).items.filter((id) => id !== item.id && state.items[id] && !isHidden(state.items[id]!)).length
    const what = more ? `“${name}” and everything in it (${more} more)` : `“${name}”`
    if (confirm(`Delete ${what} for good? This cannot be undone.`)) deleteForever(row.target)
  }

  return (
    <div className="row trash-line">
      <span className="trash-ico" aria-hidden>
        {attachment ? (
          <Paperclip size={16} />
        ) : item.type === 'space' ? (
          <span className="dot" style={{ background: item.color ?? 'var(--primary)' }} />
        ) : item.type === 'folder' ? (
          <Folder size={16} />
        ) : item.type === 'task' ? (
          <CircleCheck size={16} />
        ) : (
          <FileText size={16} />
        )}
      </span>
      <span className="name">
        {name}
        <small>
          {where ? `In ${where}` : 'A space'}
          {row.inside ? ` · with ${row.inside} inside` : ''}
        </small>
        <small className={left <= 3 ? 'trash-left soon' : 'trash-left'}>
          {left === 0 ? 'Deleted for good today' : `${left} day${left === 1 ? '' : 's'} left`}
          {trashedPlace ? ` · “${trashedPlace.title || 'Untitled'}” is in the trash too` : ''}
        </small>
      </span>
      <button type="button" className="ghost" onClick={onRestore} aria-label={`Restore ${name}`} title="Restore">
        <RotateCcw size={15} aria-hidden />
      </button>
      <button type="button" className="ghost" onClick={onDelete} aria-label={`Delete ${name} for good`} title="Delete for good">
        <X size={15} aria-hidden />
      </button>
    </div>
  )
}

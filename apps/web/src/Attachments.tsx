import { useRef, useState, type DragEvent, type ReactNode } from 'react'
import { File, FileArchive, FileImage, FileSpreadsheet, FileText, Paperclip, X, Download, Loader2 } from 'lucide-react'
import type { Attachment, Item } from '@blade-notes/core'
import { attach, detach, MAX_FILE_MB } from './store'

function sizeLabel(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function iconFor(a: Attachment) {
  const t = a.type
  if (t.startsWith('image/')) return FileImage
  if (/zip|rar|7z|tar|gzip/.test(t)) return FileArchive
  if (/sheet|excel|csv/.test(t)) return FileSpreadsheet
  if (/pdf|word|text|document/.test(t)) return FileText
  return File
}

/** The attachments list plus an "Attach files" button. Files can also be dropped on `DropZone`. */
export function Attachments({ item, uploading, onUploading }: { item: Item; uploading: string[]; onUploading: (names: string[]) => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [error, setError] = useState('')
  const list = item.attachments ?? []
  const pick = async (files: File[]) => {
    setError('')
    onUploading(files.map((f) => f.name))
    try {
      await attach(item.id, files)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      onUploading([])
    }
  }
  return (
    <div className="attachments">
      <div className="attachments-head">
        <span className="label-inline">Attachments{list.length ? ` · ${list.length}` : ''}</span>
        <button type="button" className="btn small-btn" onClick={() => input.current?.click()}>
          <Paperclip size={14} aria-hidden /> Attach files
        </button>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])]
            e.target.value = ''
            if (files.length) void pick(files)
          }}
        />
      </div>
      {list.length === 0 && uploading.length === 0 && <p className="muted small">Drop files here or use Attach files. Up to {MAX_FILE_MB} MB each.</p>}
      <ul className="file-list">
        {list.map((a) => {
          const Icon = iconFor(a)
          return (
            <li key={a.id} className="file">
              <Icon size={18} aria-hidden className="file-ico" />
              <a className="file-name" href={`${a.src}?name=${encodeURIComponent(a.name)}`} title={`Download ${a.name}`}>
                {a.name}
              </a>
              <span className="file-size">{sizeLabel(a.size)}</span>
              <a className="ghost" href={`${a.src}?name=${encodeURIComponent(a.name)}`} aria-label={`Download ${a.name}`}>
                <Download size={15} aria-hidden />
              </a>
              <button type="button" className="ghost" aria-label={`Remove ${a.name}`} onClick={() => detach(item.id, a.id)}>
                <X size={15} aria-hidden />
              </button>
            </li>
          )
        })}
        {uploading.map((name) => (
          <li key={name} className="file uploading">
            <Loader2 size={18} aria-hidden className="spin" />
            <span className="file-name">{name}</span>
            <span className="file-size">Uploading…</span>
          </li>
        ))}
      </ul>
      {error && <p className="update-error">{error}</p>}
    </div>
  )
}

/** Wraps the editor pane: dropping files anywhere on it attaches them to the open item. */
export function DropZone({ item, children, onUploading }: { item: Item; children: ReactNode; onUploading: (names: string[]) => void }) {
  const [over, setOver] = useState(false)
  const hasFiles = (e: DragEvent) => [...e.dataTransfer.types].includes('Files')
  return (
    <div
      className={over ? 'dropzone over' : 'dropzone'}
      onDragOver={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setOver(false)
      }}
      onDrop={async (e) => {
        if (!hasFiles(e)) return
        // Dropping onto the text itself is the editor's job (images go inline there).
        if ((e.target as HTMLElement).closest('.ProseMirror')) return setOver(false)
        e.preventDefault()
        setOver(false)
        const files = [...e.dataTransfer.files]
        onUploading(files.map((f) => f.name))
        try {
          await attach(item.id, files)
        } catch (err) {
          alert((err as Error).message)
        } finally {
          onUploading([])
        }
      }}
    >
      {children}
      {over && <div className="drop-hint">Drop to attach to “{item.title}”</div>}
    </div>
  )
}

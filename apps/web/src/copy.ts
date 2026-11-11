import { generateHTML } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { TaskList } from '@tiptap/extension-task-list'
import { TaskItem } from '@tiptap/extension-task-item'
import Highlight from '@tiptap/extension-highlight'
import Image from '@tiptap/extension-image'
import { TableKit } from '@tiptap/extension-table'
import type { Item } from '@blade-notes/core'
import { fullDay, plainLabel } from './dates'
import { DescribeMark, Describe } from './describe'
import { DateChip } from './schedule'
import { Secret } from './secret'
import { currentState, docText } from './store'
import { copyToClipboard } from './clipboard'

/**
 * The Copy button: a whole note or task as rich text (for Gmail, Docs, Slack) and as Markdown
 * (for everything else), both on the clipboard at once. Dates are written out, hidden
 * descriptions come along as quotes, secrets stay dots, attachments are listed by name.
 */
type N = { type: string; text?: string; attrs?: { [k: string]: unknown }; marks?: { type: string; attrs?: { [k: string]: unknown } }[]; content?: N[] }

const STATUS = { todo: 'To do', doing: 'In progress', done: 'Done' } as const
const PRIORITY = { none: '', low: 'Low', medium: 'Medium', high: 'High' } as const

const extensions = [
  StarterKit,
  TaskList,
  TaskItem.configure({ nested: true }),
  Highlight,
  Image,
  TableKit,
  DescribeMark,
  Describe,
  DateChip,
  Secret,
]

function meta(item: Item): string[] {
  const { items } = currentState()
  const path: string[] = []
  for (let cur = item.parentId ? items[item.parentId] : undefined; cur; cur = cur.parentId ? items[cur.parentId] : undefined) path.unshift(cur.title)
  const facts = item.type === 'task'
    ? [`Status: ${STATUS[item.status ?? 'todo']}`, item.due && `Due: ${fullDay(item.due.slice(0, 10))}`, item.priority && PRIORITY[item.priority] && `Priority: ${PRIORITY[item.priority]}`]
    : []
  return [path.join(' › '), ...facts].filter(Boolean) as string[]
}

const descText = (id: unknown) => {
  const { items, bodies } = currentState()
  const d = typeof id === 'string' ? items[id] : undefined
  return d && !d.deletedAt ? docText(bodies[d.id]?.doc) || d.title : ''
}

function inline(nodes: N[] = []): string {
  return nodes
    .map((n) => {
      if (n.type === 'dateChip') return plainLabel(currentState().items[n.attrs?.id as string]?.at ?? (n.attrs?.at as string))
      if (n.type === 'secret') return '••••••'
      if (n.type === 'hardBreak') return '  \n'
      if (n.type === 'image') return `[image: ${(n.attrs?.alt as string) || 'picture'}]`
      let t = n.text ?? ''
      for (const m of n.marks ?? []) {
        if (m.type === 'bold') t = `**${t}**`
        else if (m.type === 'italic') t = `_${t}_`
        else if (m.type === 'strike') t = `~~${t}~~`
        else if (m.type === 'code') t = `\`${t}\``
        else if (m.type === 'link') t = `[${t}](${m.attrs?.href as string})`
      }
      return t
    })
    .join('')
}

/** Descriptions behind phrases in these inline nodes, as quote lines. */
const phraseNotes = (nodes: N[] = [], pad: string) =>
  [...new Set(nodes.flatMap((n) => (n.marks ?? []).filter((m) => m.type === 'describe').map((m) => m.attrs?.descId)))]
    .map(descText)
    .filter(Boolean)
    .map((t) => `${pad}> ${t}`)

function block(n: N, pad: string, out: string[]): void {
  const kids = n.content ?? []
  switch (n.type) {
    case 'paragraph':
      out.push(pad + inline(kids), ...phraseNotes(kids, pad))
      return
    case 'heading':
      out.push(`${pad}${'#'.repeat(Number(n.attrs?.level ?? 1))} ${inline(kids)}`)
      return
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      kids.forEach((li, i) => listItem(li, n.type === 'orderedList' ? `${i + 1}. ` : n.type === 'taskList' ? `- [${li.attrs?.checked ? 'x' : ' '}] ` : '- ', pad, out))
      return
    case 'blockquote': {
      const inner: string[] = []
      kids.forEach((k) => block(k, '', inner))
      inner.forEach((l) => out.push(`${pad}> ${l}`))
      return
    }
    case 'codeBlock':
      out.push(`${pad}\`\`\`${(n.attrs?.language as string) ?? ''}`, ...inline(kids).split('\n').map((l) => pad + l), `${pad}\`\`\``)
      return
    case 'horizontalRule':
      out.push(`${pad}---`)
      return
    case 'image':
      out.push(pad + inline([n]))
      return
    case 'table':
      kids.forEach((row, r) => {
        out.push(`${pad}| ${(row.content ?? []).map((c) => (c.content ?? []).map((p) => inline(p.content)).join(' ')).join(' | ')} |`)
        if (r === 0) out.push(`${pad}|${(row.content ?? []).map(() => ' --- |').join('')}`)
      })
      return
    default:
      kids.forEach((k) => block(k, pad, out))
  }
}

function listItem(li: N, marker: string, pad: string, out: string[]) {
  const [first, ...rest] = li.content ?? []
  out.push(pad + marker + (first?.type === 'paragraph' ? inline(first.content) : ''))
  const inner = `${pad}  `
  const desc = descText(li.attrs?.descId)
  if (desc) out.push(`${inner}> ${desc}`)
  if (first?.type === 'paragraph') out.push(...phraseNotes(first.content, inner))
  else if (first) block(first, inner, out)
  rest.forEach((k) => block(k, inner, out))
}

/** Plain text of copied editor content (a slice's JSON): Markdown, dates in words, secrets as dots. */
export function contentToText(content: N[] = []): string {
  const out: string[] = []
  content.forEach((n) => {
    block(n, '', out)
    out.push('')
  })
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

export function toMarkdown(item: Item, doc: unknown): string {
  const out = [`# ${item.title}`, meta(item).join('  ·  '), '']
  ;((doc as N | undefined)?.content ?? []).forEach((n) => {
    block(n, '', out)
    out.push('')
  })
  if (item.attachments?.length) out.push(`Attachments: ${item.attachments.map((a) => a.name).join(', ')}`)
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function toHtml(item: Item, doc: unknown): string {
  const { items } = currentState()
  const body = doc ? generateHTML(doc as Parameters<typeof generateHTML>[0], extensions) : ''
  const descs = Object.values(items).filter((d) => d.type === 'description' && d.parentId === item.id && !d.deletedAt)
  return [
    `<h1>${esc(item.title)}</h1>`,
    `<p>${esc(meta(item).join(' · '))}</p>`,
    body,
    descs.length ? `<h3>Descriptions</h3><ul>${descs.map((d) => `<li><b>${esc(d.title)}</b>: ${esc(descText(d.id))}</li>`).join('')}</ul>` : '',
    item.attachments?.length ? `<p>Attachments: ${esc(item.attachments.map((a) => a.name).join(', '))}</p>` : '',
  ].join('')
}

/** Puts both versions on the clipboard; the app you paste into takes the one it understands. */
export function copyItem(item: Item): Promise<void> {
  const doc = currentState().bodies[item.id]?.doc
  return copyToClipboard(toMarkdown(item, doc), toHtml(item, doc))
}

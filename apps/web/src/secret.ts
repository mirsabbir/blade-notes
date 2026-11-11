import { Node, mergeAttributes, type Editor, type NodeViewRendererProps } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import type { NodeView } from '@tiptap/pm/view'
import { decryptText, encryptText, hasVault, isUnlocked, onVaultChange } from './vault'
import { copyToClipboard } from './clipboard'

/**
 * Secret blocks: a password or PIN inside a note, stored as vault ciphertext (vault.ts).
 * Shown as dots; Reveal, Copy and Edit ask for the passphrase when the vault is locked.
 * Every copy out of the editor carries dots or ciphertext, never the secret: plain text gets
 * `••••••`, and the HTML keeps the ciphertext so pasting inside Blade Notes keeps the secret.
 */
export interface SecretOptions {
  /** Asks for the passphrase; true once the vault is open. */
  requestUnlock: () => Promise<boolean>
  /** No vault yet: show where to make one. */
  openVaultSettings: () => void
}

const DOTS = '••••••'
const SHOW_MS = 30_000
const LOCK_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>'

export const Secret = Node.create<SecretOptions>({
  name: 'secret',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addOptions: () => ({ requestUnlock: async () => false, openVaultSettings: () => {} }),
  addAttributes: () => ({
    label: { default: 'Secret', parseHTML: (el) => el.getAttribute('data-label') || 'Secret', renderHTML: (a) => ({ 'data-label': a.label }) },
    data: { default: '', parseHTML: (el) => el.getAttribute('data-data') ?? '', renderHTML: (a) => ({ 'data-data': a.data }) },
  }),
  parseHTML: () => [{ tag: 'span[data-secret]' }],
  renderHTML: ({ HTMLAttributes }) => ['span', mergeAttributes(HTMLAttributes, { 'data-secret': '' }), DOTS],
  renderText: () => DOTS,
  addNodeView() {
    return (props) => new SecretView(props, this.options)
  },
})

const optionsOf = (editor: Editor) => editor.extensionManager.extensions.find((e) => e.name === 'secret')!.options as SecretOptions

/** Turns the selected text (one line or less) into a Secret block. */
export async function makeSecret(editor: Editor, label = 'Secret'): Promise<boolean> {
  const { from, to, empty, $from, $to } = editor.state.selection
  if (empty || !$from.sameParent($to)) return false
  const text = editor.state.doc.textBetween(from, to)
  if (!text.trim()) return false
  const options = optionsOf(editor)
  if (!hasVault()) {
    options.openVaultSettings()
    return false
  }
  if (!isUnlocked() && !(await options.requestUnlock())) return false
  const data = await encryptText(text)
  // Asking for the passphrase took time: replace only if the same text is still there.
  if (editor.isDestroyed || editor.state.doc.textBetween(from, to) !== text) return false
  return editor.chain().focus().insertContentAt({ from, to }, { type: 'secret', attrs: { label, data } }).run()
}

/** Copying a secret clears the clipboard 30 s later, unless something else was copied here since. */
let lastCopy = 0
if (typeof document !== 'undefined') document.addEventListener('copy', () => (lastCopy = Date.now()))

function button(label: string, run: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'secret-btn'
  b.textContent = label
  b.addEventListener('mousedown', (e) => e.preventDefault())
  b.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    run()
  })
  return b
}

class SecretView implements NodeView {
  dom: HTMLElement
  private node: PMNode
  private shown: string | null = null
  private editing = false
  private hideTimer: ReturnType<typeof setTimeout> | undefined
  private copyButton: HTMLButtonElement | null = null
  private stop: () => void

  constructor(private props: NodeViewRendererProps, private options: SecretOptions) {
    this.node = props.node
    this.dom = document.createElement('span')
    this.dom.className = 'secret'
    this.dom.contentEditable = 'false'
    this.stop = onVaultChange(() => !isUnlocked() && this.hide())
    this.render()
  }

  private get label(): string {
    return this.node.attrs.label as string
  }

  /** Decrypts after asking for the passphrase when needed; null if the user cancelled or it failed. */
  private async open(): Promise<string | null> {
    if (!isUnlocked() && !(await this.options.requestUnlock())) return null
    try {
      return await decryptText(this.node.attrs.data as string)
    } catch (err) {
      this.dom.title = (err as Error).message
      return null
    }
  }

  private render() {
    this.dom.classList.toggle('revealed', this.shown !== null)
    this.dom.setAttribute('aria-label', `Secret: ${this.label}`)
    const ico = document.createElement('span')
    ico.className = 'secret-ico'
    ico.innerHTML = LOCK_SVG
    this.dom.replaceChildren(ico)
    if (this.editing) return
    const name = document.createElement('span')
    name.className = 'secret-label'
    name.textContent = this.label
    const value = document.createElement('span')
    value.className = 'secret-value'
    value.textContent = this.shown ?? DOTS
    this.copyButton = button('Copy', () => void this.copy())
    this.dom.append(
      name,
      value,
      button(this.shown === null ? 'Reveal' : 'Hide', () => void (this.shown === null ? this.reveal() : this.hide())),
      this.copyButton,
      button('Edit', () => void this.edit()),
    )
  }

  private async reveal() {
    const text = await this.open()
    if (text === null) return
    this.shown = text
    clearTimeout(this.hideTimer)
    this.hideTimer = setTimeout(() => this.hide(), SHOW_MS)
    this.render()
  }

  private hide() {
    clearTimeout(this.hideTimer)
    if (this.shown === null) return
    this.shown = null
    if (!this.editing) this.render()
  }

  private async copy() {
    const text = await this.open()
    if (text === null) return
    try {
      await copyToClipboard(text)
      const copiedAt = Date.now()
      lastCopy = copiedAt
      setTimeout(() => lastCopy === copiedAt && void navigator.clipboard.writeText('').catch(() => {}), SHOW_MS)
      this.flash('Copied · clears in 30 s')
    } catch {
      this.flash('Could not copy: press Copy again')
    }
  }

  private flash(message: string) {
    const b = this.copyButton
    if (!b) return
    b.textContent = message
    setTimeout(() => (b.textContent = 'Copy'), 2000)
  }

  /** Label and text side by side; Enter or leaving the fields saves, Esc cancels. */
  private async edit() {
    const text = await this.open()
    if (text === null) return
    this.editing = true
    this.render()
    const form = document.createElement('span')
    form.className = 'secret-edit'
    const field = (value: string, aria: string, width: number) => {
      const i = document.createElement('input')
      i.value = value
      i.setAttribute('aria-label', aria)
      i.autocomplete = 'off'
      i.spellcheck = false
      i.size = width
      return i
    }
    const name = field(this.label, 'Name of the secret', 10)
    const value = field(text, 'Secret text', 18)
    let done = false
    const finish = async (save: boolean) => {
      if (done) return
      done = true
      if (save) await this.save(name.value.trim() || 'Secret', value.value)
      this.editing = false
      this.shown = null
      this.render()
    }
    form.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void finish(true)
      if (e.key === 'Escape') void finish(false)
    })
    form.addEventListener('focusout', (e) => !form.contains(e.relatedTarget as globalThis.Node | null) && void finish(true))
    form.append(name, value)
    this.dom.append(form)
    value.focus()
    value.select()
  }

  private async save(label: string, text: string) {
    const { editor, getPos } = this.props
    const pos = typeof getPos === 'function' ? getPos() : undefined
    if (pos === undefined || editor.isDestroyed || !text) return
    const data = text === (await decryptText(this.node.attrs.data as string).catch(() => null)) ? (this.node.attrs.data as string) : await encryptText(text)
    if (label === this.label && data === this.node.attrs.data) return
    editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { label, data }))
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false
    if (node.attrs.data !== this.node.attrs.data) this.shown = null
    this.node = node
    if (!this.editing) this.render()
    return true
  }

  /** Clicks and typing inside the block belong to its buttons and fields, not to the editor. */
  stopEvent(event: Event): boolean {
    return (event.target as HTMLElement).closest?.('button, input') !== null
  }

  ignoreMutation(): boolean {
    return true
  }

  destroy() {
    clearTimeout(this.hideTimer)
    this.stop()
  }
}

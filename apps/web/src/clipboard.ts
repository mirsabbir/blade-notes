/**
 * Puts text, and HTML when given, on the clipboard. First through the copy event, which needs
 * no permission (embedded web views, the desktop apps' among them, often deny the Clipboard
 * API), then through the Clipboard API. Call it from a click: both need a recent user action.
 */
export async function copyToClipboard(text: string, html?: string): Promise<void> {
  let done = false
  const onCopy = (e: ClipboardEvent) => {
    if (!e.clipboardData) return
    e.clipboardData.setData('text/plain', text) // runs after the editor's own copy handler, so this wins
    if (html) e.clipboardData.setData('text/html', html)
    e.preventDefault()
    done = true
  }
  document.addEventListener('copy', onCopy)
  try {
    document.execCommand('copy')
  } catch {
    // no copy command here: the Clipboard API below
  } finally {
    document.removeEventListener('copy', onCopy)
  }
  if (done) return
  if (html && typeof ClipboardItem !== 'undefined') {
    const blob = (s: string, type: string) => new Blob([s], { type })
    try {
      return await navigator.clipboard.write([new ClipboardItem({ 'text/html': blob(html, 'text/html'), 'text/plain': blob(text, 'text/plain') })])
    } catch {
      // rich copy refused: plain text below
    }
  }
  await navigator.clipboard.writeText(text)
}

/**
 * Talks to the desktop app around the page, when there is one (same transport as AnyMeet):
 * - macOS WKWebView: postMessage returns a promise (WKScriptMessageHandlerWithReply).
 * - Windows WebView2: messages carry an id; the app answers with the same id.
 * In a plain browser `isDesktop` is false and nothing here is used.
 */
export interface UpdateInfo {
  current: string
  latest?: string
  available: boolean
  error?: string
}
interface Api {
  appInfo: { params: object; result: { platform: 'macos' | 'windows'; version: string } }
  checkForUpdate: { params: { force?: boolean }; result: UpdateInfo }
  installUpdate: { params: object; result: null }
}

interface Webkit { messageHandlers: { bridge?: { postMessage(m: unknown): Promise<unknown> } } }
interface WebView2 { postMessage(m: unknown): void; addEventListener(t: 'message', cb: (e: { data: unknown }) => void): void }
const w = window as unknown as { webkit?: Webkit; chrome?: { webview?: WebView2 }; __hostEvent?: (e: string) => void }

export const isDesktop = Boolean(w.webkit?.messageHandlers?.bridge || w.chrome?.webview)

const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
let nextId = 1
w.chrome?.webview?.addEventListener('message', ({ data }) => {
  const msg = data as { id?: number; result?: unknown; error?: string }
  const p = msg.id === undefined ? undefined : pending.get(msg.id)
  if (!p) return
  pending.delete(msg.id!)
  if (msg.error) p.reject(new Error(msg.error))
  else p.resolve(msg.result)
})

export function call<M extends keyof Api>(method: M, params: Api[M]['params'] = {}): Promise<Api[M]['result']> {
  const bridge = w.webkit?.messageHandlers?.bridge
  if (bridge) return bridge.postMessage({ method, params }) as Promise<Api[M]['result']>
  const webview = w.chrome?.webview
  if (!webview) return Promise.reject(new Error('not running in the desktop app'))
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    webview.postMessage({ id, method, params })
  })
}

/** The macOS menu's "Check for Updates…" calls window.__hostEvent('openUpdates'). */
const listeners = new Set<(event: string) => void>()
w.__hostEvent = (e) => listeners.forEach((l) => l(e))
export function onHostEvent(cb: (event: string) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

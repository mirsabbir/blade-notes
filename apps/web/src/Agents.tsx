import { useEffect, useState } from 'react'
import { Bot, Copy, TriangleAlert } from 'lucide-react'
import { api } from './store'
import { copyToClipboard } from './clipboard'

/**
 * AI agents (Claude and other MCP clients) reach the library through /mcp on this site.
 * Connecting one ends here: the app shows who asks for what, and the owner says yes or no
 * (services/api/src/mcp/oauth.ts). Settings › Connected apps lists and removes them.
 */
const mcpUrl = () => `${location.origin}/mcp`

interface Request { clientName: string; clientId: string; redirectHost: string; scope: string[] }
interface Grant { id: string; clientName: string; redirectHost: string; scope: string[]; createdAt: string; lastUsedAt?: string }

/** /connect/<request>: the consent page an agent's sign-in lands on. */
export function ConnectPage({ id }: { id: string }) {
  const [req, setReq] = useState<Request | null>(null)
  const [error, setError] = useState('')
  const [write, setWrite] = useState(true)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    api<Request>('GET', `/api/oauth/requests/${id}`)
      .then((r) => {
        setReq(r)
        setWrite(r.scope.includes('notes:write'))
      })
      .catch((e: Error) => setError(e.message))
  }, [id])

  const answer = async (allow: boolean) => {
    setBusy(true)
    try {
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
      const { redirect } = await api<{ redirect: string }>('POST', `/api/oauth/requests/${id}`, { allow, write, zone })
      location.assign(redirect)
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  const local = req?.redirectHost === 'this computer'
  return (
    <div className="splash connect">
      <Bot size={40} aria-hidden />
      {!req && !error && <p>Loading…</p>}
      {error && (
        <>
          <h1>Could not connect</h1>
          <p>{error}</p>
          <a className="btn" href="/">Open Blade Notes</a>
        </>
      )}
      {req && !error && (
        <>
          <h1>Connect {req.clientName}?</h1>
          <p>
            <strong>{req.clientName}</strong> wants to use your Blade Notes. After you answer, you go back to <strong>{req.redirectHost}</strong>.
          </p>
          {local && (
            <p className="connect-warn">
              <TriangleAlert size={14} aria-hidden /> An app on this computer gets access. Allow it only if you just started connecting yourself, for example from Claude Code.
            </p>
          )}
          <div className="connect-scopes">
            <label className="choice on">
              <input type="checkbox" checked disabled />
              <span>Read<small>Spaces, folders, notes, tasks, dates and hidden descriptions.</small></span>
            </label>
            {req.scope.includes('notes:write') && (
              <label className={write ? 'choice on' : 'choice'}>
                <input type="checkbox" checked={write} onChange={(e) => setWrite(e.target.checked)} />
                <span>Change<small>Create, edit, move, and move to the trash (kept 30 days). Deleting for good stays in the app.</small></span>
              </label>
            )}
          </div>
          <p className="muted small">Secret blocks stay locked: they are encrypted on your devices and no app can read them. Remove access any time in Settings › Connected apps.</p>
          <p className="muted small connect-id">App id: {req.clientId}</p>
          <span className="row-actions">
            <button type="button" className="btn primary" disabled={busy} onClick={() => void answer(true)}>Allow</button>
            <button type="button" className="btn" disabled={busy} onClick={() => void answer(false)}>Don’t allow</button>
          </span>
        </>
      )}
    </div>
  )
}

const day = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '')

/** Settings › Connected apps: how to connect, and every app connected now. */
export function ConnectedApps() {
  const [grants, setGrants] = useState<Grant[] | null>(null)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const load = () =>
    api<{ connections: Grant[] }>('GET', '/api/connections')
      .then((r) => setGrants(r.connections))
      .catch((e: Error) => setError(e.message))
  useEffect(() => void load(), [])

  const remove = async (g: Grant) => {
    if (!confirm(`Disconnect ${g.clientName}? It loses access at once (within a minute) and has to be connected again.`)) return
    await api('DELETE', `/api/connections/${g.id}`).catch((e: Error) => setError(e.message))
    void load()
  }
  const copy = async () => {
    await copyToClipboard(mcpUrl(), mcpUrl())
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="settings-rows">
      <p className="muted small">Let AI assistants such as Claude read and change your notes. Each app asks you here first, and you choose read only or read and change.</p>
      <div className="setting top">
        <span>
          <strong>Server address</strong>
          <code className="totp-key">{mcpUrl()}</code>
          <small>
            Claude on the web, desktop or phone: Settings › Connectors › Add custom connector, paste the address. Claude Code: run this, then type <code>/mcp</code> in Claude Code to sign in:
            <code className="connect-cmd">claude mcp add --transport http --scope user blade-notes {mcpUrl()}</code>
          </small>
        </span>
        <button type="button" className="btn" onClick={() => void copy()}>
          <Copy size={14} aria-hidden /> {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <h4 className="settings-sub">Connected now</h4>
      {error && <small className="warn-text">{error}</small>}
      {grants?.length === 0 && <p className="muted small">No app is connected.</p>}
      {grants?.map((g) => (
        <div className="setting" key={g.id}>
          <span>
            <strong>{g.clientName}</strong>
            <small>
              {g.scope.includes('notes:write') ? 'Can read and change' : 'Can read'} · back to {g.redirectHost} · connected {day(g.createdAt)}
              {g.lastUsedAt ? ` · last used ${day(g.lastUsedAt)}` : ''}
            </small>
          </span>
          <button type="button" className="btn warn-text" onClick={() => void remove(g)}>Disconnect</button>
        </div>
      ))}
    </div>
  )
}

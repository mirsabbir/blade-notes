import { useEffect, useState, type FormEvent } from 'react'
import { Check, Copy, Lock, LockOpen, X } from 'lucide-react'
import { updateSettings } from './store'
import { copyToClipboard } from './clipboard'
import { createVault, hasVault, isUnlocked, lock, resetPassphrase, unlock, useVault } from './vault'
import './secret.css'

/** Settings › Security: make, open, lock and re-key the vault behind Secret blocks. */

const MIN = 10

/** A new passphrase typed twice; with `current`, the old one (or the recovery key) first. */
function NewPassphrase({ action, current, onSubmit, onCancel }: {
  action: string
  current?: boolean
  onSubmit: (passphrase: string, current: string) => Promise<string | void>
  onCancel?: () => void
}) {
  const [old, setOld] = useState('')
  const [a, setA] = useState('')
  const [b, setB] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if ([...a].length < MIN) return setError(`Use at least ${MIN} characters. A short sentence is easier to remember than a jumble.`)
    if (a !== b) return setError('The two passphrases are not the same.')
    setBusy(true)
    setError((await onSubmit(a, old)) ?? '')
    setBusy(false)
  }
  return (
    <form className="vault-form" onSubmit={submit}>
      {current && (
        <label>
          Current passphrase or recovery key
          <input className="field" type="password" autoComplete="current-password" value={old} onChange={(e) => setOld(e.target.value)} required />
        </label>
      )}
      <label>
        New passphrase
        <input className="field" type="password" autoComplete="new-password" value={a} onChange={(e) => setA(e.target.value)} autoFocus={!current} required />
      </label>
      <label>
        The same passphrase again
        <input className="field" type="password" autoComplete="new-password" value={b} onChange={(e) => setB(e.target.value)} required />
      </label>
      {error && <p className="update-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button className="btn primary" disabled={busy}>{busy ? 'Working…' : action}</button>
        {onCancel && <button type="button" className="btn" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  )
}

/** Passphrase, or the recovery key instead. `onUnlocked` says which was used. */
export function UnlockForm({ onUnlocked, autoFocus }: { onUnlocked: (secret: string, viaRecovery: boolean) => void; autoFocus?: boolean }) {
  const [recovery, setRecovery] = useState(false)
  const [secret, setSecret] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    const ok = await unlock(secret)
    setBusy(false)
    if (!ok) return setError(recovery ? 'That recovery key does not open this vault.' : 'Wrong passphrase.')
    onUnlocked(secret, recovery)
  }
  return (
    <form className="vault-form" onSubmit={submit}>
      <label>
        {recovery ? 'Recovery key' : 'Passphrase'}
        <input
          className={recovery ? 'field vault-mono' : 'field'}
          type={recovery ? 'text' : 'password'}
          autoComplete={recovery ? 'off' : 'current-password'}
          spellCheck={false}
          placeholder={recovery ? 'XXXX-XXXX-…' : undefined}
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          autoFocus={autoFocus}
        />
      </label>
      {error && <p className="update-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button className="btn primary" disabled={busy || !secret}>{busy ? 'Unlocking…' : 'Unlock'}</button>
        <button
          type="button"
          className="link-btn vault-switch"
          onClick={() => {
            setRecovery(!recovery)
            setSecret('')
            setError('')
          }}
        >
          {recovery ? 'Use the passphrase instead' : 'Use the recovery key instead'}
        </button>
      </div>
    </form>
  )
}

/** Shown once, right after the vault is made. */
function RecoveryKey({ code, onDone }: { code: string; onDone: () => void }) {
  const [saved, setSaved] = useState(false)
  const [copied, setCopied] = useState(false)
  return (
    <div className="vault-form">
      <p className="small"><strong>Your recovery key.</strong> It opens your secrets if you forget the passphrase. This is the only time it is shown: keep it in a password manager or on paper, away from this device.</p>
      <code className="vault-key">{code}</code>
      <div className="dialog-actions">
        <button
          type="button"
          className="btn"
          onClick={() => void copyToClipboard(code).then(() => setCopied(true), () => setCopied(false))}
        >
          {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />} {copied ? 'Copied' : 'Copy the key'}
        </button>
      </div>
      <label className="vault-check">
        <input type="checkbox" className="switch" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        I saved the recovery key somewhere safe
      </label>
      <div className="dialog-actions">
        <button type="button" className="btn primary" disabled={!saved} onClick={onDone}>Done</button>
      </div>
    </div>
  )
}

export function VaultSettings() {
  const { set, unlocked } = useVault()
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null)
  // The recovery key just opened the vault: ask for a new passphrase, using it as the "current" secret.
  const [resetWith, setResetWith] = useState<string | null>(null)
  const [changing, setChanging] = useState(false)

  const rekey = async (secret: string, passphrase: string) => {
    const header = await resetPassphrase(secret, passphrase)
    if (!header) return 'That passphrase or recovery key does not open this vault.'
    updateSettings({ vault: header })
    setResetWith(null)
    setChanging(false)
  }

  if (recoveryKey) return <RecoveryKey code={recoveryKey} onDone={() => setRecoveryKey(null)} />

  if (!set)
    return (
      <div className="vault-section">
        <p className="muted small">Secret blocks hide passwords, PINs and codes inside your notes. They are locked with a passphrase that never leaves your device, so the server, AWS and backups only ever hold scrambled text.</p>
        <p className="muted small">If you forget the passphrase and lose the recovery key, nobody can open the secrets, not even you.</p>
        <NewPassphrase
          action="Create the vault"
          onSubmit={async (p) => {
            const { header, recoveryKey } = await createVault(p)
            updateSettings({ vault: header })
            setRecoveryKey(recoveryKey)
          }}
        />
      </div>
    )

  if (resetWith)
    return (
      <div className="vault-section">
        <p className="small">The recovery key worked. Choose a new passphrase; the recovery key stays the same.</p>
        <NewPassphrase action="Save the new passphrase" onSubmit={(p) => rekey(resetWith, p)} onCancel={() => setResetWith(null)} />
      </div>
    )

  if (!unlocked)
    return (
      <div className="vault-section">
        <p className="vault-status"><Lock size={15} aria-hidden /> <span>Locked. Unlock to add, reveal or copy secrets.</span></p>
        <UnlockForm onUnlocked={(secret, viaRecovery) => viaRecovery && setResetWith(secret)} />
      </div>
    )

  if (changing)
    return (
      <div className="vault-section">
        <NewPassphrase action="Change the passphrase" current onSubmit={(p, old) => rekey(old, p)} onCancel={() => setChanging(false)} />
      </div>
    )

  return (
    <div className="vault-section">
      <p className="vault-status"><LockOpen size={15} aria-hidden /> <span>Unlocked on this device. It locks again after 5 minutes without a click or key press, and when you reload.</span></p>
      <p className="muted small">To hide something, select it in a note and choose Secret.</p>
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={lock}><Lock size={14} aria-hidden /> Lock now</button>
        <button type="button" className="btn" onClick={() => setChanging(true)}>Change passphrase</button>
      </div>
    </div>
  )
}

// ---- the unlock prompt that secrets open when the vault is locked ----

let openHost: ((resolve: (ok: boolean) => void) => void) | null = null

/** Asks for the passphrase in a small window; true once the vault is open. Needs VaultHost mounted. */
export function requestUnlock(): Promise<boolean> {
  if (isUnlocked()) return Promise.resolve(true)
  if (!hasVault() || !openHost) return Promise.resolve(false)
  const host = openHost
  return new Promise((resolve) => host(resolve))
}

/** Mount once near the app's root. */
export function VaultHost() {
  const [waiting, setWaiting] = useState<((ok: boolean) => void)[]>([])
  useEffect(() => {
    openHost = (resolve) => setWaiting((w) => [...w, resolve])
    return () => {
      openHost = null
    }
  }, [])
  if (waiting.length === 0) return null
  const finish = (ok: boolean) => {
    waiting.forEach((resolve) => resolve(ok))
    setWaiting([])
  }
  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && finish(false)} onKeyDown={(e) => e.key === 'Escape' && finish(false)}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="vault-unlock-title">
        <div className="dialog-head">
          <h2 id="vault-unlock-title" className="vault-title"><Lock size={16} aria-hidden /> Unlock your secrets</h2>
          <button type="button" className="ghost" aria-label="Cancel" onClick={() => finish(false)}>
            <X size={16} aria-hidden />
          </button>
        </div>
        <p className="muted small">Your vault passphrase opens Secret blocks on this device. It is never sent anywhere.</p>
        <UnlockForm autoFocus onUnlocked={() => finish(true)} />
      </div>
    </div>
  )
}

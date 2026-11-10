import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, X } from 'lucide-react'
import { call, isDesktop, onHostEvent, type UpdateInfo } from './host'

const SIX_HOURS = 6 * 60 * 60 * 1000

/** Checks GitHub on open and every six hours; the desktop app caches checks for an hour. */
function useUpdate() {
  const [info, setInfo] = useState<UpdateInfo>()
  const [checking, setChecking] = useState(false)
  const check = useCallback((force = false) => {
    setChecking(true)
    return call('checkForUpdate', { force })
      .then(setInfo)
      .catch((e: Error) => setInfo({ current: '?', available: false, error: e.message }))
      .finally(() => setChecking(false))
  }, [])
  useEffect(() => {
    if (!isDesktop) return
    void check()
    const t = setInterval(() => void check(), SIX_HOURS)
    return () => clearInterval(t)
  }, [check])
  return { info, checking, check }
}

function InstallButton({ version }: { version: string }) {
  const [state, setState] = useState<'idle' | 'working' | 'error'>('idle')
  const [error, setError] = useState('')
  return (
    <>
      <button
        className="btn primary"
        disabled={state === 'working'}
        onClick={() => {
          setState('working')
          call('installUpdate').catch((e: Error) => {
            setError(e.message)
            setState('error')
          })
        }}
      >
        <RefreshCw size={14} aria-hidden /> {state === 'working' ? `Downloading ${version}…` : 'Update & restart'}
      </button>
      {state === 'error' && <p className="update-error">{error}</p>}
    </>
  )
}

/** A thin bar at the top when a newer desktop version is out. */
export function UpdateBanner() {
  const { info } = useUpdate()
  const [hidden, setHidden] = useState(false)
  if (!isDesktop || hidden || !info?.available || !info.latest) return null
  return (
    <div className="banner" role="status">
      <span>
        <strong>Blade Notes {info.latest} is available.</strong> You have {info.current}.
      </span>
      <InstallButton version={info.latest} />
      <button className="ghost" aria-label="Not now" onClick={() => setHidden(true)}>
        <X size={15} aria-hidden />
      </button>
    </div>
  )
}

/** Settings → About & updates. Only exists inside the desktop app. */
export function UpdatesPanel({ onClose }: { onClose: () => void }) {
  const { info, checking, check } = useUpdate()
  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="updates-title">
        <div className="dialog-head">
          <h2 id="updates-title">About & updates</h2>
          <button className="ghost" aria-label="Close" onClick={onClose}>
            <X size={16} aria-hidden />
          </button>
        </div>
        <dl className="fields">
          <dt>Version</dt>
          <dd>{info?.current ?? '…'}</dd>
          <dt>Latest</dt>
          <dd>{checking ? 'Checking…' : info?.error ? <span className="muted">Can't check: {info.error}</span> : (info?.latest ?? '…')}</dd>
        </dl>
        <p className="muted small">Updates come from the project's GitHub Releases. Installing downloads the new version, replaces the app and reopens it. Your notes are kept.</p>
        <div className="dialog-actions">
          {info?.available && info.latest ? (
            <InstallButton version={info.latest} />
          ) : (
            <button className="btn" disabled={checking} onClick={() => void check(true)}>
              <RefreshCw size={14} aria-hidden /> Check for updates
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/** Opens the panel from the macOS menu's "Check for Updates…". */
export function useOpenUpdatesFromMenu(open: () => void) {
  useEffect(() => onHostEvent((e) => e === 'openUpdates' && open()), [open])
}

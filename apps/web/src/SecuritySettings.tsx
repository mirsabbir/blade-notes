import { useEffect, useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import { cognito, CognitoError, signIn, signOut } from './auth'
import { VaultSettings } from './VaultPanel'

/**
 * Settings › Security: two-step sign-in, signing out everywhere, and the vault behind
 * Secret blocks. Everything else (encryption at rest and in transit) needs no setting.
 */
export function SecuritySettings() {
  return (
    <div className="settings-rows">
      <p className="muted small">
        Notes, files and logs are encrypted at rest with this app’s own AWS key, and only travel over HTTPS. Files open only for you, signed in. Secret blocks add a key that never leaves your devices.
      </p>
      <TwoStep />
      <SignOutEverywhere />
      <h4 className="settings-sub">Secret blocks</h4>
      <VaultSettings />
    </div>
  )
}

type Phase =
  | { at: 'loading' }
  | { at: 'on' }
  | { at: 'off'; email: string }
  | { at: 'setup'; email: string; secret: string; qr: string }
  | { at: 'fresh-sign-in' }
  | { at: 'error'; message: string }

interface User { UserMFASettingList?: string[]; UserAttributes?: { Name: string; Value: string }[] }

/** An authenticator app's six-digit code on top of the password (Cognito TOTP). */
function TwoStep() {
  const [phase, setPhase] = useState<Phase>({ at: 'loading' })
  const [code, setCode] = useState('')
  const [wrong, setWrong] = useState('')
  const fail = (e: unknown) => setPhase(e instanceof CognitoError && e.needsSignIn ? { at: 'fresh-sign-in' } : { at: 'error', message: (e as Error).message })

  useEffect(() => {
    cognito<User>('GetUser')
      .then((u) =>
        setPhase(u.UserMFASettingList?.includes('SOFTWARE_TOKEN_MFA') ? { at: 'on' } : { at: 'off', email: u.UserAttributes?.find((a) => a.Name === 'email')?.Value ?? '' }),
      )
      .catch(fail)
  }, [])

  const start = async (email: string) => {
    try {
      const { SecretCode } = await cognito<{ SecretCode: string }>('AssociateSoftwareToken')
      const uri = `otpauth://totp/Blade%20Notes:${encodeURIComponent(email)}?secret=${SecretCode}&issuer=Blade%20Notes`
      const { renderSVG } = await import('uqr') // loaded only here, so the app stays light
      setPhase({ at: 'setup', email, secret: SecretCode, qr: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(renderSVG(uri))}` })
    } catch (e) {
      fail(e)
    }
  }
  const verify = async () => {
    setWrong('')
    try {
      const r = await cognito<{ Status: string }>('VerifySoftwareToken', { UserCode: code.replace(/\s/g, ''), FriendlyDeviceName: 'Authenticator app' })
      if (r.Status !== 'SUCCESS') return setWrong('That code did not match. Wait for the next one and try again.')
      await cognito('SetUserMFAPreference', { SoftwareTokenMfaSettings: { Enabled: true, PreferredMfa: true } })
      setPhase({ at: 'on' })
    } catch (e) {
      if (e instanceof CognitoError && /code/i.test(e.message)) setWrong('That code did not match. Wait for the next one and try again.')
      else fail(e)
    }
  }

  return (
    <div className="setting top">
      <span>
        <strong>Two-step sign-in</strong>
        <small>
          {phase.at === 'on' && 'On. Signing in asks for a code from your authenticator app.'}
          {phase.at === 'off' && 'Off. Anyone with your password can sign in. Turn it on with an authenticator app (Google Authenticator, 1Password, Authy).'}
          {phase.at === 'loading' && 'Checking…'}
          {phase.at === 'fresh-sign-in' && 'Setting this up needs a fresh sign-in, once.'}
          {phase.at === 'error' && `Could not check: ${phase.message}`}
          {phase.at === 'setup' && 'Scan the code with your authenticator app, then type the six digits it shows.'}
        </small>
        {phase.at === 'setup' && (
          <span className="totp">
            <img src={phase.qr} width={168} height={168} alt="QR code for your authenticator app" />
            <span className="totp-side">
              <small>Can’t scan? Enter this key:</small>
              <code className="totp-key">{phase.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
              <label className="stack-label">
                Code from the app
                <input className="field" inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void verify()} autoFocus />
              </label>
              {wrong && <small className="warn-text">{wrong}</small>}
              <span className="row-actions">
                <button type="button" className="btn primary" onClick={() => void verify()} disabled={code.replace(/\s/g, '').length !== 6}>Turn on</button>
                <button type="button" className="btn" onClick={() => setPhase({ at: 'off', email: phase.email })}>Cancel</button>
              </span>
            </span>
          </span>
        )}
      </span>
      {phase.at === 'on' && <span className="badge"><ShieldCheck size={12} aria-hidden /> On</span>}
      {phase.at === 'off' && <button type="button" className="btn primary" onClick={() => void start(phase.email)}>Set up</button>}
      {phase.at === 'fresh-sign-in' && <button type="button" className="btn" onClick={() => void signIn()}>Sign in again</button>}
    </div>
  )
}

/** Ends every session on every device: their refresh tokens stop working at once. */
function SignOutEverywhere() {
  const [error, setError] = useState('')
  const go = async () => {
    if (!confirm('Sign out on every device, this one included? Changes not yet synced stay on each device until you sign in there again.')) return
    try {
      await cognito('GlobalSignOut')
      await signOut()
    } catch (e) {
      if (e instanceof CognitoError && e.needsSignIn) return void signIn()
      setError((e as Error).message)
    }
  }
  return (
    <div className="setting">
      <span>
        <strong>Sign out everywhere</strong>
        <small>For a lost phone or a shared computer. Every device has to sign in again.</small>
        {error && <small className="warn-text">{error}</small>}
      </span>
      <button type="button" className="btn" onClick={() => void go()}>
        Sign out everywhere
      </button>
    </div>
  )
}

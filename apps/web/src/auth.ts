/**
 * Cognito sign-in with the authorization-code flow + PKCE, by hand: no SDK, no client secret.
 * Tokens live in localStorage; the access token is refreshed a minute before it expires.
 * The `aws.cognito.signin.user.admin` scope lets Settings › Security talk to Cognito for this
 * user only (two-step sign-in, sign out everywhere).
 */
interface Config { region: string; clientId: string; authUrl: string }
interface Tokens { access: string; refresh: string; expiresAt: number }

const KEY = 'bn:tokens'
const VERIFIER = 'bn:pkce'
let config: Config | null = null
const redirectUri = () => `${location.origin}/`

export async function loadConfig(): Promise<Config> {
  if (!config) {
    const res = await fetch('/config.json', { cache: 'no-store' })
    if (!res.ok) throw new Error(`config.json: ${res.status}`)
    config = (await res.json()) as Config
  }
  return config
}

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export async function signIn(): Promise<void> {
  const c = await loadConfig()
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)))
  sessionStorage.setItem(VERIFIER, verifier)
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: c.clientId,
    redirect_uri: redirectUri(),
    scope: 'openid email aws.cognito.signin.user.admin',
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })
  location.assign(`${c.authUrl}/oauth2/authorize?${q}`)
}

/** Ends the session here: the refresh token is revoked at Cognito, not just forgotten. */
export async function signOut(): Promise<void> {
  const raw = localStorage.getItem(KEY)
  localStorage.removeItem(KEY)
  const c = await loadConfig().catch(() => null)
  if (!c) return location.reload()
  const refresh = raw ? (JSON.parse(raw) as Tokens).refresh : ''
  if (refresh) {
    await fetch(`${c.authUrl}/oauth2/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refresh, client_id: c.clientId }),
    }).catch(() => undefined) // offline: the token still dies at its 30-day end
  }
  const q = new URLSearchParams({ client_id: c.clientId, logout_uri: redirectUri() })
  location.assign(`${c.authUrl}/logout?${q}`)
}

async function tokenRequest(body: Record<string, string>): Promise<Tokens> {
  const c = await loadConfig()
  const res = await fetch(`${c.authUrl}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.clientId, ...body }),
  })
  if (!res.ok) throw new TokenRejected(res.status)
  const t = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number }
  const tokens = { access: t.access_token, refresh: t.refresh_token ?? body.refresh_token ?? '', expiresAt: Date.now() + t.expires_in * 1000 }
  localStorage.setItem(KEY, JSON.stringify(tokens))
  return tokens
}

/** Call once at start-up: finishes a sign-in redirect if the URL carries ?code=. */
export async function completeSignIn(): Promise<void> {
  const code = new URLSearchParams(location.search).get('code')
  if (!code) return
  history.replaceState(null, '', '/')
  const verifier = sessionStorage.getItem(VERIFIER)
  sessionStorage.removeItem(VERIFIER)
  if (!verifier) return
  await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(), code_verifier: verifier })
}

export function isSignedIn(): boolean {
  return localStorage.getItem(KEY) !== null
}

/** Cognito answered "no" (expired or revoked refresh token), as opposed to a network failure. */
class TokenRejected extends Error {
  constructor(readonly status: number) {
    super(`sign-in failed (${status})`)
  }
}

let refreshing: Promise<Tokens> | null = null

/**
 * A valid access token, or null when the user must sign in again. A network failure
 * throws instead (the caller shows "offline") and keeps the tokens: only Cognito
 * rejecting the refresh token ends the session. Parallel callers share one refresh.
 */
export async function accessToken(): Promise<string | null> {
  const raw = localStorage.getItem(KEY)
  if (!raw) return null
  const t = JSON.parse(raw) as Tokens
  if (Date.now() < t.expiresAt - 60_000) return t.access
  refreshing ??= tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh }).finally(() => (refreshing = null))
  try {
    return (await refreshing).access
  } catch (err) {
    if (!(err instanceof TokenRejected) || err.status >= 500) throw err
    localStorage.removeItem(KEY)
    return null
  }
}

/**
 * Cognito's user API for the signed-in user (two-step sign-in, sign out everywhere).
 * Needs the `aws.cognito.signin.user.admin` scope; a session from before it was added
 * gets "needs a fresh sign-in" and the caller offers one.
 */
export async function cognito<T>(action: string, body: Record<string, unknown> = {}): Promise<T> {
  const c = await loadConfig()
  const token = await accessToken()
  if (!token) throw new Error('You are signed out.')
  const res = await fetch(`https://cognito-idp.${c.region}.amazonaws.com/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': `AWSCognitoIdentityProviderService.${action}` },
    body: JSON.stringify({ AccessToken: token, ...body }),
  })
  const data = (await res.json().catch(() => ({}))) as T & { __type?: string; message?: string }
  if (!res.ok) throw new CognitoError(data.message ?? `${action} failed (${res.status})`, /scope/i.test(data.message ?? ''))
  return data
}
export class CognitoError extends Error {
  constructor(message: string, readonly needsSignIn: boolean) {
    super(message)
  }
}

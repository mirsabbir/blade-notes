/**
 * Cognito sign-in with the authorization-code flow + PKCE, by hand: no SDK, no client secret.
 * Tokens live in localStorage; the access token is refreshed a minute before it expires.
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
    scope: 'openid email',
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })
  location.assign(`${c.authUrl}/oauth2/authorize?${q}`)
}

export function signOut(): void {
  localStorage.removeItem(KEY)
  if (!config) return location.reload()
  const q = new URLSearchParams({ client_id: config.clientId, logout_uri: redirectUri() })
  location.assign(`${config.authUrl}/logout?${q}`)
}

async function tokenRequest(body: Record<string, string>): Promise<Tokens> {
  const c = await loadConfig()
  const res = await fetch(`${c.authUrl}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.clientId, ...body }),
  })
  if (!res.ok) throw new Error(`sign-in failed (${res.status})`)
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

/** A valid access token, or null when the user must sign in again. */
export async function accessToken(): Promise<string | null> {
  const raw = localStorage.getItem(KEY)
  if (!raw) return null
  const t = JSON.parse(raw) as Tokens
  if (Date.now() < t.expiresAt - 60_000) return t.access
  try {
    return (await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh })).access
  } catch {
    localStorage.removeItem(KEY)
    return null
  }
}

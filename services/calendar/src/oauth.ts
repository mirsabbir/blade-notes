import { CalendarError } from './providers/http'

export interface OAuthApp {
  clientId: string
  clientSecret: string
}

const AUTH = {
  google: {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scope: 'openid email https://www.googleapis.com/auth/calendar.app.created',
    extra: { access_type: 'offline', prompt: 'consent' },
  },
  outlook: {
    authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope: 'openid email offline_access Calendars.ReadWrite',
    extra: { prompt: 'select_account' },
  },
}
export type OAuthProvider = keyof typeof AUTH

export function authorizeUrl(p: OAuthProvider, app: OAuthApp, state: string, redirectUri: string): string {
  const a = AUTH[p]
  const q = new URLSearchParams({ client_id: app.clientId, redirect_uri: redirectUri, response_type: 'code', scope: a.scope, state, ...a.extra })
  return `${a.authorize}?${q}`
}

interface Tokens {
  access_token: string
  refresh_token?: string
  expires_in: number
  id_token?: string
}

/** The token endpoint, for a code or a refresh token. Microsoft wants the scopes again every time. */
export async function tokens(p: OAuthProvider, app: OAuthApp, params: { [k: string]: string }): Promise<Tokens> {
  const body = new URLSearchParams({ client_id: app.clientId, client_secret: app.clientSecret, ...(p === 'outlook' && { scope: AUTH.outlook.scope }), ...params })
  const res = await fetch(AUTH[p].token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body })
  const json = (await res.json()) as Tokens & { error?: string }
  if (res.ok) return json
  const why = json.error === 'invalid_grant' ? 'The calendar sign-in expired or was revoked. Connect it again in Settings › Calendars.' : `Calendar sign-in failed (${res.status}).`
  throw new CalendarError(why, res.status)
}

const cache = new Map<string, { token: string; until: number }>()

/** An access token for a stored refresh token. Microsoft rotates refresh tokens: the new one comes back to be stored. */
export async function accessToken(p: OAuthProvider, app: OAuthApp, refreshToken: string): Promise<{ token: string; refreshToken: string }> {
  const hit = cache.get(refreshToken)
  if (hit && hit.until > Date.now()) return { token: hit.token, refreshToken }
  const t = await tokens(p, app, { grant_type: 'refresh_token', refresh_token: refreshToken })
  const next = t.refresh_token ?? refreshToken
  cache.set(next, { token: t.access_token, until: Date.now() + (t.expires_in - 60) * 1000 })
  return { token: t.access_token, refreshToken: next }
}

/** The account's email from an id_token that came straight from the token endpoint over TLS. */
export function emailOf(idToken: string | undefined): string {
  try {
    const claims = JSON.parse(Buffer.from(idToken!.split('.')[1]!, 'base64url').toString()) as { email?: string; preferred_username?: string }
    return claims.email ?? claims.preferred_username ?? ''
  } catch {
    return ''
  }
}

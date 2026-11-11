import { randomBytes } from 'node:crypto'
import type { APIGatewayProxyEventV2WithJWTAuthorizer as HttpEvent, APIGatewayProxyResultV2 as Result, DynamoDBStreamEvent } from 'aws-lambda'
import type { CalendarProvider, CalendarStatus } from '@blade-notes/core'
import { authorizeUrl, emailOf, tokens, type OAuthProvider } from './oauth'
import { appleCalendar, basic } from './providers/apple'
import { CalendarError } from './providers/http'
import { OAUTH_APIS } from './providers/index'
import { forgetCal, getCal, oauthApp, putCal, putState, seal, takeState, unseal } from './store'
import { backfill, onStream, site } from './sync'

/**
 * Calendar sync. HTTP: connect, status, disconnect and "sync now" under /api/calendar.
 * Stream: every ITEM# change of the notes table, so dates reach the space's calendar.
 */
export async function handler(event: HttpEvent | DynamoDBStreamEvent) {
  if ('Records' in event) return onStream(event.Records)
  return http(event)
}

const PROVIDERS: CalendarProvider[] = ['google', 'outlook', 'apple']
const redirectUri = () => `${site()}/api/calendar/callback`
class BadRequest extends Error {}

const json = (statusCode: number, body: unknown): Result => ({
  statusCode,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: JSON.stringify(body),
})
const redirect = (query: string): Result => ({ statusCode: 302, headers: { location: `${site()}/?${query}`, 'cache-control': 'no-store' } })

function parse(event: HttpEvent): { [k: string]: unknown } {
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString() : event.body
    return JSON.parse(raw || '{}') as { [k: string]: unknown }
  } catch {
    throw new BadRequest('body is not JSON')
  }
}

function provider(v: unknown): CalendarProvider {
  if (!PROVIDERS.includes(v as CalendarProvider)) throw new BadRequest('provider must be google, outlook or apple')
  return v as CalendarProvider
}

async function http(event: HttpEvent): Promise<Result> {
  try {
    if (event.routeKey === 'GET /api/calendar/callback') return await callback(event.queryStringParameters ?? {})
    const sub = event.requestContext.authorizer?.jwt?.claims?.sub
    if (typeof sub !== 'string') return json(401, { error: 'no user' })
    if (event.routeKey === 'GET /api/calendar') return json(200, { providers: await status(sub) })
    const body = parse(event)
    if (event.routeKey === 'POST /api/calendar/connect') return json(200, await connect(sub, body))
    if (event.routeKey === 'POST /api/calendar/disconnect') return json(200, await disconnect(sub, provider(body.provider)))
    if (event.routeKey === 'POST /api/calendar/resync') return json(200, await backfill(sub))
    return json(404, { error: 'not found' })
  } catch (err) {
    if (err instanceof BadRequest) return json(400, { error: err.message })
    console.error(err)
    return json(500, { error: 'internal error' })
  }
}

function status(sub: string): Promise<CalendarStatus[]> {
  return Promise.all(
    PROVIDERS.map(async (p) => {
      const rec = await getCal(sub, p)
      const configured = p === 'apple' || (await oauthApp(p)) !== null
      return { provider: p, configured, connected: !!rec?.secret, account: rec?.account, lastSyncAt: rec?.lastSyncAt, lastError: rec?.lastError }
    }),
  )
}

/** Google and Microsoft: the sign-in page to send the browser to. Apple: checks and stores the app-specific password. */
async function connect(sub: string, body: { [k: string]: unknown }) {
  const p = provider(body.provider)
  if (p === 'apple') return connectApple(sub, body)
  const app = await oauthApp(p)
  if (!app) throw new BadRequest(`${p === 'google' ? 'Google' : 'Microsoft'} sign-in is not set up on this server yet.`)
  const state = randomBytes(24).toString('base64url')
  await putState(state, sub, p)
  return { url: authorizeUrl(p, app, state, redirectUri()) }
}

async function connectApple(sub: string, body: { [k: string]: unknown }) {
  const username = typeof body.username === 'string' ? body.username.trim() : ''
  const password = typeof body.password === 'string' ? body.password.replace(/\s+/g, '') : ''
  if (!username || !password) throw new BadRequest('Enter your Apple ID and an app-specific password.')
  let calendarId: string
  try {
    calendarId = await appleCalendar(basic(username, password))
  } catch (err) {
    if (err instanceof CalendarError && err.status === 401) throw new BadRequest('Apple did not accept that Apple ID and app-specific password.')
    throw err
  }
  const secret = await seal(sub, 'apple', { username, password })
  await putCal(sub, { provider: 'apple', calendarId, account: username, secret, connectedAt: new Date().toISOString() })
  await backfillQuietly(sub)
  return { ok: true, account: username }
}

/** Where Google or Microsoft send the browser back. No sign-in here: the one-time state says who it is. */
async function callback(q: { [k: string]: string | undefined }): Promise<Result> {
  const fail = (why: string) => redirect(`calendar-error=${encodeURIComponent(why)}`)
  const state = q.state ? await takeState(q.state) : undefined
  if (!state) return fail('That sign-in link has expired. Try Connect again.')
  if (!q.code) return fail(q.error === 'access_denied' ? 'Calendar access was not allowed.' : 'The sign-in did not finish.')
  const { sub, provider: p } = state
  try {
    await finishOAuth(sub, p, q.code)
  } catch (err) {
    console.error(err)
    return fail(err instanceof CalendarError ? err.message : 'Connecting the calendar failed. Try again.')
  }
  await backfillQuietly(sub)
  return redirect(`calendar=${p}`)
}

async function finishOAuth(sub: string, p: OAuthProvider, code: string): Promise<void> {
  const app = await oauthApp(p)
  if (!app) throw new CalendarError('Calendar sign-in is not set up on this server.', 400)
  const t = await tokens(p, app, { grant_type: 'authorization_code', code, redirect_uri: redirectUri() })
  if (!t.refresh_token) throw new CalendarError('No lasting access was granted. Try Connect again.', 400)
  // Reconnecting reuses the calendar made last time, so there is only ever one "Blade Notes".
  const calendarId = await OAUTH_APIS[p].calendar(`Bearer ${t.access_token}`, (await getCal(sub, p))?.calendarId)
  const secret = await seal(sub, p, { refreshToken: t.refresh_token })
  await putCal(sub, { provider: p, calendarId, account: emailOf(t.id_token), secret, connectedAt: new Date().toISOString() })
}

/** Connected even when writing the existing dates fails: the stream and "Sync now" catch up. */
async function backfillQuietly(sub: string): Promise<void> {
  await backfill(sub).catch((err: unknown) => console.error(err))
}

/** Forgets the sign-in (Google's is also revoked); events already written stay on the calendar. */
async function disconnect(sub: string, p: CalendarProvider) {
  const rec = await getCal(sub, p)
  if (p === 'google' && rec?.secret) {
    const secret = await unseal(sub, p, rec.secret)
    if ('refreshToken' in secret)
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(secret.refreshToken)}`, { method: 'POST' }).catch(() => undefined)
  }
  await forgetCal(sub, p)
  return { ok: true }
}

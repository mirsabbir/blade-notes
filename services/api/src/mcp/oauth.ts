import { createHash, randomBytes } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { db, TABLE } from '../sync'

/**
 * A small OAuth 2.1 authorization server for agents (MCP clients), the way Claude and the
 * MCP spec expect it: discovery metadata, client ID metadata documents (CIMD) and dynamic
 * registration (DCR), authorization code + PKCE (S256), refresh token rotation.
 *
 * Signing in and saying yes happen in the app itself: /oauth/authorize stores the request and
 * sends the browser to /connect/<request>, where the signed-in app shows who asks for what and
 * approves through /api/oauth/requests (behind the app's own sign-in). So the agent never sees
 * the password or two-step code, and every connection is a grant the owner can revoke.
 *
 * Tokens are random strings; only their SHA-256 is stored. Records (one table, no `seq`, so
 * devices never sync them):
 *   OAUTH#client#<id>    registered client (DCR)          OAUTH#request#<id>  pending approval, 10 min
 *   OAUTH#code#<hash>    one-time code, 2 min             OAUTH#token#<hash>  access 1 h / refresh 60 days
 *   USER#<sub> GRANT#<id>  a connected app: what it may do, when it was last used
 */

export const SITE = (process.env.SITE_URL ?? 'https://notes.example.com').replace(/\/$/, '')
export const RESOURCE = `${SITE}/mcp`
export const SCOPES = ['notes:read', 'notes:write'] as const
const ACCESS_S = 3600
const REFRESH_S = 60 * 86_400
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

export class OAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message)
  }
}

export interface Grant {
  id: string
  clientId: string
  clientName: string
  /** Where the app sends people back to, e.g. claude.ai, or "this computer". */
  redirectHost: string
  scope: string[]
  zone?: string
  createdAt: string
  lastUsedAt?: string
}

interface Request {
  clientId: string
  clientName: string
  redirectUri: string
  state?: string
  challenge: string
  scope: string[]
  createdAt: string
}

const now = () => Math.floor(Date.now() / 1000)
const random = () => randomBytes(32).toString('base64url')
const hash = (s: string) => createHash('sha256').update(s).digest('base64url')
const key = (kind: string, id: string) => ({ pk: `OAUTH#${kind}#${id}`, sk: 'OAUTH' })

async function get<T>(k: { pk: string; sk: string }): Promise<(T & { ttl?: number }) | undefined> {
  const res = await db.send(new GetCommand({ TableName: TABLE, Key: k }))
  const item = res.Item as (T & { ttl?: number }) | undefined
  return item && (!item.ttl || item.ttl > now()) ? item : undefined // DynamoDB removes expired records late
}
/** Reads and deletes in one step: a code or refresh token works once, even when two calls race. */
async function take<T>(k: { pk: string; sk: string }): Promise<(T & { ttl?: number }) | undefined> {
  const res = await db.send(new DeleteCommand({ TableName: TABLE, Key: k, ReturnValues: 'ALL_OLD' }))
  const item = res.Attributes as (T & { ttl?: number }) | undefined
  return item && (!item.ttl || item.ttl > now()) ? item : undefined
}
const put = (k: { pk: string; sk: string }, data: object, ttl?: number) => db.send(new PutCommand({ TableName: TABLE, Item: { ...k, ...data, ...(ttl && { ttl }) } }))

// ---------------- discovery ----------------

export const resourceMetadata = () => ({
  resource: RESOURCE,
  authorization_servers: [SITE],
  scopes_supported: [...SCOPES],
  bearer_methods_supported: ['header'],
  resource_name: 'Blade Notes',
  resource_documentation: 'https://github.com/mirsabbir/blade-notes/blob/main/docs/runbooks/connect-an-ai-agent.md',
})

export const serverMetadata = () => ({
  issuer: SITE,
  authorization_endpoint: `${SITE}/oauth/authorize`,
  token_endpoint: `${SITE}/oauth/token`,
  registration_endpoint: `${SITE}/oauth/register`,
  revocation_endpoint: `${SITE}/oauth/revoke`,
  scopes_supported: [...SCOPES],
  response_types_supported: ['code'],
  response_modes_supported: ['query'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  token_endpoint_auth_methods_supported: ['none'],
  revocation_endpoint_auth_methods_supported: ['none'],
  code_challenge_methods_supported: ['S256'],
  client_id_metadata_document_supported: true,
  authorization_response_iss_parameter_supported: true,
})

/** The 401 that tells an MCP client where to sign in. */
export const challenge = (error?: string) =>
  `Bearer resource_metadata="${SITE}/.well-known/oauth-protected-resource/mcp", scope="${SCOPES.join(' ')}"${error ? `, error="${error}"` : ''}`

// ---------------- clients ----------------

const url = (s: string) => {
  try {
    return new URL(s)
  } catch {
    return null
  }
}

/** A redirect URI a client may register: https, or http back to this computer (native apps, RFC 8252). */
const allowedRedirect = (s: string) => {
  const u = url(s)
  return !!u && !u.hash && (u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname)))
}

/** Exact match, except that a loopback redirect may use any port (RFC 8252 §7.3; Claude Code needs it for localhost too). */
export function redirectMatches(registered: string[], uri: string): boolean {
  const u = url(uri)
  return registered.some((r) => {
    if (r === uri) return true
    const a = url(r)
    return !!a && !!u && a.protocol === 'http:' && u.protocol === 'http:' && LOOPBACK.has(a.hostname) && a.hostname === u.hostname && a.pathname === u.pathname && a.search === u.search
  })
}

const documents = new Map<string, { at: number; client: { name: string; redirects: string[] } }>()

/** A client named by an https URL publishes its own metadata there (CIMD). */
async function clientDocument(id: string): Promise<{ name: string; redirects: string[] }> {
  const hit = documents.get(id)
  if (hit && hit.at > Date.now() - 600_000) return hit.client
  const u = url(id)
  const bad = () => new OAuthError('invalid_client', `No valid client metadata at ${id}.`)
  // Public https names only: no IP literals, ports, or names that point inside (the Lambda's own runtime API is on 127.0.0.1).
  if (!u || u.protocol !== 'https:' || u.port || u.pathname === '/' || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname)) throw bad()
  const addresses = await lookup(u.hostname, { all: true }).catch(() => [])
  if (!addresses.length || addresses.some((a) => /^(10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.|::1$|f[cd]|fe80)/i.test(a.address))) throw bad()
  const res = await fetch(u, { redirect: 'error', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5000) }).catch(() => null)
  if (!res?.ok || Number(res.headers.get('content-length') ?? 0) > 64_000) throw bad()
  let doc: { client_id?: string; client_name?: string; redirect_uris?: unknown } | null = null
  try {
    const text = await res.text()
    doc = text.length < 64_000 ? JSON.parse(text) : null
  } catch {
    throw bad()
  }
  if (!doc || doc.client_id !== id || !Array.isArray(doc.redirect_uris)) throw bad()
  const client = { name: String(doc.client_name ?? u.hostname).slice(0, 100), redirects: doc.redirect_uris.filter((r): r is string => typeof r === 'string' && allowedRedirect(r)) }
  documents.set(id, { at: Date.now(), client })
  return client
}

async function client(id: string): Promise<{ name: string; redirects: string[] }> {
  if (id.startsWith('https://')) return clientDocument(id)
  const c = /^[\w-]{20,64}$/.test(id) ? await get<{ name: string; redirects: string[] }>(key('client', id)) : undefined
  if (!c) throw new OAuthError('invalid_client', 'Unknown client. Register again.')
  return c
}

/** Dynamic client registration (RFC 7591): public clients only. */
export async function register(body: { redirect_uris?: unknown; client_name?: unknown }) {
  const redirects = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((r): r is string => typeof r === 'string') : []
  if (!redirects.length || redirects.length > 10 || !redirects.every(allowedRedirect))
    throw new OAuthError('invalid_redirect_uri', 'redirect_uris: 1 to 10 https URLs, or http URLs on localhost / 127.0.0.1.')
  const id = random()
  const name = String(body.client_name ?? 'An app').slice(0, 100)
  await put(key('client', id), { name, redirects }, now() + 365 * 86_400)
  return {
    client_id: id,
    client_id_issued_at: now(),
    client_name: name,
    redirect_uris: redirects,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  }
}

// ---------------- authorize and approve ----------------

/** Where the authorization response goes, with the issuer (RFC 9207) so a client cannot be mixed up. */
const back = (redirect: string, params: { [k: string]: string | undefined }) => {
  const u = new URL(redirect)
  for (const [k, v] of Object.entries({ ...params, iss: SITE })) if (v !== undefined) u.searchParams.set(k, v)
  return u.toString()
}

/**
 * GET /oauth/authorize. Returns where to send the browser: the consent page, or, for a bad
 * request with a trusted redirect, back to the client with the error. A client or redirect that
 * cannot be trusted throws (shown as a page, never redirected to).
 */
export async function authorize(q: { [k: string]: string | undefined }): Promise<string> {
  const id = q.client_id ?? ''
  const c = await client(id)
  const redirect = q.redirect_uri ?? ''
  if (!redirectMatches(c.redirects, redirect)) throw new OAuthError('invalid_request', 'This redirect_uri is not one the client registered.')
  const fail = (error: string, description: string) => back(redirect, { error, error_description: description, state: q.state })
  if (q.response_type !== 'code') return fail('unsupported_response_type', 'Only response_type=code.')
  if (!q.code_challenge || q.code_challenge_method !== 'S256') return fail('invalid_request', 'PKCE with S256 is required.')
  if (q.resource && q.resource.replace(/\/$/, '') !== RESOURCE && q.resource.replace(/\/$/, '') !== SITE) return fail('invalid_target', `The resource is ${RESOURCE}.`)
  // No scope asked: both, and the owner decides on the consent page. Only unknown scopes: read only.
  const asked = (q.scope ?? SCOPES.join(' ')).split(/\s+/).filter((s): s is (typeof SCOPES)[number] => (SCOPES as readonly string[]).includes(s))
  const scope = asked.length ? asked : ['notes:read' as const]
  const request = random()
  const data: Request = { clientId: id, clientName: c.name, redirectUri: redirect, state: q.state, challenge: q.code_challenge, scope, createdAt: new Date().toISOString() }
  await put(key('request', request), data, now() + 600)
  return `${SITE}/connect/${request}`
}

const hostOf = (redirect: string) => {
  const u = new URL(redirect)
  return LOOPBACK.has(u.hostname) ? 'this computer' : u.host
}

/** What the consent page shows. */
export async function pending(id: string) {
  const r = await get<Request>(key('request', id))
  if (!r) throw new OAuthError('invalid_request', 'This connection request has expired. Start connecting again from the app.', 404)
  return { clientName: r.clientName, clientId: r.clientId, redirectHost: hostOf(r.redirectUri), scope: r.scope }
}

/** The owner said yes or no on the consent page: where the browser goes next. */
export async function decide(sub: string, id: string, answer: { allow: boolean; write: boolean; zone?: string }): Promise<string> {
  const r = await take<Request>(key('request', id))
  if (!r) throw new OAuthError('invalid_request', 'This connection request has expired. Start connecting again from the app.', 404)
  if (!answer.allow) return back(r.redirectUri, { error: 'access_denied', error_description: 'The owner said no.', state: r.state })
  const scope = r.scope.filter((s) => s !== 'notes:write' || answer.write)
  if (!scope.includes('notes:read')) scope.unshift('notes:read')
  // One grant per app: connecting the same app again updates it instead of piling up.
  const grants = await listGrants(sub)
  const old = grants.find((g) => g.clientId === r.clientId)
  const grant: Grant = {
    id: old?.id ?? random().slice(0, 16),
    clientId: r.clientId,
    clientName: r.clientName,
    redirectHost: hostOf(r.redirectUri),
    scope,
    ...(answer.zone && { zone: answer.zone.slice(0, 64) }),
    createdAt: old?.createdAt ?? new Date().toISOString(),
  }
  await put({ pk: `USER#${sub}`, sk: `GRANT#${grant.id}` }, { grant })
  const code = random()
  await put(key('code', hash(code)), { sub, grantId: grant.id, clientId: r.clientId, redirectUri: r.redirectUri, challenge: r.challenge, scope, exp: now() + 120 }, now() + 600)
  return back(r.redirectUri, { code, state: r.state })
}

export async function listGrants(sub: string): Promise<Grant[]> {
  const res = await db.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'pk = :pk AND begins_with(sk, :g)', ExpressionAttributeValues: { ':pk': `USER#${sub}`, ':g': 'GRANT#' } }))
  return (res.Items ?? []).map((i) => i.grant as Grant).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/** Disconnects an app: its tokens stop working at once (each use checks the grant). */
export const revokeGrant = (sub: string, id: string) => db.send(new DeleteCommand({ TableName: TABLE, Key: { pk: `USER#${sub}`, sk: `GRANT#${id}` } }))

// ---------------- tokens ----------------

interface TokenRecord {
  sub: string
  grantId: string
  clientId: string
  scope: string[]
  kind: 'access' | 'refresh'
  exp: number
}

async function issue(t: Omit<TokenRecord, 'kind' | 'exp'>) {
  const access = `bn_at_${random()}`
  const refresh = `bn_rt_${random()}`
  await Promise.all([
    put(key('token', hash(access)), { ...t, kind: 'access', exp: now() + ACCESS_S }, now() + ACCESS_S),
    put(key('token', hash(refresh)), { ...t, kind: 'refresh', exp: now() + REFRESH_S }, now() + REFRESH_S),
  ])
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_S, refresh_token: refresh, scope: t.scope.join(' ') }
}

const grantOf = (sub: string, id: string) => get<{ grant: Grant }>({ pk: `USER#${sub}`, sk: `GRANT#${id}` })

/** POST /oauth/token (form encoded): authorization_code with PKCE, or refresh_token (rotated). */
export async function token(form: URLSearchParams) {
  const type = form.get('grant_type')
  const clientId = form.get('client_id') ?? ''
  if (type === 'authorization_code') {
    const c = await take<Omit<TokenRecord, 'kind'> & { redirectUri: string; challenge: string }>(key('code', hash(form.get('code') ?? '')))
    const verifier = form.get('code_verifier') ?? ''
    if (!c || c.exp < now() || c.clientId !== clientId || c.redirectUri !== form.get('redirect_uri') || hash(verifier) !== c.challenge)
      throw new OAuthError('invalid_grant', 'The code is wrong, used or expired, or does not match this client, redirect or PKCE verifier.')
    if (!(await grantOf(c.sub, c.grantId))) throw new OAuthError('invalid_grant', 'This connection was removed.')
    return issue({ sub: c.sub, grantId: c.grantId, clientId: c.clientId, scope: c.scope })
  }
  if (type === 'refresh_token') {
    const t = await take<TokenRecord>(key('token', hash(form.get('refresh_token') ?? '')))
    if (!t || t.kind !== 'refresh' || t.exp < now() || (clientId && t.clientId !== clientId)) throw new OAuthError('invalid_grant', 'The refresh token is wrong, used or expired. Connect again.')
    if (!(await grantOf(t.sub, t.grantId))) throw new OAuthError('invalid_grant', 'This connection was removed. Connect again.')
    return issue({ sub: t.sub, grantId: t.grantId, clientId: t.clientId, scope: t.scope })
  }
  throw new OAuthError('unsupported_grant_type', 'grant_type is authorization_code or refresh_token.')
}

/** POST /oauth/revoke (RFC 7009): forgets a token; always 200. */
export async function revoke(form: URLSearchParams): Promise<void> {
  await take(key('token', hash(form.get('token') ?? '')))
}

export interface Access {
  sub: string
  clientId: string
  scopes: string[]
  zone?: string
}

const seen = new Map<string, { at: number; access: Access }>()

/** The caller behind a bearer token, or null. Checked tokens are remembered for a minute. */
export async function verify(bearer: string): Promise<Access | null> {
  const h = hash(bearer)
  const hit = seen.get(h)
  if (hit && hit.at > Date.now() - 60_000) return hit.access
  const t = await get<TokenRecord>(key('token', h))
  if (!t || t.kind !== 'access' || t.exp < now()) return null
  const g = await grantOf(t.sub, t.grantId)
  if (!g) return null
  const access = { sub: t.sub, clientId: t.clientId, scopes: t.scope.filter((s) => g.grant.scope.includes(s)), zone: g.grant.zone }
  seen.set(h, { at: Date.now(), access })
  if (!g.grant.lastUsedAt || Date.parse(g.grant.lastUsedAt) < Date.now() - 3_600_000)
    await db.send(new UpdateCommand({ TableName: TABLE, Key: { pk: `USER#${t.sub}`, sk: `GRANT#${t.grantId}` }, UpdateExpression: 'SET #g.lastUsedAt = :t', ExpressionAttributeNames: { '#g': 'grant' }, ExpressionAttributeValues: { ':t': new Date().toISOString() }, ConditionExpression: 'attribute_exists(pk)' })).catch(() => undefined)
  return access
}

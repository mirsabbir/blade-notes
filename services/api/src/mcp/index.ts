import { createMcpHandler } from '@modelcontextprotocol/server'
import type { APIGatewayProxyEventV2WithJWTAuthorizer as Event, APIGatewayProxyResultV2 as Result } from 'aws-lambda'
import { authorize, challenge, decide, listGrants, OAuthError, pending, register, resourceMetadata, revoke, revokeGrant, SITE, serverMetadata, token, verify, type Access } from './oauth'
import { server } from './tools'

/**
 * The agent door, one Lambda: the MCP endpoint (/mcp), its OAuth server (/.well-known/…,
 * /oauth/…) and the app's side of it (/api/oauth/…, /api/connections, behind the app's sign-in).
 * docs/architecture/08-agents-mcp.md
 */
const mcp = createMcpHandler(({ authInfo }) => server(authInfo!.extra!.access as Access & { scopes: string[] }))

const json = (statusCode: number, body: unknown, headers: { [k: string]: string } = {}): Result => ({
  statusCode,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  body: JSON.stringify(body),
})
const redirect = (location: string): Result => ({ statusCode: 302, headers: { location, 'cache-control': 'no-store' }, body: '' })
const page = (status: number, title: string, text: string): Result => ({
  statusCode: status,
  headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><body style="font:16px system-ui;max-width:32rem;margin:15vh auto;padding:0 16px"><h1 style="font-size:20px">${title}</h1><p>${text.replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;'))}</p><p><a href="${SITE}">Open Blade Notes</a></p>`,
})

const body = (e: Event) => (e.isBase64Encoded ? Buffer.from(e.body ?? '', 'base64').toString() : (e.body ?? ''))
const parseJson = (e: Event) => {
  try {
    return JSON.parse(body(e) || '{}') as { [k: string]: unknown }
  } catch {
    throw new OAuthError('invalid_request', 'The body is not JSON.')
  }
}

export async function handler(e: Event): Promise<Result> {
  const started = Date.now()
  const route = e.routeKey
  let res: Result
  try {
    res = await serve(e, route)
  } catch (err) {
    if (err instanceof OAuthError)
      res = route === 'GET /oauth/authorize' ? page(err.status, 'Could not connect', err.message) : json(err.status, { error: err.code, error_description: err.message })
    else {
      console.error(err)
      res = json(500, { error: 'server_error' })
    }
  }
  // Never the content: the route, the MCP method and tool, the status and the time.
  const call = route === 'POST /mcp' ? /"method"\s*:\s*"([\w/]+)"(?:[\s\S]*?"name"\s*:\s*"(\w+)")?/.exec(body(e)) : null
  console.log(JSON.stringify({ route, method: call?.[1], tool: call?.[1] === 'tools/call' ? call[2] : undefined, status: typeof res === 'object' ? res.statusCode : 200, ms: Date.now() - started }))
  return res
}

async function serve(e: Event, route: string): Promise<Result> {
  const sub = e.requestContext.authorizer?.jwt?.claims?.sub as string | undefined
  switch (route) {
    case 'GET /.well-known/oauth-protected-resource':
    case 'GET /.well-known/oauth-protected-resource/{proxy+}':
      return json(200, resourceMetadata(), { 'cache-control': 'max-age=3600' })
    case 'GET /.well-known/oauth-authorization-server':
      return json(200, serverMetadata(), { 'cache-control': 'max-age=3600' })
    case 'POST /oauth/register':
      return json(201, await register(parseJson(e)))
    case 'GET /oauth/authorize':
      return redirect(await authorize(e.queryStringParameters ?? {}))
    case 'POST /oauth/token':
      return json(200, await token(new URLSearchParams(body(e))))
    case 'POST /oauth/revoke':
      await revoke(new URLSearchParams(body(e)))
      return json(200, {})
    case 'GET /api/oauth/requests/{id}':
      return json(200, await pending(e.pathParameters!.id!))
    case 'POST /api/oauth/requests/{id}': {
      const a = parseJson(e)
      return json(200, { redirect: await decide(sub!, e.pathParameters!.id!, { allow: a.allow === true, write: a.write === true, zone: typeof a.zone === 'string' ? a.zone : undefined }) })
    }
    case 'GET /api/connections':
      return json(200, { connections: await listGrants(sub!) })
    case 'DELETE /api/connections/{id}':
      await revokeGrant(sub!, e.pathParameters!.id!)
      return json(200, {})
    case 'POST /mcp':
    case 'GET /mcp':
    case 'DELETE /mcp':
      return agent(e)
  }
  return json(404, { error: 'not_found' })
}

/** The MCP endpoint: a bearer token from our OAuth server, then the stateless MCP handler. */
async function agent(e: Event): Promise<Result> {
  const auth = /^Bearer\s+(\S+)$/i.exec(e.headers.authorization ?? '')?.[1]
  const access = auth ? await verify(auth) : null
  if (!access) return json(401, { error: 'invalid_token', error_description: 'Connect Blade Notes to get a token.' }, { 'www-authenticate': challenge(auth ? 'invalid_token' : undefined) })
  // A Lambda answers once; a listening stream would hang until the timeout. Nothing changes to listen for anyway.
  const msg = (() => {
    try {
      return JSON.parse(body(e) || 'null') as { method?: string; id?: string | number } | null
    } catch {
      return null
    }
  })()
  if (msg?.method === 'subscriptions/listen') return json(200, { jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32601, message: 'This server is stateless and has no change streams.' } })
  const url = `${SITE}${e.rawPath}${e.rawQueryString ? `?${e.rawQueryString}` : ''}`
  const req = new Request(url, { method: e.requestContext.http.method, headers: e.headers as { [k: string]: string }, ...(e.body && { body: body(e) }) })
  const res = await mcp.fetch(req, { authInfo: { token: auth!, clientId: access.clientId, scopes: access.scopes, extra: { access } } })
  return { statusCode: res.status, headers: Object.fromEntries(res.headers), body: await res.text() }
}

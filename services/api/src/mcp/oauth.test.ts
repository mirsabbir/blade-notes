import { createHash, randomBytes } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { APIGatewayProxyEventV2WithJWTAuthorizer as Event, APIGatewayProxyStructuredResultV2 as Result } from 'aws-lambda'

// DynamoDB in memory: just the calls the OAuth server makes.
const table = vi.hoisted(() => new Map<string, { [k: string]: unknown }>())
vi.mock('../sync', () => {
  const k = (key: { pk: string; sk: string }) => `${key.pk}|${key.sk}`
  return {
    TABLE: 't',
    db: {
      send: async (cmd: { constructor: { name: string }; input: any }) => { // eslint-disable-line @typescript-eslint/no-explicit-any
        const i = cmd.input
        switch (cmd.constructor.name) {
          case 'GetCommand':
            return { Item: structuredClone(table.get(k(i.Key))) }
          case 'PutCommand':
            table.set(k(i.Item), structuredClone(i.Item))
            return {}
          case 'DeleteCommand': {
            const old = table.get(k(i.Key))
            table.delete(k(i.Key))
            return { Attributes: old }
          }
          case 'QueryCommand':
            return { Items: [...table.values()].filter((r) => r.pk === i.ExpressionAttributeValues[":pk"] && String(r.sk).startsWith('GRANT#')) }
          case 'UpdateCommand':
            return {}
        }
        throw new Error(cmd.constructor.name)
      },
    },
    pull: async () => ({ records: [], cursor: 0, more: false }),
    push: async () => ({ accepted: [], conflicts: [] }),
  }
})
const dns = vi.hoisted(() => ({ address: '160.79.104.10' }))
vi.mock('node:dns/promises', () => ({ lookup: async () => [{ address: dns.address, family: 4 }] }))
process.env.SITE_URL = 'https://notes.test'
const { handler } = await import('./index')

const event = (routeKey: string, opts: { path?: string; query?: { [k: string]: string }; body?: string; headers?: { [k: string]: string }; sub?: string; params?: { [k: string]: string } } = {}): Event =>
  ({
    routeKey,
    rawPath: opts.path ?? routeKey.split(' ')[1],
    rawQueryString: '',
    headers: opts.headers ?? {},
    queryStringParameters: opts.query,
    pathParameters: opts.params,
    body: opts.body,
    isBase64Encoded: false,
    requestContext: { http: { method: routeKey.split(' ')[0] }, ...(opts.sub && { authorizer: { jwt: { claims: { sub: opts.sub } } } }) },
  }) as unknown as Event
const call = async (...a: Parameters<typeof event>) => (await handler(event(...a))) as Result
const data = (r: Result) => JSON.parse(String(r.body)) // eslint-disable-line @typescript-eslint/no-unsafe-return

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

/** Register, authorize, approve in the app, exchange: what Claude does on Connect. */
async function connect(clientId: string, redirect: string, write = true) {
  const { verifier, challenge } = pkce()
  const auth = await call('GET /oauth/authorize', { query: { response_type: 'code', client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 's1', scope: 'notes:read notes:write', resource: 'https://notes.test/mcp' } })
  expect(auth.statusCode, String(auth.body)).toBe(302)
  const request = /\/connect\/([\w-]+)$/.exec(String(auth.headers!.location))![1]!
  expect(data(await call('GET /api/oauth/requests/{id}', { sub: 'user-1', params: { id: request } }))).toMatchObject({ scope: ['notes:read', 'notes:write'] })
  const back = new URL(data(await call('POST /api/oauth/requests/{id}', { sub: 'user-1', params: { id: request }, body: JSON.stringify({ allow: true, write, zone: 'Asia/Dhaka' }) })).redirect)
  expect(back.searchParams.get('state')).toBe('s1')
  expect(back.searchParams.get('iss')).toBe('https://notes.test')
  const form = new URLSearchParams({ grant_type: 'authorization_code', code: back.searchParams.get('code')!, redirect_uri: redirect, client_id: clientId, code_verifier: verifier })
  const tokens = data(await call('POST /oauth/token', { body: form.toString() }))
  return { tokens: tokens as { access_token: string; refresh_token: string; scope: string }, form }
}

describe('OAuth for agents', () => {
  it('serves discovery metadata Claude can follow', async () => {
    const mcp = await call('POST /mcp', { body: '{}' })
    expect(mcp.statusCode).toBe(401)
    expect(mcp.headers!['www-authenticate']).toBe('Bearer resource_metadata="https://notes.test/.well-known/oauth-protected-resource/mcp", scope="notes:read notes:write"')
    expect(data(await call('GET /.well-known/oauth-protected-resource/{proxy+}', { path: '/.well-known/oauth-protected-resource/mcp' }))).toMatchObject({ resource: 'https://notes.test/mcp', authorization_servers: ['https://notes.test'] })
    expect(data(await call('GET /.well-known/oauth-authorization-server'))).toMatchObject({
      issuer: 'https://notes.test',
      code_challenge_methods_supported: ['S256'],
      client_id_metadata_document_supported: true,
      token_endpoint_auth_methods_supported: ['none'],
    })
  })

  it('DCR client: connect, use, refresh with rotation, disconnect', async () => {
    const reg = data(await call('POST /oauth/register', { body: JSON.stringify({ client_name: 'Some agent', redirect_uris: ['https://agent.example/callback'] }) }))
    const { tokens, form } = await connect(reg.client_id, 'https://agent.example/callback', false)
    expect(tokens.scope).toBe('notes:read')
    expect((await call('POST /oauth/token', { body: form.toString() })).statusCode).toBe(400) // a code works once

    const list = await call('POST /mcp', { body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }), headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' } })
    expect(list.statusCode, String(list.body)).toBe(200)
    expect(String(list.body)).toContain('"overview"')
    expect(String(list.body)).not.toContain('"edit"') // read only

    const refresh = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: reg.client_id })
    const next = data(await call('POST /oauth/token', { body: refresh.toString() }))
    expect(next.access_token).toBeTruthy()
    expect(data(await call('POST /oauth/token', { body: refresh.toString() })).error).toBe('invalid_grant') // rotated

    const [grant] = data(await call('GET /api/connections', { sub: 'user-1' })).connections as { id: string; clientName: string }[]
    expect(grant!.clientName).toBe('Some agent')
    await call('DELETE /api/connections/{id}', { sub: 'user-1', params: { id: grant!.id } })
    const after = await call('POST /oauth/token', { body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: next.refresh_token, client_id: reg.client_id }).toString() })
    expect(data(after).error).toBe('invalid_grant')
  })

  it('CIMD client (Claude Code): metadata from its URL, loopback redirect on any port', async () => {
    const id = 'https://claude.ai/oauth/claude-code-client-metadata'
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ client_id: id, client_name: 'Claude Code', redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'] })))
    const { tokens } = await connect(id, 'http://localhost:49152/callback')
    expect(tokens.scope).toBe('notes:read notes:write')
    vi.unstubAllGlobals()
  })

  it('refuses what it must', async () => {
    const reg = data(await call('POST /oauth/register', { body: JSON.stringify({ redirect_uris: ['https://agent.example/cb'] }) }))
    const base = { response_type: 'code', client_id: reg.client_id, code_challenge: pkce().challenge, code_challenge_method: 'S256' }
    const wrongRedirect = await call('GET /oauth/authorize', { query: { ...base, redirect_uri: 'https://evil.example/cb' } })
    expect(wrongRedirect.statusCode).toBe(400) // a page, never a redirect to an unknown place
    const noPkce = await call('GET /oauth/authorize', { query: { ...base, redirect_uri: 'https://agent.example/cb', code_challenge_method: 'plain' } })
    expect(String(noPkce.headers!.location)).toContain('error=invalid_request')
    expect((await call('POST /oauth/register', { body: JSON.stringify({ redirect_uris: ['http://agent.example/cb'] }) })).statusCode).toBe(400)
    expect((await call('POST /mcp', { body: '{}', headers: { authorization: 'Bearer bn_at_nope' } })).headers!['www-authenticate']).toContain('error="invalid_token"')
    dns.address = '127.0.0.1' // a public-looking name that points at the Lambda itself
    const inside = await call('GET /oauth/authorize', { query: { ...base, client_id: 'https://evil.example/client.json', redirect_uri: 'https://evil.example/cb' } })
    expect(inside.statusCode).toBe(400)
    dns.address = '160.79.104.10'
    const unknownScope = await call('GET /oauth/authorize', { query: { ...base, redirect_uri: 'https://agent.example/cb', scope: 'openid' } })
    const id = /\/connect\/([\w-]+)$/.exec(String(unknownScope.headers!.location))![1]!
    expect(data(await call('GET /api/oauth/requests/{id}', { sub: 'user-1', params: { id } })).scope).toEqual(['notes:read'])
  })
})

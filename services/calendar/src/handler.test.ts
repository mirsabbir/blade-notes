import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as store from './store'
import { handler } from './handler'

vi.mock('./store', () => ({
  getItem: vi.fn(), getMap: vi.fn(), getSettings: vi.fn(), getCal: vi.fn(), listItems: vi.fn(), forgetCal: vi.fn(), putState: vi.fn(),
  takeState: vi.fn(), markCal: vi.fn(), putCal: vi.fn(), putMap: vi.fn(), deleteMap: vi.fn(), seal: vi.fn(), unseal: vi.fn(), oauthApp: vi.fn(),
}))
const m = vi.mocked(store)

const http = (routeKey: string, extra: object = {}) =>
  ({ routeKey, requestContext: { authorizer: { jwt: { claims: { sub: 'u' } } } }, ...extra }) as never

beforeEach(() => {
  process.env.SITE_URL = 'https://n.example'
  m.oauthApp.mockResolvedValue(null)
})
afterEach(() => vi.clearAllMocks())

describe('calendar routes', () => {
  it('sends an expired or unknown state back to the app with words', async () => {
    m.takeState.mockResolvedValue(undefined)
    const res = (await handler({ routeKey: 'GET /api/calendar/callback', queryStringParameters: { code: 'c', state: 's' }, requestContext: {} } as never)) as { statusCode: number; headers: { location: string } }
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toMatch(/^https:\/\/n\.example\/\?calendar-error=That%20sign-in%20link%20has%20expired/)
  })

  it('needs a signed-in user everywhere else', async () => {
    const res = (await handler({ routeKey: 'GET /api/calendar', requestContext: {} } as never)) as { statusCode: number }
    expect(res.statusCode).toBe(401)
  })

  it('says which providers are set up and connected', async () => {
    m.getCal.mockImplementation(async (_s, p) => (p === 'apple' ? { provider: 'apple', calendarId: 'c', secret: 'b', account: 'me@icloud.com' } : undefined))
    const res = (await handler(http('GET /api/calendar'))) as { body: string }
    expect(JSON.parse(res.body).providers).toEqual([
      { provider: 'google', configured: false, connected: false },
      { provider: 'outlook', configured: false, connected: false },
      { provider: 'apple', configured: true, connected: true, account: 'me@icloud.com' },
    ])
  })

  it('refuses to start Google sign-in before the OAuth app exists', async () => {
    const res = (await handler(http('POST /api/calendar/connect', { body: '{"provider":"google"}' }))) as { statusCode: number; body: string }
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toMatch(/not set up/)
  })

  it('starts Google sign-in with a one-time state once it is set up', async () => {
    m.oauthApp.mockResolvedValue({ clientId: 'id', clientSecret: 's' })
    const res = (await handler(http('POST /api/calendar/connect', { body: '{"provider":"google"}' }))) as { body: string }
    const url = new URL(JSON.parse(res.body).url)
    expect(url.origin).toBe('https://accounts.google.com')
    expect(url.searchParams.get('redirect_uri')).toBe('https://n.example/api/calendar/callback')
    expect(url.searchParams.get('scope')).toContain('calendar.app.created')
    expect(m.putState).toHaveBeenCalledWith(url.searchParams.get('state'), 'u', 'google')
  })
})

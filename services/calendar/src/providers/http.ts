/** A failed call to a calendar, with words the Settings page can show as they are. */
export class CalendarError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

/** Worth retrying: rate limits, server errors, and anything that is not a calendar's answer (network, AWS). */
export const transient = (err: unknown): boolean => !(err instanceof CalendarError) || err.status === 429 || err.status >= 500

function words(status: number): string {
  if (status === 401 || status === 403) return 'The calendar refused access. Connect it again in Settings › Calendars.'
  if (status === 404) return 'The Blade Notes calendar is gone. Connect again to make a new one.'
  if (status === 429) return 'The calendar asked to slow down; it will be retried.'
  return `The calendar answered with error ${status}.`
}

export interface Send {
  json?: unknown
  body?: string
  type?: string
  headers?: { [name: string]: string }
  /** Statuses that are an answer, not an error (404 on an upsert that then inserts). */
  ok?: number[]
}

export async function request(method: string, url: string, auth: string, send: Send = {}) {
  const body = send.json === undefined ? send.body : JSON.stringify(send.json)
  const type = send.json === undefined ? send.type : 'application/json'
  const res = await fetch(url, { method, body, headers: { authorization: auth, ...(type && { 'content-type': type }), ...send.headers } })
  const text = await res.text()
  if (!res.ok && !send.ok?.includes(res.status)) throw new CalendarError(words(res.status), res.status)
  return { status: res.status, text, json: () => JSON.parse(text) as { id: string; value?: { id: string; name: string }[] } }
}

export const enc = encodeURIComponent

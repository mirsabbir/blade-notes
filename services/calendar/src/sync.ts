import type { AttributeValue } from '@aws-sdk/client-dynamodb'
import { unmarshall } from '@aws-sdk/util-dynamodb'
import type { DynamoDBBatchResponse, DynamoDBRecord } from 'aws-lambda'
import { addDays, type CalendarProvider, type Item } from '@blade-notes/core'
import { chooseProvider, entryOf, hash, relevant, spaceOf, type Entry } from './entries'
import { accessToken } from './oauth'
import { basic } from './providers/apple'
import { CalendarError, transient } from './providers/http'
import { APIS } from './providers/index'
import {
  deleteMap, getCal, getItem, getMap, getSettings, listItems, markCal, oauthApp, putCal, putMap, seal, unseal,
  type CalRecord, type MapRecord,
} from './store'

export const site = () => process.env.SITE_URL ?? ''

export type Outcome = 'written' | 'removed' | 'skipped' | 'failed'

/** One invocation's reads, each done once: a stream batch often holds many changes of one user. */
export class Run {
  private memo = new Map<string, Promise<unknown>>()
  private once<T>(key: string, make: () => Promise<T>): Promise<T> {
    if (!this.memo.has(key)) this.memo.set(key, make())
    return this.memo.get(key) as Promise<T>
  }
  seed(sub: string, item: Item): void {
    this.memo.set(`item:${sub}:${item.id}`, Promise.resolve(item))
  }
  item = (sub: string, id: string) => this.once(`item:${sub}:${id}`, () => getItem(sub, id))
  settings = (sub: string) => this.once(`settings:${sub}`, () => getSettings(sub))
  cal = (sub: string, p: CalendarProvider) => this.once(`cal:${sub}:${p}`, () => getCal(sub, p))
  auth = (sub: string, p: CalendarProvider) => this.once(`auth:${sub}:${p}`, () => authorize(this, sub, p))

  /** The connected calendar an item's space writes to, if any. */
  async target(sub: string, item: Item): Promise<CalRecord | undefined> {
    const p = chooseProvider(await this.settings(sub), await spaceOf(item, (id) => this.item(sub, id)))
    const rec = p ? await this.cal(sub, p) : undefined
    return rec?.secret ? rec : undefined
  }
}

/** The Authorization header for a connection; stores a rotated refresh token (Microsoft). */
async function authorize(run: Run, sub: string, p: CalendarProvider): Promise<string> {
  const rec = await run.cal(sub, p)
  if (!rec?.secret) throw new CalendarError('Not connected.', 400)
  const secret = await unseal(sub, p, rec.secret)
  if ('password' in secret) return basic(secret.username, secret.password)
  const app = p === 'apple' ? null : await oauthApp(p)
  if (p === 'apple' || !app) throw new CalendarError('Calendar sign-in is no longer set up on the server.', 400)
  const t = await accessToken(p, app, secret.refreshToken)
  if (t.refreshToken !== secret.refreshToken) await putCal(sub, { ...rec, secret: await seal(sub, p, { refreshToken: t.refreshToken }) })
  return `Bearer ${t.token}`
}

/** Runs one calendar call. A refusal is kept on the connection for Settings and not retried; a hiccup throws so the stream retries. */
async function guarded<T>(run: Run, sub: string, p: CalendarProvider, call: (auth: string) => Promise<T>): Promise<T | null> {
  try {
    const value = await call(await run.auth(sub, p))
    await markCal(sub, p, undefined)
    return value
  } catch (err) {
    if (transient(err)) throw err
    await markCal(sub, p, (err as Error).message)
    return null
  }
}

const sameCalendar = (map: MapRecord | undefined, target: CalRecord | undefined) =>
  !!map && !!target && map.provider === target.provider && map.calendarId === target.calendarId

/** Takes an entry off the calendar it was written to. A calendar no longer connected cannot be reached: the record is just forgotten. */
async function unwrite(run: Run, sub: string, id: string, map: MapRecord): Promise<boolean> {
  const rec = await run.cal(sub, map.provider)
  if (rec?.secret && rec.calendarId === map.calendarId) {
    const done = await guarded(run, sub, map.provider, (auth) => APIS[map.provider].remove(auth, map.calendarId, map.externalId).then(() => true))
    if (!done) return false
  }
  await deleteMap(sub, id)
  return true
}

async function write(run: Run, sub: string, id: string, entry: Entry, target: CalRecord, map: MapRecord | undefined): Promise<Outcome> {
  const h = hash(entry)
  if (map?.hash === h) return 'skipped'
  const externalId = await guarded(run, sub, target.provider, (auth) => APIS[target.provider].upsert(auth, target.calendarId, entry, map?.externalId))
  if (externalId === null) return 'failed'
  await putMap(sub, id, { provider: target.provider, calendarId: target.calendarId, externalId, hash: h })
  return 'written'
}

/** What the item should become on a calendar, and which connected calendar that is. */
async function placement(run: Run, sub: string, item: Item | undefined): Promise<{ entry: Entry | null; target?: CalRecord }> {
  if (!item) return { entry: null }
  const entry = entryOf(item, site())
  return { entry, target: entry ? await run.target(sub, item) : undefined }
}

/** Puts one item's entry on its space's calendar, moves it when the calendar changed, or takes it off. */
export async function syncItem(run: Run, sub: string, id: string, item: Item | undefined): Promise<Outcome> {
  const { entry, target } = await placement(run, sub, item)
  const map = await getMap(sub, id)
  if (map && !sameCalendar(map, target) && !(await unwrite(run, sub, id, map))) return 'failed'
  if (!entry || !target) return map ? 'removed' : 'skipped'
  return write(run, sub, id, entry, target, sameCalendar(map, target) ? map : undefined)
}

/** Stream of ITEM# changes. The first change that needs a retry stops the batch there (order matters per item). */
export async function onStream(records: DynamoDBRecord[]): Promise<DynamoDBBatchResponse> {
  const run = new Run()
  const data = (image: unknown) => (image ? (unmarshall(image as { [k: string]: AttributeValue }).data as Item) : undefined)
  for (const r of records) {
    const d = r.dynamodb!
    const item = data(d.NewImage)
    if (!relevant(item) && !relevant(data(d.OldImage))) continue
    const keys = unmarshall(d.Keys as { [k: string]: AttributeValue }) as { pk: string; sk: string }
    try {
      await syncItem(run, keys.pk.slice('USER#'.length), keys.sk.slice('ITEM#'.length), item)
    } catch (err) {
      console.error(err)
      return { batchItemFailures: [{ itemIdentifier: d.SequenceNumber! }] }
    }
  }
  return { batchItemFailures: [] }
}

/** Writes every entry from 30 days ago on: after connecting, or from Settings' "Sync now". */
export async function backfill(sub: string): Promise<{ written: number; removed: number; failed: number }> {
  const run = new Run()
  const items = await listItems(sub)
  items.forEach((i) => run.seed(sub, i))
  const since = addDays(new Date().toISOString().slice(0, 10), -30)
  const todo = items.filter((i) => (entryOf(i, site())?.at.slice(0, 10) ?? '') >= since)
  const counts = { written: 0, removed: 0, failed: 0, skipped: 0 }
  let next = 0
  const worker = async () => {
    while (next < todo.length) {
      const item = todo[next++]!
      const outcome = await syncItem(run, sub, item.id, item).catch((err: unknown) => (console.error(err), 'failed' as const))
      counts[outcome]++
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()])
  return { written: counts.written, removed: counts.removed, failed: counts.failed }
}

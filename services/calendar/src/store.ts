import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { DecryptCommand, EncryptCommand, KMSClient } from '@aws-sdk/client-kms'
import { GetParameterCommand, ParameterNotFound, SSMClient } from '@aws-sdk/client-ssm'
import { DEFAULT_SETTINGS, type CalendarProvider, type Item, type Settings } from '@blade-notes/core'
import type { OAuthApp, OAuthProvider } from './oauth'

/**
 * Records next to the user's notes (pk = USER#<sub>), none with a `seq`, so they never reach
 * devices through sync:  CAL#<provider> (connection), CALMAP#<itemId> (where an entry was written).
 * CALSTATE#<state> is its own partition: the OAuth callback knows only the state.
 */
export interface CalRecord {
  provider: CalendarProvider
  calendarId: string
  account?: string
  /** KMS ciphertext (base64) of a Secret; absent once disconnected (the calendar id stays for a reconnect). */
  secret?: string
  connectedAt?: string
  lastSyncAt?: string
  lastError?: string
}
export interface MapRecord {
  provider: CalendarProvider
  calendarId: string
  externalId: string
  hash: string
}
export type Secret = { refreshToken: string } | { username: string; password: string }

const TABLE = () => process.env.TABLE_NAME!
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } })
const kms = new KMSClient({})
const ssm = new SSMClient({})
const pk = (sub: string) => `USER#${sub}`
const now = () => new Date().toISOString()

async function get(key: { pk: string; sk: string }) {
  return (await db.send(new GetCommand({ TableName: TABLE(), Key: key }))).Item
}

export const getItem = async (sub: string, id: string) => (await get({ pk: pk(sub), sk: `ITEM#${id}` }))?.data as Item | undefined

export async function listItems(sub: string): Promise<Item[]> {
  const out: Item[] = []
  let start: { [k: string]: unknown } | undefined
  do {
    const res = await db.send(new QueryCommand({
      TableName: TABLE(),
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :item)',
      ExpressionAttributeValues: { ':pk': pk(sub), ':item': 'ITEM#' },
      ExclusiveStartKey: start,
    }))
    out.push(...(res.Items ?? []).map((r) => r.data as Item))
    start = res.LastEvaluatedKey
  } while (start)
  return out
}

export const getSettings = async (sub: string): Promise<Settings> => ({ ...DEFAULT_SETTINGS, ...(await get({ pk: pk(sub), sk: 'SETTINGS#settings' }))?.data })

export const getCal = async (sub: string, p: CalendarProvider) => (await get({ pk: pk(sub), sk: `CAL#${p}` })) as CalRecord | undefined

export async function putCal(sub: string, rec: CalRecord): Promise<void> {
  await db.send(new PutCommand({ TableName: TABLE(), Item: { pk: pk(sub), sk: `CAL#${rec.provider}`, ...rec } }))
}

/** After a write: a success clears the last error, a refusal is kept in words for Settings. */
export async function markCal(sub: string, p: CalendarProvider, error?: string): Promise<void> {
  const update = error
    ? { UpdateExpression: 'SET lastError = :v', ExpressionAttributeValues: { ':v': error } }
    : { UpdateExpression: 'SET lastSyncAt = :v REMOVE lastError', ExpressionAttributeValues: { ':v': now() } }
  try {
    await db.send(new UpdateCommand({ TableName: TABLE(), Key: { pk: pk(sub), sk: `CAL#${p}` }, ConditionExpression: 'attribute_exists(pk)', ...update }))
  } catch (err) {
    if (!(err instanceof ConditionalCheckFailedException)) throw err // disconnected meanwhile: nothing to mark
  }
}

export async function forgetCal(sub: string, p: CalendarProvider): Promise<void> {
  await db.send(new UpdateCommand({
    TableName: TABLE(),
    Key: { pk: pk(sub), sk: `CAL#${p}` },
    UpdateExpression: 'REMOVE secret, account, connectedAt, lastSyncAt, lastError',
  }))
}

export const getMap = async (sub: string, id: string) => (await get({ pk: pk(sub), sk: `CALMAP#${id}` })) as MapRecord | undefined

export async function putMap(sub: string, id: string, map: MapRecord): Promise<void> {
  await db.send(new PutCommand({ TableName: TABLE(), Item: { pk: pk(sub), sk: `CALMAP#${id}`, ...map } }))
}

export async function deleteMap(sub: string, id: string): Promise<void> {
  await db.send(new DeleteCommand({ TableName: TABLE(), Key: { pk: pk(sub), sk: `CALMAP#${id}` } }))
}

/** OAuth state, good for 10 minutes (DynamoDB's TTL deletes it later; the check here is exact). */
export async function putState(state: string, sub: string, provider: OAuthProvider): Promise<void> {
  const ttl = Math.floor(Date.now() / 1000) + 600
  await db.send(new PutCommand({ TableName: TABLE(), Item: { pk: `CALSTATE#${state}`, sk: 'CALSTATE', sub, provider, ttl } }))
}

/** Reads and deletes in one step, so a state works once. */
export async function takeState(state: string): Promise<{ sub: string; provider: OAuthProvider } | undefined> {
  const res = await db.send(new DeleteCommand({ TableName: TABLE(), Key: { pk: `CALSTATE#${state}`, sk: 'CALSTATE' }, ReturnValues: 'ALL_OLD' }))
  const old = res.Attributes
  return old && old.ttl > Date.now() / 1000 ? { sub: old.sub, provider: old.provider } : undefined
}

/** Encrypted with the app's KMS key, bound to this user and provider (a copied blob will not decrypt elsewhere). */
export async function seal(sub: string, p: CalendarProvider, secret: Secret): Promise<string> {
  const res = await kms.send(new EncryptCommand({ KeyId: process.env.KEY_ID, Plaintext: Buffer.from(JSON.stringify(secret)), EncryptionContext: { sub, provider: p } }))
  return Buffer.from(res.CiphertextBlob!).toString('base64')
}

export async function unseal(sub: string, p: CalendarProvider, blob: string): Promise<Secret> {
  const res = await kms.send(new DecryptCommand({ KeyId: process.env.KEY_ID, CiphertextBlob: Buffer.from(blob, 'base64'), EncryptionContext: { sub, provider: p } }))
  return JSON.parse(Buffer.from(res.Plaintext!).toString()) as Secret
}

const apps = new Map<OAuthProvider, { app: OAuthApp | null; until: number }>()
const PARAM = { google: 'GOOGLE_PARAM', outlook: 'MICROSOFT_PARAM' } as const

/** The OAuth client from SSM; null until it is set up there. Re-read every 5 minutes so a new one shows up. */
export async function oauthApp(p: OAuthProvider): Promise<OAuthApp | null> {
  const hit = apps.get(p)
  if (hit && hit.until > Date.now()) return hit.app
  let app: OAuthApp | null = null
  try {
    const res = await ssm.send(new GetParameterCommand({ Name: process.env[PARAM[p]], WithDecryption: true }))
    app = JSON.parse(res.Parameter!.Value!) as OAuthApp
  } catch (err) {
    if (!(err instanceof ParameterNotFound)) throw err
  }
  apps.set(p, { app, until: Date.now() + 5 * 60_000 })
  return app
}

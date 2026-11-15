import { DynamoDBClient, ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { tooLarge, type Body, type Change, type PullResponse, type PushRequest, type PushResponse, type Record } from '@blade-notes/core'

/**
 * One table, one partition per user:
 *   pk = USER#<sub>, sk = ITEM#<id> | BODY#<id> | SETTINGS#settings | META#counter
 * Every write takes the next `seq` from the counter; the `bySeq` index (pk, seq)
 * answers "what changed after N", which is the whole sync protocol.
 */
export const TABLE = process.env.TABLE_NAME!
const PAGE = 500
const MAX_CHANGES = 200

export const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } })

/** A request the client must fix; the API answers 400 with the message. */
export class BadRequest extends Error {}

export async function pull(pk: string, since: number): Promise<PullResponse> {
  if (!Number.isFinite(since) || since < 0) throw new BadRequest('since must be a number ≥ 0')
  const res = await db.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: 'bySeq',
      KeyConditionExpression: 'pk = :pk AND seq > :since',
      ExpressionAttributeValues: { ':pk': pk, ':since': since },
      Limit: PAGE,
    }),
  )
  const records: Record[] = (res.Items ?? []).map((r) => ({ kind: r.kind, seq: r.seq, data: fromStored(r.kind, r.data) }) as Record)
  return { records, cursor: records.at(-1)?.seq ?? since, more: res.LastEvaluatedKey !== undefined }
}

/** Reserves `count` seq numbers and returns the first one. */
export async function reserve(pk: string, count: number): Promise<number> {
  const res = await db.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk, sk: 'META#counter' },
      UpdateExpression: 'ADD n :c',
      ExpressionAttributeValues: { ':c': count },
      ReturnValues: 'UPDATED_NEW',
    }),
  )
  return (res.Attributes!.n as number) - count + 1
}

export async function push(pk: string, req: PushRequest): Promise<PushResponse> {
  const changes = req.changes
  if (!Array.isArray(changes) || changes.length > MAX_CHANGES) throw new BadRequest(`changes must be a list of at most ${MAX_CHANGES}`)
  for (const c of changes) validate(c)
  const out: PushResponse = { accepted: [], conflicts: [], rejected: [] }
  // A change that is too large is turned away on its own; the rest of the request still saves.
  const fits = changes.filter((c) => {
    const reason = tooLarge(c)
    if (reason) out.rejected!.push({ kind: c.kind, id: c.data.id, reason })
    return !reason
  })
  if (fits.length === 0) return out
  let seq = await reserve(pk, fits.length)
  for (const c of fits) {
    const mine = seq++
    const sk = `${c.kind.toUpperCase()}#${c.data.id}`
    const put = new PutCommand({
      TableName: TABLE,
      Item: { pk, sk, seq: mine, kind: c.kind, data: toStored(c) },
      // A body only overwrites the version its edit started from; items are last-write-wins.
      ...(c.kind === 'body' && {
        ConditionExpression: 'attribute_not_exists(seq) OR seq <= :base',
        ExpressionAttributeValues: { ':base': c.baseSeq },
      }),
      // Deleted for good stays deleted: an edit or a restore from a device that has not heard yet loses.
      ...(c.kind === 'item' && !c.data.purgedAt && { ConditionExpression: 'attribute_not_exists(#d.purgedAt)', ExpressionAttributeNames: { '#d': 'data' } }),
    })
    try {
      await db.send(put)
      out.accepted.push({ kind: c.kind, id: c.data.id, seq: mine })
    } catch (err) {
      // DynamoDB's own limits (400 KB per item) back up tooLarge(): still only this change fails.
      if ((err as Error).name === 'ValidationException') {
        out.rejected!.push({ kind: c.kind, id: c.data.id, reason: 'the database refused it as too large.' })
        continue
      }
      if (!(err instanceof ConditionalCheckFailedException)) throw err
      // An item refused over its tombstone: the device drops its copy when its pull brings the tombstone.
      if (c.kind === 'item') continue
      const current = await db.send(new GetCommand({ TableName: TABLE, Key: { pk, sk } }))
      out.conflicts.push({ id: c.data.id, server: fromStored('body', current.Item!.data) as Body, seq: current.Item!.seq as number })
    }
  }
  return out
}

/**
 * A body's document is stored as a JSON string: DynamoDB allows only 32 levels of
 * nested maps/lists, and a Tiptap doc with deeply nested lists goes past that.
 */
export function toStored(c: Change) {
  return c.kind === 'body' ? { ...c.data, doc: JSON.stringify(c.data.doc) } : c.data
}

export function fromStored(kind: string, data: { doc?: unknown }) {
  return kind === 'body' && typeof data.doc === 'string' ? { ...data, doc: JSON.parse(data.doc) } : data
}

function validate(c: Change): void {
  const id = c?.data?.id
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new BadRequest('each change needs a safe id')
  if (c.kind === 'body') {
    if (typeof c.baseSeq !== 'number') throw new BadRequest('a body change needs baseSeq')
  } else if (c.kind === 'settings') {
    if (id !== 'settings') throw new BadRequest('the settings record has id "settings"')
  } else if (c.kind !== 'item') {
    throw new BadRequest('kind must be item, body or settings')
  }
}

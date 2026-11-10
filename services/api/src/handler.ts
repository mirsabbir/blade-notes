import { randomUUID } from 'node:crypto'
import { DynamoDBClient, ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { APIGatewayProxyEventV2WithJWTAuthorizer as Event, APIGatewayProxyResultV2 as Result } from 'aws-lambda'
import type { Body, Change, PullResponse, PushRequest, PushResponse, Record } from '@blade-notes/core'

/**
 * One table, one partition per user:
 *   pk = USER#<sub>, sk = ITEM#<id> | BODY#<id> | META#counter
 * Every write takes the next `seq` from the counter; the `bySeq` index (pk, seq)
 * answers "what changed after N", which is the whole sync protocol.
 */
const TABLE = process.env.TABLE_NAME!
const BUCKET = process.env.FILES_BUCKET!
const PAGE = 500
const MAX_CHANGES = 200

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } })
const s3 = new S3Client({})

const json = (statusCode: number, body: unknown): Result => ({
  statusCode,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: JSON.stringify(body),
})

export async function handler(event: Event): Promise<Result> {
  const route = event.routeKey
  try {
    // No login on this route: an <img> tag cannot send a token. The URL holds a random UUID, which is the key.
    if (route === 'GET /api/files/{owner}/{name}') return await file(event.pathParameters?.owner ?? '', event.pathParameters?.name ?? '')
    const sub = event.requestContext.authorizer?.jwt?.claims?.sub
    if (typeof sub !== 'string') return json(401, { error: 'no user' })
    const pk = `USER#${sub}`
    if (route === 'GET /api/sync') return json(200, await pull(pk, Number(event.queryStringParameters?.since ?? 0)))
    if (route === 'POST /api/sync') return json(200, await push(pk, parse<PushRequest>(event)))
    if (route === 'POST /api/uploads') return json(200, await upload(sub, parse<{ contentType?: string }>(event)))
    return json(404, { error: 'not found' })
  } catch (err) {
    if (err instanceof BadRequest) return json(400, { error: err.message })
    console.error(err)
    return json(500, { error: 'internal error' })
  }
}

class BadRequest extends Error {}

function parse<T>(event: Event): T {
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString() : event.body
    return JSON.parse(raw ?? '{}') as T
  } catch {
    throw new BadRequest('body is not JSON')
  }
}

async function pull(pk: string, since: number): Promise<PullResponse> {
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
async function reserve(pk: string, count: number): Promise<number> {
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

async function push(pk: string, req: PushRequest): Promise<PushResponse> {
  const changes = req.changes
  if (!Array.isArray(changes) || changes.length > MAX_CHANGES) throw new BadRequest(`changes must be a list of at most ${MAX_CHANGES}`)
  for (const c of changes) validate(c)
  const out: PushResponse = { accepted: [], conflicts: [] }
  if (changes.length === 0) return out
  let seq = await reserve(pk, changes.length)
  for (const c of changes) {
    const mine = seq++
    const sk = `${c.kind === 'item' ? 'ITEM' : 'BODY'}#${c.data.id}`
    const put = new PutCommand({
      TableName: TABLE,
      Item: { pk, sk, seq: mine, kind: c.kind, data: c.kind === 'body' ? { ...c.data, doc: JSON.stringify(c.data.doc) } : c.data },
      // A body only overwrites the version its edit started from; items are last-write-wins.
      ...(c.kind === 'body' && {
        ConditionExpression: 'attribute_not_exists(seq) OR seq <= :base',
        ExpressionAttributeValues: { ':base': c.baseSeq },
      }),
    })
    try {
      await db.send(put)
      out.accepted.push({ kind: c.kind, id: c.data.id, seq: mine })
    } catch (err) {
      if (!(err instanceof ConditionalCheckFailedException)) throw err
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
function fromStored(kind: string, data: { doc?: unknown }) {
  return kind === 'body' && typeof data.doc === 'string' ? { ...data, doc: JSON.parse(data.doc) } : data
}

function validate(c: Change): void {
  const id = c?.data?.id
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new BadRequest('each change needs a safe id')
  if (c.kind === 'body') {
    if (typeof c.baseSeq !== 'number') throw new BadRequest('a body change needs baseSeq')
    if (JSON.stringify(c.data).length > 350_000) throw new BadRequest(`body ${id} is over 350 kB; move images to uploads`)
  } else if (c.kind !== 'item') {
    throw new BadRequest('kind must be item or body')
  }
}

const IMAGE_TYPES: { [k: string]: string } = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }

async function upload(sub: string, req: { contentType?: string }) {
  const ext = IMAGE_TYPES[req.contentType ?? '']
  if (!ext) throw new BadRequest('only png, jpeg, webp or gif images')
  const key = `${randomUUID()}.${ext}`
  const url = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: BUCKET, Key: `users/${sub}/${key}`, ContentType: req.contentType }),
    { expiresIn: 300 },
  )
  return { uploadUrl: url, src: `/api/files/${sub}/${key}` }
}

async function file(owner: string, name: string): Promise<Result> {
  if (!/^[0-9a-f-]{36}$/.test(owner) || !/^[0-9a-f-]{36}\.(png|jpg|webp|gif)$/.test(name)) return json(404, { error: 'not found' })
  const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: `users/${owner}/${name}` }), { expiresIn: 3600 })
  return { statusCode: 302, headers: { location: url, 'cache-control': 'private, max-age=3000' } }
}

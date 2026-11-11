import { randomUUID } from 'node:crypto'
import { DynamoDBClient, ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { createPresignedPost } from '@aws-sdk/s3-presigned-post'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { APIGatewayProxyEventV2WithJWTAuthorizer as Event, APIGatewayProxyResultV2 as Result } from 'aws-lambda'
import { tooLarge, type Body, type Change, type PullResponse, type PushRequest, type PushResponse, type Record } from '@blade-notes/core'

/**
 * One table, one partition per user:
 *   pk = USER#<sub>, sk = ITEM#<id> | BODY#<id> | SETTINGS#settings | META#counter
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
    const sub = event.requestContext.authorizer?.jwt?.claims?.sub
    if (typeof sub !== 'string') return json(401, { error: 'no user' })
    const pk = `USER#${sub}`
    if (route === 'GET /api/files/{owner}/{name}')
      return await file(sub, event.pathParameters?.owner ?? '', event.pathParameters?.name ?? '', event.queryStringParameters?.name)
    if (route === 'GET /api/sync') return json(200, await pull(pk, Number(event.queryStringParameters?.since ?? 0)))
    if (route === 'POST /api/sync') return json(200, await push(pk, parse<PushRequest>(event)))
    if (route === 'POST /api/uploads') return json(200, await upload(sub, parse<{ contentType?: string; name?: string; size?: number }>(event)))
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

const MAX_FILE = 50 * 1024 * 1024
const FILE_NAME = /^[0-9a-f-]{36}\.[a-z0-9]{1,10}$/

/**
 * Any file type, up to 50 MB: S3 itself enforces the size through the POST policy.
 * The key keeps only a short lower-case extension from the original name.
 */
async function upload(sub: string, req: { contentType?: string; name?: string; size?: number }) {
  if (typeof req.size !== 'number' || req.size <= 0 || req.size > MAX_FILE) throw new BadRequest('files must be 1 byte to 50 MB')
  const ext = /\.([a-z0-9]{1,10})$/i.exec(req.name ?? '')?.[1]?.toLowerCase() ?? 'bin'
  const base = /^[\w.+-]+\/[\w.+-]+$/.test(req.contentType ?? '') ? req.contentType! : 'application/octet-stream'
  // Text files are UTF-8 here; without the charset a browser may show them garbled when opened in place.
  const contentType = base.startsWith('text/') ? `${base}; charset=utf-8` : base
  const key = `${randomUUID()}.${ext}`
  const post = await createPresignedPost(s3, {
    Bucket: BUCKET,
    Key: `users/${sub}/${key}`,
    Fields: { 'Content-Type': contentType },
    Conditions: [['content-length-range', 1, MAX_FILE], ['eq', '$Content-Type', contentType]],
    Expires: 600,
  })
  return { upload: post, src: `/api/files/${sub}/${key}` }
}

/**
 * A signed S3 link to one of the caller's own files, valid for 60 seconds; the app fetches it
 * at once and shows the file from memory. `?name=` makes it a download with that file name.
 */
async function file(sub: string, owner: string, key: string, downloadName?: string): Promise<Result> {
  if (owner !== sub || !FILE_NAME.test(key)) return json(404, { error: 'not found' })
  const disposition = downloadName ? `attachment; filename*=UTF-8''${encodeURIComponent(downloadName.slice(0, 200))}` : undefined
  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: BUCKET, Key: `users/${owner}/${key}`, ResponseContentDisposition: disposition, ResponseCacheControl: 'no-store' }),
    { expiresIn: 60 },
  )
  return json(200, { url })
}

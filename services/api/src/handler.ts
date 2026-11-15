import { randomUUID } from 'node:crypto'
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { createPresignedPost } from '@aws-sdk/s3-presigned-post'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { APIGatewayProxyEventV2WithJWTAuthorizer as Event, APIGatewayProxyResultV2 as Result } from 'aws-lambda'
import type { PushRequest } from '@blade-notes/core'
import { BadRequest, pull, push } from './sync'

/** The app's API: sync (sync.ts), uploads and files. */
export const BUCKET = process.env.FILES_BUCKET!
export const s3 = new S3Client({})

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

function parse<T>(event: Event): T {
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString() : event.body
    return JSON.parse(raw ?? '{}') as T
  } catch {
    throw new BadRequest('body is not JSON')
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

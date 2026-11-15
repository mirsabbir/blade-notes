import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb'
import { DeleteObjectCommand } from '@aws-sdk/client-s3'
import { DeleteCommand, PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb'
import { applyPurge, cleanup, expiredPlan, type Item } from '@blade-notes/core'
import { BUCKET, s3 } from './handler'
import { TABLE, db, reserve } from './sync'

/**
 * Once a day (an EventBridge schedule): deletes for good what has been in the trash for
 * TRASH_DAYS, then frees what deleting for good left behind, the tombstones' text and the
 * files nothing else uses (core `cleanup`). Every step is safe to repeat, so whatever one
 * run leaves undone, the next one finishes.
 */
export async function purge(): Promise<{ users: number; purged: number; files: number }> {
  const totals = { users: 0, purged: 0, files: 0 }
  for (const pk of await users()) {
    const done = await purgeUser(pk, Date.now())
    totals.users++
    totals.purged += done.purged
    totals.files += done.files
  }
  console.log(JSON.stringify(totals))
  return totals
}

async function users(): Promise<string[]> {
  const out: string[] = []
  let start: { [k: string]: unknown } | undefined
  do {
    const res = await db.send(
      new ScanCommand({ TableName: TABLE, FilterExpression: 'sk = :c', ExpressionAttributeValues: { ':c': 'META#counter' }, ProjectionExpression: 'pk', ExclusiveStartKey: start }),
    )
    for (const r of res.Items ?? []) out.push(r.pk as string)
    start = res.LastEvaluatedKey
  } while (start)
  return out
}

interface Library {
  items: { [id: string]: Item }
  /** The seq each item was read at: a write only lands if nobody wrote the item since. */
  seqs: { [id: string]: number }
  /** Each body's stored text (the document as a JSON string). */
  bodies: { [id: string]: string }
}

async function load(pk: string): Promise<Library> {
  const lib: Library = { items: {}, seqs: {}, bodies: {} }
  let start: { [k: string]: unknown } | undefined
  do {
    const res = await db.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': pk }, ExclusiveStartKey: start }))
    for (const r of res.Items ?? []) {
      if (r.kind === 'item') {
        lib.items[r.data.id] = r.data as Item
        lib.seqs[r.data.id] = r.seq as number
      } else if (r.kind === 'body') {
        lib.bodies[r.data.id] = typeof r.data.doc === 'string' ? r.data.doc : JSON.stringify(r.data.doc ?? null)
      }
    }
    start = res.LastEvaluatedKey
  } while (start)
  return lib
}

async function purgeUser(pk: string, now: number): Promise<{ purged: number; files: number }> {
  const lib = await load(pk)
  const purged = await save(pk, lib, applyPurge(lib.items, expiredPlan(lib.items, now), new Date(now).toISOString()))
  const work = cleanup(lib.items, lib.bodies)
  const owner = pk.slice('USER#'.length)
  for (const src of work.files) {
    const m = /^\/api\/files\/([\w-]+)\/([\w.-]+)$/.exec(src)
    if (m?.[1] !== owner) continue // only ever this user's own files
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: `users/${owner}/${m[2]}` }))
  }
  for (const id of work.bodies) await db.send(new DeleteCommand({ TableName: TABLE, Key: { pk, sk: `BODY#${id}` } }))
  // Only now drop the file addresses the tombstones kept: if a delete above failed, the next run retries it.
  await save(pk, lib, work.items)
  return { purged, files: work.files.length }
}

/** Stores changed items under fresh seqs, each only if nobody wrote it since it was read. */
async function save(pk: string, lib: Library, changed: Item[]): Promise<number> {
  if (!changed.length) return 0
  let seq = await reserve(pk, changed.length)
  let saved = 0
  for (const it of changed) {
    const mine = seq++
    try {
      await db.send(
        new PutCommand({
          TableName: TABLE,
          Item: { pk, sk: `ITEM#${it.id}`, seq: mine, kind: 'item', data: it },
          ConditionExpression: 'seq = :read',
          ExpressionAttributeValues: { ':read': lib.seqs[it.id] },
        }),
      )
      lib.items[it.id] = it
      lib.seqs[it.id] = mine
      saved++
    } catch (err) {
      if (!(err instanceof ConditionalCheckFailedException)) throw err // edited meanwhile: the next run looks again
    }
  }
  return saved
}

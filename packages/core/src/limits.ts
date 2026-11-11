import type { Change } from './types'

/**
 * Size limits, in UTF-8 bytes — what DynamoDB stores and counts against its 400 KB item limit.
 * Counting characters is wrong: "ক" is one character but 3 bytes, "😀" is 2 UTF-16 units but 4 bytes.
 */
export const MAX_BODY_BYTES = 350_000
export const MAX_ITEM_BYTES = 100_000
export const MAX_TITLE_CHARS = 500

const encoder = new TextEncoder()
export const utf8Bytes = (s: string): number => encoder.encode(s).length

/** Why the server will not store this change, or null when it fits. */
export function tooLarge(c: Change): string | null {
  const bytes = utf8Bytes(JSON.stringify(c.data))
  if (c.kind === 'body' && bytes > MAX_BODY_BYTES)
    return `the text is ${Math.ceil(bytes / 1000)} kB; the limit is ${MAX_BODY_BYTES / 1000} kB. Split it into more notes, or move images and files into attachments.`
  if (c.kind !== 'body' && bytes > MAX_ITEM_BYTES) return `this record is ${Math.ceil(bytes / 1000)} kB; the limit is ${MAX_ITEM_BYTES / 1000} kB.`
  if (c.kind === 'item' && [...c.data.title].length > MAX_TITLE_CHARS) return `the title is longer than ${MAX_TITLE_CHARS} characters.`
  return null
}

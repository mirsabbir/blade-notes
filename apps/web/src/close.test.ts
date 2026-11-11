import { describe, expect, it, vi } from 'vitest'

vi.mock('./auth', () => ({ accessToken: async () => 'token' }))
vi.mock('idb-keyval', () => ({ get: async () => undefined, set: async () => {} }))

let answer: ((r: Response) => void) | null = null
vi.stubGlobal('fetch', () => new Promise<Response>((resolve) => (answer = resolve)))

const { closeWarning, onFlush, uploadFile, uploadWarning } = await import('./store')

describe('closing the app', () => {
  it('saves pending editor text first', () => {
    const flush = vi.fn()
    const off = onFlush(flush)
    closeWarning()
    expect(flush).toHaveBeenCalledOnce()
    off()
  })

  it('warns while a file uploads, and not after', async () => {
    expect(uploadWarning()).toBeNull()
    const done = uploadFile(new File(['x'], 'a.txt', { type: 'text/plain' })).catch(() => undefined)
    expect(uploadWarning()).toBe('A file is still uploading. Closing now cancels it.')
    expect(closeWarning()).toBe('A file is still uploading. Closing now cancels it.')
    await vi.waitFor(() => expect(answer).not.toBeNull())
    answer!(new Response('{}', { status: 500 })) // the upload fails: nothing in flight any more
    await done
    expect(uploadWarning()).toBeNull()
  })
})

import { useSyncExternalStore } from 'react'
import type { VaultHeader } from '@blade-notes/core'
import { currentState, settingsOf, useStore } from './store'

/**
 * The vault behind Secret blocks: your own key. A random AES-256 data key encrypts each secret
 * in the browser. Settings hold that key only wrapped twice, by a key derived from the passphrase
 * (PBKDF2-SHA-256) and by the one-time recovery key, so the server, AWS and every backup see
 * ciphertext only. Unlocked, the data key lives in this tab's memory as a non-extractable CryptoKey;
 * its raw bytes exist only inside the function that unwraps them and are zeroed right after.
 */

export const ITERATIONS = 600_000
const IDLE_MS = 5 * 60_000
const subtle = () => globalThis.crypto.subtle
const enc = new TextEncoder()
const dec = new TextDecoder()
type Bytes = Uint8Array<ArrayBuffer>

const random = (n: number): Bytes => globalThis.crypto.getRandomValues(new Uint8Array(n))
function b64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

async function seal(key: CryptoKey, data: Bytes): Promise<Bytes> {
  const iv = random(12)
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, key, data))
  const out = new Uint8Array(12 + ct.length)
  out.set(iv)
  out.set(ct, 12)
  return out
}
async function unseal(key: CryptoKey, sealed: Bytes): Promise<Bytes> {
  return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: sealed.slice(0, 12) }, key, sealed.slice(12)))
}

const aesKey = (raw: Bytes) => subtle().importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])

async function passKey(passphrase: string, salt: Bytes, iterations: number): Promise<CryptoKey> {
  const base = await subtle().importKey('raw', enc.encode(passphrase.normalize('NFC')), 'PBKDF2', false, ['deriveKey'])
  return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

// ---- recovery key: 32 random bytes as Crockford base32 (no I, L, O, U), in groups of four ----

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function toRecoveryCode(bytes: Uint8Array): string {
  let out = ''
  let bits = 0
  let value = 0
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    for (; bits >= 5; bits -= 5) out += ALPHABET[(value >>> (bits - 5)) & 31]
    value &= (1 << bits) - 1
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out.match(/.{1,4}/g)!.join('-')
}

/** Forgiving about case, dashes, spaces and look-alikes (I, L → 1; O → 0). Null when it cannot be a code. */
export function fromRecoveryCode(code: string): Bytes | null {
  const s = code.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0')
  if (s.length !== 52) return null
  const out: number[] = []
  let bits = 0
  let value = 0
  for (const ch of s) {
    const v = ALPHABET.indexOf(ch)
    if (v < 0) return null
    value = (value << 5) | v
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
      value &= (1 << bits) - 1
    }
  }
  return new Uint8Array(out.slice(0, 32))
}

// ---- session ----

let key: CryptoKey | null = null
let idle: ReturnType<typeof setTimeout> | undefined
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

/** Any key press or click while unlocked pushes the auto-lock back by five minutes. */
function touch() {
  clearTimeout(idle)
  if (key) idle = setTimeout(lock, IDLE_MS)
}
if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', touch, true)
  window.addEventListener('keydown', touch, true)
}

async function start(raw: Bytes): Promise<true> {
  key = await aesKey(raw)
  raw.fill(0)
  touch()
  emit()
  return true
}

export function lock(): void {
  clearTimeout(idle)
  if (!key) return
  key = null
  emit()
}

export const isUnlocked = (): boolean => key !== null
export const storedHeader = (): VaultHeader | undefined => settingsOf(currentState()).vault
export const hasVault = (): boolean => storedHeader() !== undefined

export function onVaultChange(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** Whether a vault exists (synced in Settings) and whether this tab has it open. */
export function useVault(): { set: boolean; unlocked: boolean } {
  const { state } = useStore()
  const unlocked = useSyncExternalStore(onVaultChange, isUnlocked)
  return { set: settingsOf(state).vault !== undefined, unlocked }
}

/** Makes a vault and leaves it unlocked. The caller saves `header`; `recoveryKey` is shown once. */
export async function createVault(passphrase: string, iterations = ITERATIONS): Promise<{ header: VaultHeader; recoveryKey: string }> {
  const dek = random(32)
  const salt = random(16)
  const recovery = random(32)
  const header: VaultHeader = {
    v: 1,
    salt: b64(salt),
    iterations,
    wrapped: b64(await seal(await passKey(passphrase, salt, iterations), dek)),
    recovery: b64(await seal(await aesKey(recovery), dek)),
    createdAt: new Date().toISOString(),
  }
  const recoveryKey = toRecoveryCode(recovery)
  recovery.fill(0)
  await start(dek)
  return { header, recoveryKey }
}

/** The raw data key, opened with the passphrase or the recovery key; null when neither fits. */
async function openDataKey(secret: string, header: VaultHeader): Promise<Bytes | null> {
  const code = fromRecoveryCode(secret)
  try {
    if (code) return await unseal(await aesKey(code), unb64(header.recovery))
  } catch {
    /* not the recovery key: maybe a passphrase that happens to look like one */
  }
  try {
    return await unseal(await passKey(secret, unb64(header.salt), header.iterations), unb64(header.wrapped))
  } catch {
    return null
  }
}

/** Opens the vault with the passphrase or the recovery key. A wrong one gives false, never an error. */
export async function unlock(secret: string, header: VaultHeader | undefined = storedHeader()): Promise<boolean> {
  if (!header) return false
  const raw = await openDataKey(secret, header)
  return raw ? start(raw) : false
}

/**
 * A new passphrase, given the current one or the recovery key. Returns the header to save
 * (fresh salt, same recovery wrap), or null when `secret` does not open the vault. Leaves it unlocked.
 */
export async function resetPassphrase(secret: string, passphrase: string, header: VaultHeader | undefined = storedHeader()): Promise<VaultHeader | null> {
  if (!header) return null
  const raw = await openDataKey(secret, header)
  if (!raw) return null
  const salt = random(16)
  const wrapped = b64(await seal(await passKey(passphrase, salt, header.iterations), raw))
  await start(raw)
  return { ...header, salt: b64(salt), wrapped }
}

export async function encryptText(plain: string): Promise<string> {
  if (!key) throw new Error('The vault is locked.')
  touch()
  return `v1:${b64(await seal(key, enc.encode(plain)))}`
}

export async function decryptText(data: string): Promise<string> {
  if (!key) throw new Error('The vault is locked.')
  if (!data.startsWith('v1:')) throw new Error('This secret is not in a format Blade Notes knows.')
  touch()
  try {
    return dec.decode(await unseal(key, unb64(data.slice(3))))
  } catch {
    throw new Error('This secret is damaged, or was made with another vault.')
  }
}

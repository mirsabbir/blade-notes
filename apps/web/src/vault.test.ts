import { afterEach, describe, expect, it } from 'vitest'
import { createVault, decryptText, encryptText, fromRecoveryCode, isUnlocked, lock, resetPassphrase, toRecoveryCode, unlock } from './vault'

// Real PBKDF2 uses 600,000 rounds; a few are enough to test the logic.
const FAST = 1000

afterEach(lock)

describe('vault', () => {
  it('encrypts and decrypts text, including non-Latin text', async () => {
    await createVault('correct horse battery', FAST)
    const data = await encryptText('ব্যাংক PIN 4821 😀')
    expect(data.startsWith('v1:')).toBe(true)
    expect(data).not.toContain('4821')
    expect(await decryptText(data)).toBe('ব্যাংক PIN 4821 😀')
  })

  it('opens again with the passphrase, and refuses a wrong one without throwing', async () => {
    const { header } = await createVault('correct horse battery', FAST)
    const data = await encryptText('secret')
    lock()
    expect(await unlock('wrong horse battery', header)).toBe(false)
    expect(isUnlocked()).toBe(false)
    expect(await unlock('correct horse battery', header)).toBe(true)
    expect(await decryptText(data)).toBe('secret')
  })

  it('opens with the recovery key, typed sloppily', async () => {
    const { header, recoveryKey } = await createVault('correct horse battery', FAST)
    const data = await encryptText('secret')
    lock()
    const sloppy = recoveryKey.toLowerCase().replace(/-/g, ' ')
    expect(await unlock(sloppy, header)).toBe(true)
    expect(await decryptText(data)).toBe('secret')
  })

  it('changes the passphrase: the old one stops working, the new one and the recovery key work', async () => {
    const { header, recoveryKey } = await createVault('first passphrase', FAST)
    const data = await encryptText('secret')
    const next = await resetPassphrase(recoveryKey, 'second passphrase', header)
    expect(next).not.toBeNull()
    lock()
    expect(await unlock('first passphrase', next!)).toBe(false)
    expect(await unlock('second passphrase', next!)).toBe(true)
    expect(await decryptText(data)).toBe('secret')
    lock()
    expect(await unlock(recoveryKey, next!)).toBe(true)
    expect(await resetPassphrase('not it at all', 'third passphrase', next!)).toBeNull()
  })

  it('refuses to work while locked, and refuses tampered data', async () => {
    await createVault('correct horse battery', FAST)
    const data = await encryptText('secret')
    const bytes = Uint8Array.from(atob(data.slice(3)), (c) => c.charCodeAt(0))
    bytes[bytes.length - 1]! ^= 1
    const tampered = `v1:${btoa(String.fromCharCode(...bytes))}`
    await expect(decryptText(tampered)).rejects.toThrow(/damaged/)
    lock()
    await expect(decryptText(data)).rejects.toThrow(/locked/)
    await expect(encryptText('x')).rejects.toThrow(/locked/)
  })

  it('writes the recovery key as 13 groups of four and reads it back', () => {
    const bytes = Uint8Array.from({ length: 32 }, (_, i) => (i * 37) & 255)
    const code = toRecoveryCode(bytes)
    expect(code).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){12}[0-9A-HJKMNP-TV-Z]{4}$/)
    expect(fromRecoveryCode(code)).toEqual(bytes)
    expect(fromRecoveryCode('too short')).toBeNull()
  })
})

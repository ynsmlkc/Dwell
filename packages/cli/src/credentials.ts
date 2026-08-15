/**
 * Kimlik bilgisi saklama — `~/.dwell/credentials.json`.
 *
 * Icinde ne VAR: sunucu adresi, cihaz token'i, cuzdan adresi.
 * Icinde ne YOK: ozel anahtar. Hicbir zaman gormeyiz, hicbir zaman istemeyiz
 * (ADR-014). Kullanici imzayi cuzdaninda atar, biz imzalanmis sonucu goruruz.
 *
 * Dosya 0600, dizin 0700. Token calinirsa yapabilecegi tek sey gosterim
 * bildirmek ve bakiye okumaktir — cuzdan degistiremez (ADR-010 kapsamlar).
 * Yine de sinirlamak bedava.
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, chmodSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

export interface Credentials {
  readonly serverUrl: string
  readonly token: string
  /** Cuzdan adresi = publisherId. Ayni sey (ADR-010 revize). */
  readonly publisherId: string
  readonly tokenId: string
  readonly loggedInAt: number
}

export const credentialsPath = (): string =>
  process.env['DWELL_CREDENTIALS'] ?? join(homedir(), '.dwell', 'credentials.json')

export function loadCredentials(path = credentialsPath()): Credentials | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<Credentials>
    // Eksik alanli dosya YOK sayilir. Yarim bir kimlikle calismaktansa
    // "giris yapilmamis" demek dogru — kullanici `dwell login` calistirir.
    if (!raw.token || !raw.serverUrl || !raw.publisherId) return null
    return raw as Credentials
  } catch {
    return null
  }
}

export function saveCredentials(c: Credentials, path = credentialsPath()): void {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // Dizin zaten varsa `mkdir` mode'u UYGULAMAZ — ayrica chmod gerekiyor.
  try { chmodSync(dir, 0o700) } catch { /* Windows'ta anlamsiz */ }

  writeFileSync(path, JSON.stringify(c, null, 2) + '\n', { mode: 0o600 })
  try { chmodSync(path, 0o600) } catch { /* ayni */ }
}

export function clearCredentials(path = credentialsPath()): boolean {
  if (!existsSync(path)) return false
  rmSync(path, { force: true })
  return true
}

/** Adresi ekranda gosterilecek hale getirir: `GABC1234…WXYZ`. */
export const shortAddress = (a: string): string =>
  a.length > 16 ? `${a.slice(0, 8)}…${a.slice(-4)}` : a
